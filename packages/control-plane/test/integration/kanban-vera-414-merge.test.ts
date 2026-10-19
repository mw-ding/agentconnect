// Vera's #414 merge points on real Postgres: #194's sync apply, claim audit and ingest must keep #414's verify semantics.
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { FakeClock } from '../fakes/fake-clock.js'
import { PgKanbanDispatchRepo } from '../../src/persistence/repositories/kanban-dispatch.repo.js'
import { PgKanbanSyncRepo } from '../../src/persistence/repositories/kanban-sync.repo.js'
import { PgKanbanNotifyRepo } from '../../src/persistence/repositories/kanban-notify.repo.js'
import { KanbanNotifier } from '../../src/kanban/notifier-sender.js'
import { planLabelReconcile, type KanbanStatus } from '../../src/kanban/card-state.js'
import { planRunEnd, type KanbanRunEnd } from '../../src/kanban/run-accounting.js'
import type { KanbanClaimedLease } from '../../src/persistence/ports.js'

const D1 = 'd1414141-1414-4141-8141-141414141411'
const D2 = 'd1414141-1414-4141-8141-141414141412'
const A1 = 'a1414141-1414-4141-8141-141414141411'
const A2 = 'a1414141-1414-4141-8141-141414141412'
const T0 = Date.parse('2026-10-18T12:00:00.000Z')
const APPROVED = new Date(T0 - 60_000)

// Worker A1 and verifier A2 sit on separate daemons; the board has an anchor channel.
async function fixture() {
  await seedDaemon(prisma, D1)
  await seedDaemon(prisma, D2)
  await seedAgent(prisma, A1, { daemonId: D1 })
  await seedAgent(prisma, A2, { daemonId: D2 })
  const board = await prisma.kanbanBoard.create({
    data: {
      orgId: DEFAULT_ORG_ID,
      name: 'vera-414-merge',
      repoId: 414n,
      repoFullName: 'acme/web',
      maxInProgress: 10,
      maxInProgressPerAgent: 10,
      verifierAgentId: A2,
      completionContract: 'pr_merged',
      targetChannel: 'C0ANCHOR'
    }
  })
  let issue = 1
  const card = (status: KanbanStatus, data: Record<string, unknown> = {}) => {
    const n = issue++
    return prisma.kanbanCard.create({
      data: { boardId: board.id, issueId: BigInt(n), issueNumber: n, status, assigneeAgentId: A1, ...data }
    })
  }
  const dispatch = new PgKanbanDispatchRepo(prisma)
  const sync = new PgKanbanSyncRepo(prisma)
  const claim = async (): Promise<KanbanClaimedLease[]> =>
    (await dispatch.claim(board.id, { now: new Date(T0), isDaemonLive: () => true })).leases
  const read = (id: string) => prisma.kanbanCard.findUniqueOrThrow({ where: { id } })
  const rows = (cardId: string) =>
    prisma.kanbanNotification.findMany({ where: { cardId }, orderBy: { stateRevision: 'asc' } })
  const audits = async (cardId: string) =>
    (await prisma.auditEvent.findMany({ where: { kind: 'kanban_card_change' }, orderBy: { createdAt: 'asc' } }))
      .map((a) => a.details as Record<string, unknown>)
      .filter((d) => d.cardId === cardId)
  // A human status label lands through the live sync apply path.
  const humanMove = async (issueNumber: number, to: KanbanStatus, cursor: bigint, db = sync) => {
    const snapshot = (await db.get(board.id, issueNumber))!
    const plan = planLabelReconcile(
      { status: snapshot.status, leased: snapshot.lease !== null },
      { state: 'open', labels: [`ac/status:${to}`] }
    )
    expect(plan).toMatchObject({ outcome: 'accepted', status: to })
    return db.apply(snapshot, plan, cursor, true, 0n, { login: 'octocat', id: 1 })
  }
  const endRun = (leaseId: string, end: KanbanRunEnd) =>
    dispatch.endRun({
      leaseId,
      outcome: end.outcome,
      reasonCode: null,
      now: new Date(T0),
      plan: (c, b, ctx) => planRunEnd(c, b, end, new Date(T0), ctx)
    })
  return { board, card, dispatch, sync, claim, read, rows, audits, humanMove, endRun }
}

describe('vera-414-merge: verify semantics survive the #194 merge (Postgres)', () => {
  it('vera-414-merge: 1 a human review→blocked→ready→running→review clears verifiedAt and the card is verify-claimable again', async () => {
    const f = await fixture()
    // review→todo and todo→review are illegal in card-state.ts, so the legal human path back to review runs through running.
    const c = await f.card('review', { verifiedAt: APPROVED })
    const start = (await f.read(c.id)).stateRevision
    expect(await f.claim()).toEqual([])

    expect(await f.humanMove(c.issueNumber, 'blocked', 10n)).toMatchObject({ changed: true })
    expect(await f.read(c.id)).toMatchObject({ status: 'blocked', verifiedAt: null })
    expect(await f.rows(c.id)).toHaveLength(1)
    // No claim runs in between, so only human label moves bring the card back to review here (no work run clears it).
    expect(await f.humanMove(c.issueNumber, 'ready', 11n)).toMatchObject({ changed: true })
    expect(await f.humanMove(c.issueNumber, 'running', 12n)).toMatchObject({ changed: true })
    expect(await f.humanMove(c.issueNumber, 'review', 13n)).toMatchObject({ changed: true })

    expect(await f.read(c.id)).toMatchObject({ status: 'review', verifiedAt: null, stateRevision: start + 4n })
    // Exactly one outbox row per committed notifying move, each at the move's own revision; ready/running don't notify.
    expect(await f.rows(c.id)).toMatchObject([
      { stateRevision: start + 1n, fromStatus: 'review', toStatus: 'blocked' },
      { stateRevision: start + 4n, fromStatus: 'running', toStatus: 'review' }
    ])
    // The old approval no longer suppresses the next review: the verifier gets a fresh round.
    expect(await f.claim()).toMatchObject([{ cardId: c.id, role: 'verify', agentId: A2 }])
  })

  it('vera-414-merge: 1 a rolled-back human apply leaves the approval, the status and the outbox untouched', async () => {
    const f = await fixture()
    const c = await f.card('review', { verifiedAt: APPROVED })
    await expect(
      prisma.$transaction(async (tx) => {
        const result = await f.humanMove(c.issueNumber, 'blocked', 10n, new PgKanbanSyncRepo(tx))
        expect(result).toMatchObject({ changed: true })
        expect(await tx.kanbanCard.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ verifiedAt: null })
        expect(await tx.kanbanNotification.count({ where: { cardId: c.id } })).toBe(1)
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(await f.read(c.id)).toMatchObject({ status: 'review', verifiedAt: APPROVED })
    expect(await f.rows(c.id)).toEqual([])
    // The committed retry writes exactly one row, and the same stale snapshot replayed writes nothing more.
    const snapshot = (await f.sync.get(f.board.id, c.issueNumber))!
    expect(await f.humanMove(c.issueNumber, 'blocked', 10n)).toMatchObject({ changed: true })
    const plan = planLabelReconcile(
      { status: 'review', leased: false },
      { state: 'open', labels: ['ac/status:blocked'] }
    )
    expect(await f.sync.apply(snapshot, plan, 10n, true, 0n)).toBeNull()
    expect(await f.rows(c.id)).toHaveLength(1)
  })

  it('vera-414-merge: 1 a human move on a verify-leased review card revokes the verify lease and clears the stamp', async () => {
    const f = await fixture()
    const c = await f.card('review')
    const [lease] = await f.claim()
    expect(lease).toMatchObject({ role: 'verify', agentId: A2 })
    // A stale stamp under a live verify lease (defensive): the human move must still drop it.
    await prisma.kanbanCard.update({ where: { id: c.id }, data: { verifiedAt: APPROVED } })
    const result = await f.humanMove(c.issueNumber, 'blocked', 10n)
    expect(result).toMatchObject({ changed: true, revoked: { leaseId: lease!.leaseId, agentId: A2, daemonId: D2 } })
    expect(await prisma.kanbanRun.findUniqueOrThrow({ where: { id: lease!.runId } })).toMatchObject({
      outcome: 'reclaimed',
      reasonCode: 'human_status'
    })
    expect(await f.read(c.id)).toMatchObject({ status: 'blocked', verifiedAt: null })
  })

  it('vera-414-merge: 2 the claim skips a flagged ready or review card and leaves the flag set', async () => {
    const f = await fixture()
    const ready = await f.card('ready', { needsAttention: true, attentionReason: 'label_attribution_timeout' })
    const review = await f.card('review', { needsAttention: true, attentionReason: 'verifier_is_worker' })
    expect(await f.claim()).toEqual([])
    expect(await f.read(ready.id)).toMatchObject({ status: 'ready', needsAttention: true })
    expect(await f.read(review.id)).toMatchObject({ status: 'review', needsAttention: true })
    // The flag alone holds them: cleared, both claim (work to the assignee, verify to the verifier).
    await prisma.kanbanCard.updateMany({ where: { boardId: f.board.id }, data: { needsAttention: false } })
    expect((await f.claim()).map((l) => [l.cardId, l.role]).sort()).toEqual(
      [
        [ready.id, 'work'],
        [review.id, 'verify']
      ].sort()
    )
  })

  it('vera-414-merge: 3 the claim audits the real transition per role, and only a work claim owes a status label', async () => {
    const f = await fixture()
    const work = await f.card('ready')
    const verify = await f.card('review')
    const leases = await f.claim()
    const workLease = leases.find((l) => l.cardId === work.id)!
    const verifyLease = leases.find((l) => l.cardId === verify.id)!
    expect(workLease).toMatchObject({ role: 'work', agentId: A1 })
    expect(verifyLease).toMatchObject({ role: 'verify', agentId: A2 })

    expect(await f.audits(work.id)).toMatchObject([
      { from: 'ready', to: 'running', source: 'claim', role: 'work', leaseId: workLease.leaseId }
    ])
    expect(await f.audits(verify.id)).toMatchObject([
      { from: 'review', to: 'review', source: 'claim', role: 'verify', leaseId: verifyLease.leaseId }
    ])
    // A work claim moves the label to running; a verify claim leaves the review label exactly as it is.
    expect(await f.read(work.id)).toMatchObject({ status: 'running', labelWritePending: true })
    expect(await f.read(verify.id)).toMatchObject({ status: 'review', labelWritePending: false })
  })

  it('vera-414-merge: 3 a verify claim keeps a label write still owed from before, and a review→review run end owes none', async () => {
    const f = await fixture()
    const owed = await f.card('review', { labelWritePending: true })
    const clean = await f.card('review')
    const leases = await f.claim()
    expect(await f.read(owed.id)).toMatchObject({ labelWritePending: true })
    expect(await f.read(clean.id)).toMatchObject({ labelWritePending: false })
    // A pr_merged approval leaves the card in review with the stamp set: no status change, so no label write either.
    const approval = leases.find((l) => l.cardId === clean.id)!
    expect(await f.endRun(approval.leaseId, { outcome: 'completed' })).toMatchObject({ accepted: true })
    expect(await f.read(clean.id)).toMatchObject({ status: 'review', labelWritePending: false })
    expect((await f.read(clean.id)).verifiedAt).not.toBeNull()
    // A verifier's changes_requested does move the card (review→ready), so that end owes GitHub the new label.
    const sendBack = leases.find((l) => l.cardId === owed.id)!
    await prisma.kanbanCard.update({ where: { id: owed.id }, data: { labelWritePending: false } })
    expect(await f.endRun(sendBack.leaseId, { outcome: 'changes_requested' })).toMatchObject({ accepted: true })
    expect(await f.read(owed.id)).toMatchObject({ status: 'ready', labelWritePending: true })
  })

  it('vera-414-merge: 4 a parked human ingest keeps both sides: label write, audit, cleared stamp, and one outbox row', async () => {
    const f = await fixture()
    const c = await f.card('review', {
      verifiedAt: APPROVED,
      needsAttention: true,
      attentionReason: 'verifier_is_worker'
    })
    const before = await f.read(c.id)
    expect(await f.dispatch.ingestStatus(f.board.id, c.issueNumber, 'review', 'blocked')).toEqual({
      moved: true,
      cardId: c.id,
      stateRevision: before.stateRevision + 1n
    })
    expect(await f.read(c.id)).toMatchObject({
      status: 'blocked',
      labelWritePending: true,
      needsAttention: false,
      verifiedAt: null,
      stateRevision: before.stateRevision + 1n
    })
    expect(await f.audits(c.id)).toMatchObject([{ from: 'review', to: 'blocked', source: 'parked_ingest' }])
    expect(await f.rows(c.id)).toMatchObject([
      { stateRevision: before.stateRevision + 1n, fromStatus: 'review', toStatus: 'blocked', mention: false }
    ])
    // A replay of the same move is a CAS miss: nothing moves and no second row appears.
    expect(await f.dispatch.ingestStatus(f.board.id, c.issueNumber, 'review', 'blocked')).toEqual({ moved: false })
    expect(await f.rows(c.id)).toHaveLength(1)
  })

  it('vera-414-merge: 7 a parked human ingest out of review drops the approval stamp', async () => {
    const f = await fixture()
    const c = await f.card('review', {
      verifiedAt: APPROVED,
      needsAttention: true,
      attentionReason: 'verifier_is_worker'
    })
    expect(await f.dispatch.ingestStatus(f.board.id, c.issueNumber, 'review', 'ready')).toMatchObject({ moved: true })
    expect(await f.read(c.id)).toMatchObject({ status: 'ready', verifiedAt: null, needsAttention: false })
  })
})

describe('vera-414-merge: 8 a human re-ready keeps the review round count (Postgres)', () => {
  it('vera-414-merge: 8 neither human path resets reviewRounds after a round-limit trip', async () => {
    const f = await fixture()
    const live = await f.card('triage', { reviewRounds: 3 })
    const parked = await f.card('triage', {
      reviewRounds: 3,
      needsAttention: true,
      attentionReason: 'review_round_limit'
    })
    expect(await f.humanMove(live.issueNumber, 'ready', 10n)).toMatchObject({ changed: true })
    expect(await f.dispatch.ingestStatus(f.board.id, parked.issueNumber, 'triage', 'ready')).toMatchObject({
      moved: true
    })
    // Only an approval resets the count, so the next changes_requested trips straight back to triage (one more round).
    expect(await f.read(live.id)).toMatchObject({ status: 'ready', reviewRounds: 3 })
    expect(await f.read(parked.id)).toMatchObject({ status: 'ready', reviewRounds: 3, needsAttention: false })
  })
})

describe('vera-414-merge: 6 the outbox drain leaves rows for a daemon live on no connection here (Postgres)', () => {
  // The pending row posts through A1's daemon D1.
  async function outbox() {
    const f = await fixture()
    const botId = randomUUID()
    const integrationId = randomUUID()
    await prisma.bot.create({ data: { id: botId, orgId: DEFAULT_ORG_ID, platform: 'slack', name: `vera-${botId}` } })
    await prisma.integration.create({
      data: { id: integrationId, orgId: DEFAULT_ORG_ID, agentId: A1, botId, platform: 'slack', name: 'vera-414-merge' }
    })
    await prisma.kanbanBoard.update({ where: { id: f.board.id }, data: { targetIntegrationId: integrationId } })
    const c = await f.card('running')
    const notify = new PgKanbanNotifyRepo(prisma)
    await notify.enqueue({
      boardId: f.board.id,
      cardId: c.id,
      issueNumber: c.issueNumber,
      stateRevision: 1n,
      from: 'running',
      to: 'review',
      mention: false
    })
    return { f, notify, integrationId }
  }

  it('vera-414-merge: 6 a replica without the daemon never claims the row; the one holding it posts it once', async () => {
    const { f, integrationId } = await outbox()
    const clock = new FakeClock(T0)
    const posts: string[] = []
    const replica = (live: string[]) => {
      const repo = new PgKanbanNotifyRepo(prisma)
      const spy = { claim: vi.spyOn(repo, 'claim'), release: vi.spyOn(repo, 'release') }
      const notifier = new KanbanNotifier({
        repo,
        integration: { getUnscoped: async () => ({ id: integrationId, agentId: A1, status: 'active' }) as never },
        agent: { get: async () => ({ id: A1, daemonId: D1 }) as never },
        resolveMention: async () => null,
        liveDaemonIds: () => live,
        send: async (_daemonId, n) => {
          posts.push(n.notifyId)
          return { notifyId: n.notifyId, ok: true }
        },
        clock,
        log: { warn: vi.fn(), info: vi.fn() }
      })
      return { notifier, spy }
    }
    // Three drains on a replica that holds only D2: no claim lands, so nothing churns and the claim count stays 0.
    const elsewhere = replica([D2])
    for (let i = 0; i < 3; i++) await elsewhere.notifier.drain()
    expect(elsewhere.spy.release).not.toHaveBeenCalled()
    expect(posts).toEqual([])
    expect(await prisma.kanbanNotification.findFirstOrThrow({ where: { boardId: f.board.id } })).toMatchObject({
      claims: 0,
      attempts: 0,
      sentAt: null,
      claimedUntil: null
    })
    // The replica that holds D1 claims it at once and posts it exactly once.
    const holder = replica([D1])
    await holder.notifier.drain()
    expect(posts).toHaveLength(1)
    expect(await prisma.kanbanNotification.findFirstOrThrow({ where: { boardId: f.board.id } })).toMatchObject({
      claims: 1,
      attempts: 1
    })
  })

  it('vera-414-merge: 6 rows that resolve to no live-able daemon are still claimed, so they settle instead of sitting', async () => {
    const { f, notify } = await outbox()
    const at = new Date(T0)
    const lease = new Date(T0 + 60_000)
    expect(await notify.claim(10, at, lease, [], [])).toEqual([])
    // Headless board: claimable by any replica, which marks it sent without posting.
    await prisma.kanbanBoard.update({ where: { id: f.board.id }, data: { targetChannel: null } })
    const [headless] = await notify.claim(10, at, lease, [], [])
    expect(headless).toMatchObject({ boardId: f.board.id })
    await notify.release(headless!)
    // An unplaced agent or a revoked integration resolves to no daemon: any replica takes it to back off or give up.
    await prisma.kanbanBoard.update({ where: { id: f.board.id }, data: { targetChannel: 'C0ANCHOR' } })
    await prisma.agent.update({ where: { id: A1 }, data: { daemonId: null } })
    const [unplaced] = await notify.claim(10, at, lease, [], [])
    expect(unplaced).toMatchObject({ boardId: f.board.id })
  })
})

describe('vera-414-merge2: attribution timeout fences every open run (Postgres)', () => {
  it.each(['close', 'pr_merged'] as const)(
    'vera-414-merge2: %s refuses a verifier report after failClosed without lifting the human hold',
    async (completionContract) => {
      const f = await fixture()
      await prisma.kanbanBoard.update({ where: { id: f.board.id }, data: { completionContract } })
      const c = await f.card('review')
      const [lease] = await f.claim()
      expect(lease).toMatchObject({ role: 'verify', cardId: c.id })
      const snapshot = (await f.sync.get(f.board.id, c.issueNumber))!
      expect(await f.sync.failClosed(snapshot)).toMatchObject({
        status: 'review',
        revoked: { leaseId: lease!.leaseId, agentId: A2, daemonId: D2, dispatchRevision: lease!.dispatchRevision }
      })
      expect(await f.endRun(lease!.leaseId, { outcome: 'completed' })).toEqual({ accepted: false })
      expect(await f.read(c.id)).toMatchObject({
        status: 'review',
        needsAttention: true,
        attentionReason: 'label_attribution_timeout',
        verifiedAt: null,
        dispatchRevision: snapshot.dispatchRevision + 1n,
        stateRevision: snapshot.stateRevision,
        labelWritePending: true
      })
      expect(await prisma.kanbanRun.findUniqueOrThrow({ where: { id: lease!.runId } })).toMatchObject({
        endedAt: expect.any(Date),
        outcome: 'reclaimed',
        reasonCode: 'label_attribution_timeout'
      })
      expect(await f.claim()).toEqual([])
      expect(await f.rows(c.id)).toEqual([])
      // A same-status hold is not a status audit; the reclaimed run records why its lease ended.
      expect(await f.audits(c.id)).toMatchObject([{ source: 'claim', role: 'verify' }])
      expect(await f.audits(c.id)).toHaveLength(1)
      expect(await f.sync.failClosed(snapshot)).toBeNull()
    }
  )

  it('vera-414-merge2: a running work lease is still revoked and its report is fenced', async () => {
    const f = await fixture()
    const c = await f.card('ready')
    const [lease] = await f.claim()
    const snapshot = (await f.sync.get(f.board.id, c.issueNumber))!
    expect(await f.sync.failClosed(snapshot)).toMatchObject({
      status: 'triage',
      revoked: { leaseId: lease!.leaseId, agentId: A1, daemonId: D1 }
    })
    expect(await f.endRun(lease!.leaseId, { outcome: 'completed' })).toEqual({ accepted: false })
    expect(await f.read(c.id)).toMatchObject({
      status: 'triage',
      needsAttention: true,
      attentionReason: 'label_attribution_timeout',
      verifiedAt: null,
      stateRevision: snapshot.stateRevision + 1n,
      dispatchRevision: snapshot.dispatchRevision + 1n
    })
    expect(await f.audits(c.id)).toMatchObject([
      { source: 'claim' },
      { from: 'running', to: 'triage', source: 'label_attribution_timeout', leaseId: lease!.leaseId }
    ])
    expect(await f.rows(c.id)).toEqual([])
  })
})

describe('vera-414-merge2: timeout transaction and competing writers (Postgres)', () => {
  it('vera-414-merge2: a claim winning first invalidates the old timeout snapshot', async () => {
    const f = await fixture()
    const c = await f.card('review')
    const stale = (await f.sync.get(f.board.id, c.issueNumber))!
    const [lease] = await f.claim()
    expect(await f.sync.failClosed(stale)).toBeNull()
    expect(await f.read(c.id)).toMatchObject({ needsAttention: false })
    const current = (await f.sync.get(f.board.id, c.issueNumber))!
    expect(await f.sync.failClosed(current)).toMatchObject({ revoked: { leaseId: lease!.leaseId } })
    expect(await f.endRun(lease!.leaseId, { outcome: 'completed' })).toEqual({ accepted: false })
  })

  it('vera-414-merge2: a completed report winning first invalidates the old timeout snapshot', async () => {
    const f = await fixture()
    const c = await f.card('review')
    const [lease] = await f.claim()
    const stale = (await f.sync.get(f.board.id, c.issueNumber))!
    expect(await f.endRun(lease!.leaseId, { outcome: 'completed' })).toMatchObject({ accepted: true })
    expect(await f.sync.failClosed(stale)).toBeNull()
    expect(await f.read(c.id)).toMatchObject({ needsAttention: false, verifiedAt: new Date(T0) })
  })

  it('vera-414-merge2: a timeout winning first prevents a new verify claim without a status change', async () => {
    const f = await fixture()
    const c = await f.card('review')
    const snapshot = (await f.sync.get(f.board.id, c.issueNumber))!
    expect(await f.sync.failClosed(snapshot)).toEqual({ status: 'review', revoked: null })
    expect(await f.claim()).toEqual([])
    expect(await f.read(c.id)).toMatchObject({
      status: 'review',
      needsAttention: true,
      dispatchRevision: snapshot.dispatchRevision
    })
    expect(await f.rows(c.id)).toEqual([])
    expect(await f.audits(c.id)).toEqual([])
  })

  it('vera-414-merge2: rollback restores the verify lease and hold together with no outbox or audit leak', async () => {
    const f = await fixture()
    const c = await f.card('review')
    const [lease] = await f.claim()
    const snapshot = (await f.sync.get(f.board.id, c.issueNumber))!
    const before = await f.read(c.id)
    await expect(
      prisma.$transaction(async (tx) => {
        const result = await new PgKanbanSyncRepo(tx).failClosed(snapshot)
        expect(result).toMatchObject({ revoked: { leaseId: lease!.leaseId } })
        expect(await tx.kanbanRun.findUniqueOrThrow({ where: { id: lease!.runId } })).toMatchObject({
          outcome: 'reclaimed',
          reasonCode: 'label_attribution_timeout'
        })
        throw new Error('rollback timeout')
      })
    ).rejects.toThrow('rollback timeout')
    expect(await f.read(c.id)).toEqual(before)
    expect(await prisma.kanbanRun.findUniqueOrThrow({ where: { id: lease!.runId } })).toMatchObject({ endedAt: null })
    expect(await f.rows(c.id)).toEqual([])
    expect(await f.audits(c.id)).toHaveLength(1)
    expect(await f.endRun(lease!.leaseId, { outcome: 'completed' })).toMatchObject({ accepted: true })
  })
})

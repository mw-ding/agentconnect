// Verifier routing (M4) on real Postgres: review cards claim to the verifier, B8 refuses self-approval, changes_requested returns to the assignee.
import { describe, expect, it, vi } from 'vitest'
import type { KanbanDispatch, KanbanDispatchOk, KanbanReport } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { FakeClock } from '../fakes/fake-clock.js'
import { insertKanbanNotification, PgKanbanNotifyRepo } from '../../src/persistence/repositories/kanban-notify.repo.js'
import { PgKanbanDispatchRepo } from '../../src/persistence/repositories/kanban-dispatch.repo.js'
import { KanbanDispatcher } from '../../src/kanban/dispatcher.js'
import type {
  CardGraph,
  CardIssue,
  KanbanRepoRef,
  LabelEvent,
  LabelWriteObserver
} from '../../src/kanban/card-store.js'
import type { LabelPlan, ObservedIssue } from '../../src/kanban/card-state.js'
import { OrgId } from '../../src/domain/ids.js'

const D1 = 'd1111111-1111-4111-8111-111111111111'
const D2 = 'd2222222-2222-4222-8222-222222222222'
const A1 = 'a1111111-1111-4111-8111-111111111111'
const A2 = 'a2222222-2222-4222-8222-222222222222'
const REPO_ID = 987654321n
const T0 = Date.parse('2026-10-15T12:00:00.000Z')

class FakeStore {
  readonly writes: LabelPlan[] = []
  readonly issues = new Map<number, { labels: string[]; state: 'open' | 'closed'; stateReason: string | null }>()
  async readCard(_repo: KanbanRepoRef, n: number): Promise<CardIssue | null> {
    const i = this.issues.get(n)
    return i ? { issueId: BigInt(n), nodeId: `I_${n}`, number: n, ...i, labels: [...i.labels] } : null
  }
  async applyPlan(
    _repo: KanbanRepoRef,
    n: number,
    _observed: ObservedIssue,
    plan: LabelPlan,
    onLabelAdded?: LabelWriteObserver
  ): Promise<void> {
    this.writes.push(plan)
    const i = this.issues.get(n)!
    i.labels = [...i.labels.filter((l) => !plan.removeLabels.includes(l)), ...plan.addLabels]
    if (plan.issueState) {
      i.state = plan.issueState.state
      i.stateReason = plan.issueState.state === 'closed' ? plan.issueState.reason : null
    }
    for (const label of plan.addLabels) await onLabelAdded?.(label)
  }
  async readLabelEvents(): Promise<LabelEvent[]> {
    return []
  }
  async readGraph(): Promise<CardGraph> {
    return { parent: null, subIssues: [], blockedBy: [], blocking: [], truncated: false }
  }
  async statusSetByHuman(): Promise<boolean> {
    return true
  }
  async promotionVerdict(): Promise<'inconclusive'> {
    return 'inconclusive'
  }
}

async function harness(
  opts: { verifier?: string | null; reply?: (d: KanbanDispatch) => KanbanDispatchOk | Promise<KanbanDispatchOk> } = {}
) {
  await seedDaemon(prisma, D1, { sessionEpoch: 4n })
  await seedDaemon(prisma, D2, { sessionEpoch: 2n })
  await seedAgent(prisma, A1, { daemonId: D1 })
  await seedAgent(prisma, A2, { daemonId: D2 })
  const board = await prisma.kanbanBoard.create({
    data: {
      orgId: DEFAULT_ORG_ID,
      name: 'eng',
      repoId: REPO_ID,
      repoFullName: 'acme/web',
      maxInProgress: 10,
      maxInProgressPerAgent: 10,
      verifierAgentId: opts.verifier === undefined ? A2 : opts.verifier
    }
  })
  const clock = new FakeClock(T0)
  const store = new FakeStore()
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() }
  const sent: Array<{ daemonId: string; d: KanbanDispatch }> = []
  const repo = new PgKanbanDispatchRepo(prisma)
  vi.spyOn(repo, 'now').mockImplementation(async () => new Date(clock.now()))
  const dispatcher = new KanbanDispatcher({
    repo,
    installations: {
      liveByOrgAndAccount: async (orgId, login) =>
        orgId === OrgId(DEFAULT_ORG_ID) && login === 'acme'
          ? ({
              id: 'inst',
              orgId,
              installationId: 77n,
              accountLogin: 'acme',
              revokedAt: null,
              suspendedAt: null,
              createdAt: new Date(T0)
            } as never)
          : null
    },
    store,
    send: async (daemonId, d) => {
      sent.push({ daemonId, d })
      return opts.reply ? opts.reply(d) : { leaseId: d.leaseId, accepted: true }
    },
    isDaemonLive: () => true,
    clock,
    log
  })
  let issue = 1
  const addCard = async (labels: string[] = ['ac/status:ready']) => {
    const n = issue++
    store.issues.set(n, { labels, state: 'open', stateReason: null })
    return prisma.kanbanCard.create({
      data: { boardId: board.id, issueId: BigInt(n), issueNumber: n, status: 'ready', assigneeAgentId: A1 }
    })
  }
  const reviewCard = async (labels: string[] = ['ac/status:review']) => {
    const n = issue++
    store.issues.set(n, { labels, state: 'open', stateReason: null })
    return prisma.kanbanCard.create({
      data: { boardId: board.id, issueId: BigInt(n), issueNumber: n, status: 'review', assigneeAgentId: A1 }
    })
  }
  const reportFor = (d: KanbanDispatch, patch: Partial<KanbanReport> = {}): KanbanReport => ({
    boardId: d.boardId,
    cardId: d.cardId,
    agentId: d.agentId,
    leaseId: d.leaseId,
    attempt: d.attempt,
    dispatchRevision: d.dispatchRevision,
    outcome: 'completed',
    ...patch
  })
  const card = (id: string) => prisma.kanbanCard.findUniqueOrThrow({ where: { id } })
  const run = (leaseId: string) => prisma.kanbanRun.findUniqueOrThrow({ where: { leaseId } })
  return { board, clock, store, log, sent, repo, dispatcher, addCard, reviewCard, reportFor, card, run }
}

describe('Kanban verifier routing (real Postgres)', () => {
  it('claims a review card to the verifier as a read verify run, leaving the card in review', async () => {
    const h = await harness()
    const c = await h.reviewCard()
    const result = await h.repo.claim(h.board.id, { now: new Date(T0), isDaemonLive: () => true })
    expect(result.leases).toHaveLength(1)
    const lease = result.leases[0]!
    expect(lease).toMatchObject({ cardId: c.id, agentId: A2, daemonId: D2, role: 'verify', mode: 'read' })
    expect((await h.card(c.id)).status).toBe('review')
    expect(await h.run(lease.leaseId)).toMatchObject({ role: 'verify', mode: 'read', agentId: A2 })
  })

  it('a ready card still claims to its assignee as a work run', async () => {
    const h = await harness()
    const c = await h.addCard()
    const result = await h.repo.claim(h.board.id, { now: new Date(T0), isDaemonLive: () => true })
    expect(result.leases[0]).toMatchObject({ cardId: c.id, agentId: A1, role: 'work', mode: 'read' })
    expect((await h.card(c.id)).status).toBe('running')
  })

  it('shares the board cap between verify and work runs', async () => {
    const h = await harness()
    await prisma.kanbanBoard.update({ where: { id: h.board.id }, data: { maxInProgress: 1 } })
    await h.reviewCard()
    await h.addCard()
    const first = await h.repo.claim(h.board.id, { now: new Date(T0), isDaemonLive: () => true })
    expect(first.leases).toHaveLength(1)
    const second = await h.repo.claim(h.board.id, { now: new Date(T0), isDaemonLive: () => true })
    expect(second.leases).toHaveLength(0)
  })

  it('leaves a review card unclaimed when the board has no verifier', async () => {
    const h = await harness({ verifier: null })
    await h.reviewCard()
    expect((await h.repo.claim(h.board.id, { now: new Date(T0), isDaemonLive: () => true })).leases).toEqual([])
  })

  it('B8 refuses self-approval: no run row, flagged, and one body-free comment', async () => {
    const h = await harness({ verifier: A1 })
    const c = await h.reviewCard()
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    expect(h.sent).toEqual([])
    expect(await prisma.kanbanRun.count({ where: { cardId: c.id } })).toBe(0)
    expect(await h.card(c.id)).toMatchObject({
      status: 'review',
      needsAttention: true,
      attentionReason: 'verifier_is_worker'
    })
    const comments = h.store.writes.filter((w) => w.comment)
    expect(comments).toHaveLength(1)
    expect(comments[0]).toMatchObject({ addLabels: [], removeLabels: [] })
    expect(comments[0]!.comment).toContain('verifier')
    // A second reconcile does not re-flag or re-comment.
    const writes = h.store.writes.length
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    expect(h.store.writes).toHaveLength(writes)
    expect(await prisma.kanbanRun.count({ where: { cardId: c.id } })).toBe(0)
  })

  it('changes_requested returns the card to ready for the original assignee and re-dispatches as work', async () => {
    const h = await harness()
    const c = await h.reviewCard()
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    expect(h.sent).toHaveLength(1)
    const verify = h.sent[0]!.d
    expect(verify).toMatchObject({ cardId: c.id, agentId: A2, role: 'verify' })

    expect(await h.dispatcher.onReport(D2, 2, h.reportFor(verify, { outcome: 'changes_requested' }))).toEqual({
      leaseId: verify.leaseId,
      accepted: true
    })
    // The report's poke re-claims the now-ready card for the original assignee as a work run.
    await h.dispatcher.settle()
    const redispatch = h.sent.at(-1)!.d
    expect(redispatch).toMatchObject({ cardId: c.id, agentId: A1, attempt: 2 })
    expect(redispatch.role).toBeUndefined()
    expect(await h.card(c.id)).toMatchObject({
      status: 'running',
      assigneeAgentId: A1,
      reviewRounds: 1,
      consecutiveFailures: 0
    })
    expect(await h.run(redispatch.leaseId)).toMatchObject({ role: 'work', agentId: A1 })
  })

  it('replays a changes_requested report idempotently without counting another round', async () => {
    const h = await harness()
    const c = await h.reviewCard()
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    const verify = h.sent[0]!.d
    const report = h.reportFor(verify, { outcome: 'changes_requested', reasonCode: 'agent_changes' })
    expect(await h.dispatcher.onReport(D2, 2, report)).toEqual({ leaseId: verify.leaseId, accepted: true })
    await h.dispatcher.settle()
    expect(await h.card(c.id)).toMatchObject({ reviewRounds: 1 })
    expect(await h.dispatcher.onReport(D2, 2, report)).toEqual({ leaseId: verify.leaseId, accepted: true })
    await h.dispatcher.settle()
    expect(await h.card(c.id)).toMatchObject({ reviewRounds: 1 })
  })

  it('a verifier approving on the close contract finishes the card and resets the round', async () => {
    const h = await harness()
    const c = await h.reviewCard()
    await prisma.kanbanCard.update({ where: { id: c.id }, data: { reviewRounds: 2 } })
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    const verify = h.sent[0]!.d
    expect(await h.dispatcher.onReport(D2, 2, h.reportFor(verify, { outcome: 'completed' }))).toEqual({
      leaseId: verify.leaseId,
      accepted: true
    })
    await h.dispatcher.settle()
    expect(await h.card(c.id)).toMatchObject({ status: 'done', reviewRounds: 0, verifiedAt: null })
  })
})

describe('Kanban transition outbox (real Postgres)', () => {
  const rows = (cardId: string) =>
    prisma.kanbanNotification.findMany({ where: { cardId }, orderBy: { stateRevision: 'asc' } })

  it('commits one notification with the status change and not a second on a replayed report', async () => {
    const h = await harness()
    await prisma.kanbanBoard.update({ where: { id: h.board.id }, data: { targetChannel: 'C0ANCHOR' } })
    const c = await h.reviewCard()
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    const verify = h.sent[0]!.d
    const report = h.reportFor(verify, { outcome: 'changes_requested', reasonCode: 'agent_changes' })
    await h.dispatcher.onReport(D2, 2, report)
    await h.dispatcher.settle()
    await h.dispatcher.onReport(D2, 2, report)
    await h.dispatcher.settle()
    const sentRows = await rows(c.id)
    expect(sentRows).toHaveLength(1)
    expect(sentRows[0]).toMatchObject({
      issueNumber: c.issueNumber,
      fromStatus: 'review',
      toStatus: 'ready',
      mention: false,
      sentAt: null,
      attempts: 0
    })
  })

  it('records no row on a headless board', async () => {
    const h = await harness()
    const c = await h.reviewCard()
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    await h.dispatcher.onReport(D2, 2, h.reportFor(h.sent[0]!.d))
    await h.dispatcher.settle()
    expect(await rows(c.id)).toEqual([])
  })

  it('rolls the row back with its transaction and ignores a duplicate (cardId, stateRevision)', async () => {
    const h = await harness()
    const c = await h.reviewCard()
    const insert = (db: Parameters<typeof insertKanbanNotification>[0]) =>
      insertKanbanNotification(db, {
        boardId: h.board.id,
        cardId: c.id,
        issueNumber: c.issueNumber,
        stateRevision: 5n,
        from: 'running',
        to: 'blocked',
        blockKind: 'needs_input',
        mention: true
      })
    await expect(
      prisma.$transaction(async (tx) => {
        await insert(tx)
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(await rows(c.id)).toEqual([])
    await insert(prisma)
    await insert(prisma)
    expect(await rows(c.id)).toHaveLength(1)
  })

  it('never drains a row the notifier gave up on', async () => {
    const h = await harness()
    const c = await h.reviewCard()
    const notify = new PgKanbanNotifyRepo(prisma)
    await notify.enqueue({
      boardId: h.board.id,
      cardId: c.id,
      issueNumber: c.issueNumber,
      stateRevision: 9n,
      from: 'running',
      to: 'done',
      mention: false
    })
    const [pending] = await notify.pending(10, new Date(T0))
    expect(pending).toMatchObject({ from: 'running', to: 'done', attempts: 0 })
    await notify.markFailed(pending!.id, new Date(T0 + 60_000), 1, 'delivery_failed')
    expect(await notify.pending(10, new Date(T0))).toEqual([])
    expect(await notify.pending(10, new Date(T0 + 60_000))).toHaveLength(1)
    await notify.giveUp(pending!.id, 'delivery_failed')
    expect(await notify.pending(10, new Date(T0 + 3_600_000))).toEqual([])
  })
})

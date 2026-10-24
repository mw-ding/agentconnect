import { acknowledgeKanbanProjection } from '../fixtures/kanban-projection.js'
import { PgKanbanSyncRepo } from '../../src/persistence/repositories/kanban-sync.repo.js'
// Verifier routing (M4) on real Postgres: review cards claim to the verifier, B8 refuses self-approval, changes_requested returns to the assignee.
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { KanbanDispatch, KanbanDispatchOk, KanbanReport } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { FakeClock } from '../fakes/fake-clock.js'
import { insertKanbanNotification, PgKanbanNotifyRepo } from '../../src/persistence/repositories/kanban-notify.repo.js'
import { PgKanbanDispatchRepo } from '../../src/persistence/repositories/kanban-dispatch.repo.js'
import { PgKanbanCardRepo } from '../../src/persistence/repositories/kanban.repo.js'
import { KanbanDispatcher } from '../../src/kanban/dispatcher.js'
import { KanbanNotifier } from '../../src/kanban/notifier-sender.js'
import { KanbanPrContracts } from '../../src/kanban/pr-contracts.js'
import type { LivePullRequest } from '../../src/kanban/contracts.js'
import type { PrReader } from '../../src/kanban/pr-reader.js'
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
    const row = await prisma.kanbanCard.findFirst({ where: { issueNumber: n, board: { repoId: _repo.repoId } } })
    const sync = new PgKanbanSyncRepo(prisma)
    const snapshot = row ? await sync.get(row.boardId, n) : null
    this.writes.push(plan)
    const i = this.issues.get(n)!
    i.labels = [...i.labels.filter((l) => !plan.removeLabels.includes(l)), ...plan.addLabels]
    if (plan.issueState) {
      i.state = plan.issueState.state
      i.stateReason = plan.issueState.state === 'closed' ? plan.issueState.reason : null
    }
    for (const label of plan.addLabels) await onLabelAdded?.(label)
    if (snapshot && snapshot.status === plan.status) {
      await sync.ack(snapshot, snapshot.syncEventCursor, snapshot.syncAgentCursor)
    }
  }
  async readLabelEvents(_repo: KanbanRepoRef, n: number): Promise<LabelEvent[]> {
    return (this.issues.get(n)?.labels ?? []).map((name, i) => ({
      id: i + 1,
      event: 'labeled',
      label: { name },
      actor: { login: 'maintainer', type: 'User' }
    }))
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
  opts: {
    verifier?: string | null
    completionContract?: 'close' | 'pr_merged' | 'pr_checks_green'
    reply?: (d: KanbanDispatch) => KanbanDispatchOk | Promise<KanbanDispatchOk>
    prs?: PrReader
  } = {}
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
      verifierAgentId: opts.verifier === undefined ? A2 : opts.verifier,
      completionContract: opts.completionContract ?? 'close'
    }
  })
  const clock = new FakeClock(T0)
  const store = new FakeStore()
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() }
  const sent: Array<{ daemonId: string; d: KanbanDispatch }> = []
  const repo = new PgKanbanDispatchRepo(prisma)
  vi.spyOn(repo, 'now').mockImplementation(async () => new Date(clock.now()))
  const ingestStatus = repo.ingestStatus.bind(repo)
  vi.spyOn(repo, 'ingestStatus').mockImplementation(async (...args) => {
    const result = await ingestStatus(...args)
    if (result.moved) await acknowledgeKanbanProjection(result.cardId)
    return result
  })

  const project = { onStatusCommitted: vi.fn() }
  const repoRef = { installationId: 77n, repoId: REPO_ID, repoFullName: 'acme/web' }
  const contracts = opts.prs
    ? new KanbanPrContracts({
        appSlug: 'agentconnect',
        repo,
        prs: opts.prs,
        store,
        repoRef: async () => repoRef,
        log
      })
    : undefined
  const dispatcher = new KanbanDispatcher({
    project,
    ...(contracts
      ? {
          contracts: { sweep: (id: string) => contracts.sweep(id), onReview: (id: string) => contracts.onVerified(id) }
        }
      : {}),
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
    humanAuthz: { appSlug: 'agentconnect', permissions: { permission: async () => 'write' } },
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
  return {
    board,
    clock,
    store,
    log,
    sent,
    repo,
    dispatcher,
    project,
    contracts,
    addCard,
    reviewCard,
    reportFor,
    card,
    run
  }
}

// A merged PR bound to card `n` in every way but its creation time, which each test chooses.
function mergedCardPr(n: number, number: number, createdAt: Date): PrReader {
  const pr: LivePullRequest = {
    number,
    state: 'closed',
    merged: true,
    headSha: 'a'.repeat(40),
    authorLogin: 'agentconnect[bot]',
    authorType: 'Bot',
    headRef: `ac/card-${n}`,
    headRepoId: REPO_ID,
    baseRef: 'main',
    defaultBranch: 'main',
    createdAt,
    mergedByLogin: 'octocat'
  }
  return {
    readPullRequest: async (_repo, prNumber) => (prNumber === number ? pr : null),
    readCheckRuns: async () => ({ runs: [], complete: true })
  }
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

  it('vera-414: B8 refuses a verifier that wrote any earlier work attempt (runs [A2, A1], verifier A2)', async () => {
    const h = await harness({ verifier: A2 })
    const c = await h.reviewCard()
    for (const [attempt, agentId, daemonId] of [
      [1, A2, D2],
      [2, A1, D1]
    ] as const)
      await prisma.kanbanRun.create({
        data: {
          cardId: c.id,
          attempt,
          agentId,
          daemonId,
          role: 'work',
          leaseId: randomUUID(),
          dispatchRevision: BigInt(attempt),
          dispatchedAt: new Date(T0),
          endedAt: new Date(T0),
          outcome: 'completed'
        }
      })
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    expect(h.sent).toEqual([])
    expect(await prisma.kanbanRun.count({ where: { cardId: c.id, role: 'verify' } })).toBe(0)
    expect(await h.card(c.id)).toMatchObject({
      status: 'review',
      needsAttention: true,
      attentionReason: 'verifier_is_worker'
    })
    expect(h.store.writes.filter((w) => w.comment)).toHaveLength(1)
  })

  it('vera-414: a verifier edit alone keeps the B8 park; only the human status move lifts it', async () => {
    const h = await harness({ verifier: A1 })
    const c = await h.reviewCard()
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    expect(await h.card(c.id)).toMatchObject({ needsAttention: true, attentionReason: 'verifier_is_worker' })

    // The admin fixes the verifier: the card stays parked, undispatched, and flagged.
    await prisma.kanbanBoard.update({ where: { id: h.board.id }, data: { verifierAgentId: A2 } })
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    expect(h.sent).toEqual([])
    expect(await prisma.kanbanRun.count({ where: { cardId: c.id } })).toBe(0)
    expect(await h.card(c.id)).toMatchObject({
      status: 'review',
      needsAttention: true,
      attentionReason: 'verifier_is_worker'
    })

    // The documented human status move releases it: the flag clears and the card dispatches again.
    h.store.issues.get(c.issueNumber)!.labels = ['ac/status:ready']
    expect(await h.dispatcher.onCardChanged(h.board.id, c.issueNumber, 'human')).toBe(true)
    expect(await h.card(c.id)).toMatchObject({ status: 'ready', needsAttention: false, attentionReason: null })
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    expect(h.sent.map((s) => [s.d.cardId, s.d.agentId])).toEqual([[c.id, A1]])
  })

  it('416r3: a completed ready projection re-arms dispatch after pending-write claim exclusion', async () => {
    const h = await harness()
    const c = await h.reviewCard()
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    expect(h.sent).toHaveLength(1)
    const verify = h.sent[0]!.d
    expect(verify).toMatchObject({ cardId: c.id, agentId: A2, role: 'verify' })

    let enteredProjection!: () => void
    let releaseProjection!: () => void
    let enteredClaim!: () => void
    const projecting = new Promise<void>((resolve) => (enteredProjection = resolve))
    const projectionRelease = new Promise<void>((resolve) => (releaseProjection = resolve))
    const claimed = new Promise<void>((resolve) => (enteredClaim = resolve))
    const apply = h.store.applyPlan.bind(h.store)
    vi.spyOn(h.store, 'applyPlan').mockImplementationOnce(async (...args) => {
      enteredProjection()
      await projectionRelease
      return apply(...args)
    })
    const claim = h.repo.claim.bind(h.repo)
    vi.spyOn(h.repo, 'claim').mockImplementationOnce(async (...args) => {
      const result = await claim(...args)
      expect(result.leases).toEqual([])
      enteredClaim()
      return result
    })

    expect(await h.dispatcher.onReport(D2, 2, h.reportFor(verify, { outcome: 'changes_requested' }))).toEqual({
      leaseId: verify.leaseId,
      accepted: true
    })
    await projecting
    await claimed
    expect(h.sent).toHaveLength(1)
    expect(await h.card(c.id)).toMatchObject({ status: 'ready', labelWritePending: true })
    releaseProjection()
    // The first poke saw a pending projection; its completion must re-arm a second claim.
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

describe('Kanban verifier approval under a PR contract (real Postgres)', () => {
  const verifyRuns = (cardId: string) => prisma.kanbanRun.count({ where: { cardId, role: 'verify' } })
  const tick = async (h: Awaited<ReturnType<typeof harness>>) => {
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
  }

  it('vera-415b3: the first work claim stamps the episode on the DB clock; a rework claim keeps it', async () => {
    const h = await harness({ completionContract: 'pr_merged' })
    const c = await h.addCard()
    expect((await h.card(c.id)).workEpisodeStartedAt).toBeNull()
    await tick(h)
    expect((await h.run(h.sent[0]!.d.leaseId)).role).toBe('work')
    expect((await h.card(c.id)).workEpisodeStartedAt).toEqual(new Date(T0))
    await h.dispatcher.onReport(D1, 4, h.reportFor(h.sent[0]!.d, { outcome: 'review_requested' }))
    await h.dispatcher.settle()
    h.clock.advance(5 * 60_000)
    await h.dispatcher.onReport(D2, 2, h.reportFor(h.sent.at(-1)!.d, { outcome: 'changes_requested' }))
    await h.dispatcher.settle()
    const rework = h.sent.at(-1)!.d
    expect(rework).toMatchObject({ cardId: c.id, attempt: 3 })
    expect((await h.run(rework.leaseId)).dispatchedAt).toEqual(new Date(T0 + 5 * 60_000))
    expect((await h.card(c.id)).workEpisodeStartedAt).toEqual(new Date(T0))
  })

  it('vera-415: only a work run links its PR; a verifier cannot replace it or move the episode', async () => {
    const h = await harness({ completionContract: 'pr_merged' })
    const c = await h.addCard()
    await tick(h)
    const work = h.sent[0]!.d
    h.clock.advance(60_000)
    await h.dispatcher.onReport(D1, 4, h.reportFor(work, { outcome: 'review_requested', prNumber: 12 }))
    await h.dispatcher.settle()
    expect(await h.card(c.id)).toMatchObject({ linkedPrNumber: 12, workEpisodeStartedAt: new Date(T0) })
    const verify = h.sent.find(({ d }) => d.role === 'verify')!.d
    await h.dispatcher.onReport(D2, 2, h.reportFor(verify, { outcome: 'completed', prNumber: 99 }))
    await h.dispatcher.settle()
    expect(await h.card(c.id)).toMatchObject({
      linkedPrNumber: 12,
      workEpisodeStartedAt: new Date(T0),
      status: 'review'
    })
  })

  it('vera-415: an approved pr_merged card on this branch gets exactly one verify lease', async () => {
    const h = await harness({ completionContract: 'pr_merged' })
    const c = await h.reviewCard()
    await tick(h)
    const verify = h.sent[0]!.d
    await h.dispatcher.onReport(D2, 2, h.reportFor(verify, { outcome: 'completed' }))
    await h.dispatcher.settle()
    for (let i = 0; i < 3; i++) await tick(h)
    expect(await h.card(c.id)).toMatchObject({ status: 'review', verifiedAt: expect.any(Date) })
    expect(await verifyRuns(c.id)).toBe(1)
    expect(h.sent).toHaveLength(1)
  })

  it.each(['pr_merged', 'pr_checks_green'] as const)(
    'vera-414: an approval under %s dispatches exactly one verify run across ticks and reports',
    async (completionContract) => {
      const h = await harness({ completionContract })
      const c = await h.reviewCard()
      await tick(h)
      expect(h.sent).toHaveLength(1)
      const verify = h.sent[0]!.d
      expect(verify).toMatchObject({ cardId: c.id, agentId: A2, role: 'verify' })
      expect(await h.dispatcher.onReport(D2, 2, h.reportFor(verify, { outcome: 'completed' }))).toEqual({
        leaseId: verify.leaseId,
        accepted: true
      })
      await h.dispatcher.settle()
      // The report's poke, more ticks, and a replayed report must not mint another verify lease.
      for (let i = 0; i < 3; i++) {
        h.clock.advance(120_000)
        await tick(h)
      }
      await h.dispatcher.onReport(D2, 2, h.reportFor(verify, { outcome: 'completed' }))
      await tick(h)
      expect(h.sent).toHaveLength(1)
      expect(await verifyRuns(c.id)).toBe(1)
      expect(await prisma.kanbanRun.count({ where: { cardId: c.id, endedAt: null } })).toBe(0)
      const after = await h.card(c.id)
      expect(after.status).toBe('review')
      expect(after.verifiedAt).not.toBeNull()
    }
  )

  it.each(['completed', 'review_requested'] as const)(
    'vera-414: a new review round (changes_requested → ready → work %s → review) is verifiable again',
    async (workOutcome) => {
      const h = await harness({ completionContract: 'pr_merged' })
      const c = await h.reviewCard()
      await tick(h)
      const first = h.sent[0]!.d
      await h.dispatcher.onReport(D2, 2, h.reportFor(first, { outcome: 'changes_requested' }))
      await h.dispatcher.settle()
      const work = h.sent.at(-1)!.d
      expect(work).toMatchObject({ cardId: c.id, agentId: A1 })
      expect(work.role).toBeUndefined()
      await h.dispatcher.onReport(D1, 4, h.reportFor(work, { outcome: workOutcome }))
      await h.dispatcher.settle()
      // The worker's pass is a new round, so the card returns to the verifier with no approval stamp.
      const second = h.sent.at(-1)!.d
      expect(second).toMatchObject({ cardId: c.id, agentId: A2, role: 'verify', attempt: 3 })
      expect(await h.card(c.id)).toMatchObject({ verifiedAt: null, reviewRounds: 1 })
      await h.dispatcher.onReport(D2, 2, h.reportFor(second, { outcome: 'completed' }))
      await h.dispatcher.settle()
      await tick(h)
      expect(await verifyRuns(c.id)).toBe(2)
      expect(h.sent).toHaveLength(3)
      expect(await h.card(c.id)).toMatchObject({ status: 'review', reviewRounds: 0 })
      expect((await h.card(c.id)).verifiedAt).not.toBeNull()
    }
  )

  it('vera-414: a work claim clears a stale approval stamp, so its next review is verified again', async () => {
    const h = await harness({ completionContract: 'pr_merged' })
    const c = await h.addCard()
    await prisma.kanbanCard.update({ where: { id: c.id }, data: { verifiedAt: new Date(T0) } })
    const claimed = await h.repo.claim(h.board.id, { now: new Date(T0), isDaemonLive: () => true })
    expect(claimed.leases[0]).toMatchObject({ cardId: c.id, role: 'work' })
    expect(await h.card(c.id)).toMatchObject({ status: 'running', verifiedAt: null })
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
    const lease = (ms: number) => new Date(T0 + ms + 1000)
    const [pending] = await notify.claim(10, new Date(T0), lease(0))
    expect(pending).toMatchObject({ from: 'running', to: 'done', attempts: 0 })
    await notify.markFailed(pending!, new Date(T0 + 60_000), 1, 'delivery_failed')
    expect(await notify.claim(10, new Date(T0), lease(0))).toEqual([])
    const [retry] = await notify.claim(10, new Date(T0 + 60_000), lease(60_000))
    expect(retry).toMatchObject({ id: pending!.id, attempts: 1 })
    await notify.giveUp(retry!, 'delivery_failed')
    expect(await notify.claim(10, new Date(T0 + 3_600_000), lease(3_600_000))).toEqual([])
  })

  /** One pending row per new card on an anchored board, for the drain tests. */
  async function outbox(n: number) {
    const h = await harness()
    const botId = randomUUID()
    const integrationId = randomUUID()
    await prisma.bot.create({ data: { id: botId, orgId: DEFAULT_ORG_ID, platform: 'slack', name: `vera-${botId}` } })
    await prisma.integration.create({
      data: { id: integrationId, orgId: DEFAULT_ORG_ID, agentId: A1, botId, platform: 'slack', name: 'vera-414' }
    })
    await prisma.kanbanBoard.update({
      where: { id: h.board.id },
      data: { targetChannel: 'C0ANCHOR', targetIntegrationId: integrationId }
    })
    const notify = new PgKanbanNotifyRepo(prisma)
    for (let i = 0; i < n; i++) {
      const c = await h.reviewCard()
      await notify.enqueue({
        boardId: h.board.id,
        cardId: c.id,
        issueNumber: c.issueNumber,
        stateRevision: 1n,
        from: 'running',
        to: 'review',
        mention: false
      })
    }
    return { h, notify, integrationId }
  }

  it('vera-414: two notifiers on one outbox post each notifyId exactly once', async () => {
    const { h, integrationId } = await outbox(6)
    const posts: string[] = []
    const replica = () =>
      new KanbanNotifier({
        repo: new PgKanbanNotifyRepo(prisma),
        integration: { getUnscoped: async () => ({ id: integrationId, agentId: A1, status: 'active' }) as never },
        agent: { get: async () => ({ id: A1, daemonId: D1 }) as never },
        resolveMention: async () => null,
        liveDaemonIds: () => [D1],
        send: async (_daemonId, n) => {
          posts.push(n.notifyId)
          // Hold the send open so the other replica's pass overlaps this one.
          await new Promise((resolve) => setTimeout(resolve, 10))
          return { notifyId: n.notifyId, ok: true }
        },
        clock: h.clock,
        log: { warn: vi.fn(), info: vi.fn() }
      })
    await Promise.all([replica().drain(), replica().drain()])
    const ids = (await prisma.kanbanNotification.findMany({ where: { boardId: h.board.id } })).map((r) => r.id)
    expect(ids).toHaveLength(6)
    expect([...posts].sort()).toEqual([...ids].sort())
    expect(await prisma.kanbanNotification.count({ where: { boardId: h.board.id, sentAt: null } })).toBe(0)
  })

  it('vera-414: a claimed row is skipped until its lease lapses, and a stale claim cannot settle it', async () => {
    const { h, notify } = await outbox(1)
    const at = (ms: number) => new Date(T0 + ms)
    const [first] = await notify.claim(10, at(0), at(60_000))
    expect(first).toMatchObject({ attempts: 0, claims: 1 })
    expect(await notify.claim(10, at(30_000), at(90_000))).toEqual([])
    // The first holder crashed: once its lease lapses another replica takes the row under a new claim.
    const [second] = await notify.claim(10, at(60_000), at(120_000))
    expect(second).toMatchObject({ id: first!.id, claims: 2 })
    await notify.markSent(first!)
    await notify.markFailed(first!, at(0), 1, 'delivery_failed')
    await notify.giveUp(first!, 'delivery_failed')
    expect(await prisma.kanbanNotification.findUniqueOrThrow({ where: { id: first!.id } })).toMatchObject({
      sentAt: null,
      abandonedAt: null,
      attempts: 0,
      lastError: null
    })
    await notify.markSent(second!)
    expect((await prisma.kanbanNotification.findUniqueOrThrow({ where: { id: first!.id } })).sentAt).not.toBeNull()
    expect(await notify.claim(10, at(3_600_000), at(3_660_000))).toEqual([])
    expect(h.sent).toEqual([])
  })

  it('vera-414: a released row is claimable by another replica at once', async () => {
    const { notify } = await outbox(1)
    const [held] = await notify.claim(10, new Date(T0), new Date(T0 + 60_000))
    await notify.release(held!)
    const [next] = await notify.claim(10, new Date(T0), new Date(T0 + 60_000))
    expect(next).toMatchObject({ id: held!.id, claims: 2, attempts: 0 })
  })

  /** A B8-parked review card on an anchored board: parked, so a human status label is ingested. */
  async function parkedCard() {
    const h = await harness({ verifier: A1 })
    await prisma.kanbanBoard.update({ where: { id: h.board.id }, data: { targetChannel: 'C0ANCHOR' } })
    const c = await h.reviewCard()
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    expect(await h.card(c.id)).toMatchObject({ status: 'review', needsAttention: true })
    return { h, c }
  }

  it('vera-414: a label-driven move commits its notification with the status CAS', async () => {
    const { h, c } = await parkedCard()
    const before = await h.card(c.id)
    h.store.issues.get(c.issueNumber)!.labels = ['ac/status:blocked']
    // The harness dispatcher has no notifier wired: the row must come from the repo's own transaction.
    expect(await h.dispatcher.onCardChanged(h.board.id, c.issueNumber, 'human')).toBe(true)
    const after = await h.card(c.id)
    expect(after.status).toBe('blocked')
    expect(await rows(c.id)).toMatchObject([
      { stateRevision: before.stateRevision + 1n, fromStatus: 'review', toStatus: 'blocked', mention: false }
    ])
    expect(after.stateRevision).toBe(before.stateRevision + 1n)
  })

  it('vera-414: a rolled-back or missed ingest CAS leaves neither the move nor its notification', async () => {
    const { h, c } = await parkedCard()
    await expect(
      prisma.$transaction(async (tx) => {
        const moved = await new PgKanbanDispatchRepo(tx).ingestStatus(h.board.id, c.issueNumber, 'review', 'blocked')
        expect(moved).toMatchObject({ moved: true })
        expect(await tx.kanbanNotification.count({ where: { cardId: c.id } })).toBe(1)
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(await h.card(c.id)).toMatchObject({ status: 'review', needsAttention: true })
    expect(await rows(c.id)).toEqual([])
    // A CAS whose expected status is stale moves nothing and writes nothing.
    expect(await h.repo.ingestStatus(h.board.id, c.issueNumber, 'blocked', 'done')).toEqual({ moved: false })
    expect(await rows(c.id)).toEqual([])
    // The committed move writes exactly one row, and a replay of the same move is a no-op.
    expect(await h.repo.ingestStatus(h.board.id, c.issueNumber, 'review', 'blocked')).toMatchObject({ moved: true })
    expect(await h.repo.ingestStatus(h.board.id, c.issueNumber, 'review', 'blocked')).toEqual({ moved: false })
    expect(await rows(c.id)).toHaveLength(1)
  })

  it('vera-414: a headless board records no row for a label-driven move', async () => {
    const { h, c } = await parkedCard()
    await prisma.kanbanBoard.update({ where: { id: h.board.id }, data: { targetChannel: null } })
    expect(await h.repo.ingestStatus(h.board.id, c.issueNumber, 'review', 'blocked')).toMatchObject({ moved: true })
    expect(await rows(c.id)).toEqual([])
  })
})

it('vera-474 cutover: M4 review, changes-requested and round-limit commits each project once', async () => {
  const h = await harness()
  const c = await h.addCard()
  // Suppress report pokes so each committed transition can be asserted before the next claim.
  h.dispatcher.stop()
  for (let round = 1; round <= 3; round++) {
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    expect((await h.card(c.id)).status).toBe('running')
    h.project.onStatusCommitted.mockClear()
    const work = h.sent.at(-1)!.d
    await h.dispatcher.onReport(D1, 4, h.reportFor(work, { outcome: 'review_requested' }))
    await h.dispatcher.settle()
    expect((await h.card(c.id)).status).toBe('review')
    expect(h.project.onStatusCommitted).toHaveBeenCalledExactlyOnceWith({
      boardId: h.board.id,
      issueNumber: c.issueNumber
    })
    h.project.onStatusCommitted.mockClear()
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    const verify = h.sent.at(-1)!.d
    expect(verify.role).toBe('verify')
    expect(h.project.onStatusCommitted).not.toHaveBeenCalled()
    const report = h.reportFor(verify, { outcome: 'changes_requested' })
    await h.dispatcher.onReport(D2, 2, report)
    await h.dispatcher.settle()
    expect(await h.card(c.id)).toMatchObject({ status: round < 3 ? 'ready' : 'triage', consecutiveFailures: 0 })
    expect(h.project.onStatusCommitted).toHaveBeenCalledExactlyOnceWith({
      boardId: h.board.id,
      issueNumber: c.issueNumber
    })
    h.project.onStatusCommitted.mockClear()
    await h.dispatcher.onReport(D2, 2, report)
    await h.dispatcher.settle()
    expect(h.project.onStatusCommitted).not.toHaveBeenCalled()
  }
})

describe("vera-415b3: the PR binding follows the card's work episode (real Postgres)", () => {
  // Work 1 at T0 reports `prAt`'s PR 12; the verifier asks for changes; work 2 at T0+2min reports PR 12 again; approve.
  async function rework(prCreatedAt: (t0: number) => Date, reportSecondPr = true) {
    let issue = 0
    const prs: PrReader = {
      readPullRequest: (repo, n) => mergedCardPr(issue, 12, prCreatedAt(T0)).readPullRequest(repo, n),
      readCheckRuns: async () => ({ runs: [], complete: true })
    }
    const h = await harness({ completionContract: 'pr_merged', prs })
    const c = await h.addCard()
    issue = c.issueNumber
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    const work1 = h.sent[0]!.d
    h.clock.advance(30_000)
    await h.dispatcher.onReport(D1, 4, h.reportFor(work1, { outcome: 'review_requested', prNumber: 12 }))
    await h.dispatcher.settle()
    const verify1 = h.sent.at(-1)!.d
    expect(verify1).toMatchObject({ cardId: c.id, role: 'verify' })
    h.clock.advance(90_000)
    await h.dispatcher.onReport(D2, 2, h.reportFor(verify1, { outcome: 'changes_requested' }))
    await h.dispatcher.settle()
    const work2 = h.sent.at(-1)!.d
    expect(work2).toMatchObject({ cardId: c.id, agentId: A1, attempt: 3 })
    expect((await h.run(work2.leaseId)).dispatchedAt).toEqual(new Date(T0 + 120_000))
    h.clock.advance(30_000)
    await h.dispatcher.onReport(
      D1,
      4,
      h.reportFor(work2, { outcome: 'review_requested', ...(reportSecondPr ? { prNumber: 12 } : {}) })
    )
    await h.dispatcher.settle()
    const verify2 = h.sent.at(-1)!.d
    expect(verify2).toMatchObject({ cardId: c.id, role: 'verify', attempt: 4 })
    await h.dispatcher.onReport(D2, 2, h.reportFor(verify2, { outcome: 'completed' }))
    await h.dispatcher.settle()
    return { h, c }
  }

  it("vera-415b3: R2 work 2 re-reports work 1's PR after changes_requested, and approval completes the card", async () => {
    const { h, c } = await rework((t0) => new Date(t0 + 30_000))
    expect(await h.card(c.id)).toMatchObject({ status: 'done', linkedPrNumber: 12, needsAttention: false })
  })

  it('vera-415b3: R1 control: the PR reported by the first work run completes the card', async () => {
    let issue = 0
    const prs: PrReader = {
      readPullRequest: (repo, n) => mergedCardPr(issue, 12, new Date(T0 + 30_000)).readPullRequest(repo, n),
      readCheckRuns: async () => ({ runs: [], complete: true })
    }
    const h = await harness({ completionContract: 'pr_merged', prs })
    const c = await h.addCard()
    issue = c.issueNumber
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    h.clock.advance(60_000)
    await h.dispatcher.onReport(D1, 4, h.reportFor(h.sent[0]!.d, { outcome: 'review_requested', prNumber: 12 }))
    await h.dispatcher.settle()
    await h.dispatcher.onReport(D2, 2, h.reportFor(h.sent.at(-1)!.d, { outcome: 'completed' }))
    await h.dispatcher.settle()
    expect((await h.card(c.id)).status).toBe('done')
  })

  it("vera-415b3: a rework run that reports no PR keeps the episode's PR, which still completes the card", async () => {
    const { h, c } = await rework((t0) => new Date(t0 + 30_000), false)
    expect(await h.card(c.id)).toMatchObject({ status: 'done', linkedPrNumber: 12 })
  })

  it('vera-415b3: a PR created before the episode started never binds; the card is flagged once, before any verify', async () => {
    let issue = 0
    const prs: PrReader = {
      readPullRequest: (repo, n) => mergedCardPr(issue, 12, new Date(T0 - 1_000)).readPullRequest(repo, n),
      readCheckRuns: async () => ({ runs: [], complete: true })
    }
    const h = await harness({ completionContract: 'pr_merged', prs })
    const c = await h.addCard()
    issue = c.issueNumber
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    // A label-write poke racing the run end's re-check could claim a verify first (#600), so only explicit ticks claim.
    h.dispatcher.stop()
    h.clock.advance(30_000)
    await h.dispatcher.onReport(D1, 4, h.reportFor(h.sent[0]!.d, { outcome: 'review_requested', prNumber: 12 }))
    await h.dispatcher.settle()
    // The run end's own re-check raised the flag, before any tick could claim a verify.
    expect(await h.card(c.id)).toMatchObject({ needsAttention: true, contractFlags: ['pr_unbound#12'] })
    for (let i = 0; i < 3; i++) {
      await h.contracts!.sweep(h.board.id)
      await h.dispatcher.reconcileBoard(h.board.id)
      await h.dispatcher.settle()
    }
    expect(await h.card(c.id)).toMatchObject({
      status: 'review',
      needsAttention: true,
      attentionReason: 'pr_unbound',
      contractFlags: ['pr_unbound#12']
    })
    // A flagged card is a human's: no verify lease, and exactly one body-free comment.
    expect(h.sent.map((s) => s.d.role ?? 'work')).toEqual(['work'])
    expect(h.store.writes.filter((w) => w.comment?.includes('(pr_unbound)'))).toHaveLength(1)
  })
})

// A PR bound to card `n` (merged by a human unless the test says otherwise), its creation time chosen per test.
function cardPr(n: () => number, over: Partial<LivePullRequest> = {}, onRead?: () => Promise<void>): PrReader {
  return {
    readPullRequest: async (repo, prNumber) => {
      await onRead?.()
      const pr = await mergedCardPr(n(), 12, new Date(T0 + 30_000)).readPullRequest(repo, prNumber)
      return pr ? { ...pr, ...over } : null
    },
    readCheckRuns: async () => ({ runs: [], complete: true })
  }
}

describe('vera-415r2: a PR contract never settles through a human hold (real Postgres)', () => {
  // An approved review card bound to PR 12 at episode T0, optionally held; the board has a verifier (A2).
  async function held(
    attention: { reason: string; flags?: string[] } | null,
    over: Partial<LivePullRequest> = {},
    onRead?: (h: Awaited<ReturnType<typeof harness>>, cardId: string) => Promise<void>
  ) {
    let issue = 0
    const ctx: { current?: { h: Awaited<ReturnType<typeof harness>>; id: string } } = {}
    const prs = cardPr(
      () => issue,
      over,
      async () => {
        if (ctx.current) await onRead?.(ctx.current.h, ctx.current.id)
      }
    )
    const h = await harness({ completionContract: 'pr_merged', prs })
    const c = await h.reviewCard()
    issue = c.issueNumber
    const card = await prisma.kanbanCard.update({
      where: { id: c.id },
      data: {
        linkedPrNumber: 12,
        workEpisodeStartedAt: new Date(T0),
        verifiedAt: new Date(T0),
        ...(attention
          ? { needsAttention: true, attentionReason: attention.reason, contractFlags: attention.flags ?? [] }
          : {})
      }
    })
    ctx.current = { h, id: c.id }
    return { h, card }
  }
  const judge = async (h: Awaited<ReturnType<typeof harness>>, cardId: string) => {
    await h.contracts!.sweep(h.board.id)
    await h.contracts!.onVerified(cardId)
  }

  it('vera-415r3: B4 a leftover own flag never overrides a newer human hold', async () => {
    const { h, card } = await held({ reason: 'label_attribution_timeout', flags: ['pr_unbound#12'] })
    // Exercise the settlement CAS independently of the listing predicate.
    expect(
      await h.repo.settleContract({
        cardId: card.id,
        expectedStateRevision: card.stateRevision,
        expectedConfigRevision: h.board.configRevision,
        to: 'done',
        reason: 'pr_merged',
        prNumber: 12
      })
    ).toBe(false)
    expect(await h.contracts!.onVerified(card.id)).toBeNull()
    await judge(h, card.id)
    expect(await h.card(card.id)).toMatchObject({
      status: 'review',
      needsAttention: true,
      attentionReason: 'label_attribution_timeout',
      stateRevision: card.stateRevision
    })
    expect(h.store.writes).toEqual([])
  })

  it.each([
    ['label_attribution_timeout', [], {}],
    ['label_attribution_timeout', [], { merged: false }],
    ['verifier_is_worker', [], {}],
    // Another PR's contract flag is not this PR's: the hold stays a human's.
    ['pr_unbound', ['pr_unbound#11'], {}]
  ] as const)(
    'vera-415r2: B4 a card held for %s (flags %j, PR %j) stays held in review',
    async (reason, flags, over) => {
      const { h, card } = await held({ reason, flags: [...flags] }, over)
      await judge(h, card.id)
      expect(await h.card(card.id)).toMatchObject({
        status: 'review',
        needsAttention: true,
        attentionReason: reason,
        stateRevision: card.stateRevision
      })
      expect(h.store.writes).toEqual([])
    }
  )

  it.each(['pr_unbound', 'actions_read_missing', 'merged_by_app'])(
    "vera-415r2: B4 this PR's own %s flag still settles the card to done",
    async (reason) => {
      const { h, card } = await held({ reason, flags: [`${reason}#12`] })
      await judge(h, card.id)
      expect(await h.card(card.id)).toMatchObject({ status: 'done', needsAttention: false, attentionReason: null })
    }
  )

  it('vera-415r2: B4 a hold landing during the PR read (no revision bump) blocks the settle inside the CAS', async () => {
    const { h, card } = await held(null, {}, async (_h, id) => {
      // failClosed keeps a review card's status, so only the attention predicate can see this hold.
      await prisma.kanbanCard.update({
        where: { id },
        data: { needsAttention: true, attentionReason: 'label_attribution_timeout' }
      })
    })
    await h.contracts!.sweep(h.board.id)
    expect(await h.card(card.id)).toMatchObject({
      status: 'review',
      needsAttention: true,
      attentionReason: 'label_attribution_timeout'
    })
  })

  it('vera-415r2: 🟡1 a verifier added during the PR read fences the settle (configRevision)', async () => {
    let edited = false
    const { h, card } = await held(null, {}, async (h) => {
      if (edited) return
      edited = true
      await prisma.kanbanBoard.update({
        where: { id: h.board.id },
        data: { verifierAgentId: A2, configRevision: { increment: 1 } }
      })
    })
    await prisma.kanbanBoard.update({ where: { id: h.board.id }, data: { verifierAgentId: null } })
    await prisma.kanbanCard.update({ where: { id: card.id }, data: { verifiedAt: null } })
    await h.contracts!.sweep(h.board.id)
    expect(await h.card(card.id)).toMatchObject({ status: 'review', stateRevision: card.stateRevision })
    // The next judgement reads the new verifier and waits for its approval.
    await h.contracts!.sweep(h.board.id)
    expect((await h.card(card.id)).status).toBe('review')
  })

  it('vera-415r2: 🟡1 a board disabled during the PR read never settles the card', async () => {
    const { h, card } = await held(null, {}, async (h) => {
      await prisma.kanbanBoard.update({
        where: { id: h.board.id },
        data: { enabled: false, configRevision: { increment: 1 } }
      })
    })
    await h.contracts!.sweep(h.board.id)
    expect(await h.card(card.id)).toMatchObject({ status: 'review', stateRevision: card.stateRevision })
  })
})

describe('vera-415r2: B5 every path out of done ends the work episode (real Postgres)', () => {
  it("vera-415r2: B5 casStatus out of done clears the episode, so the old merged PR can't complete new work", async () => {
    let issue = 0
    // PR 12 was created after the OLD episode began but before the new one, and it merged long ago.
    const h = await harness({
      completionContract: 'pr_merged',
      prs: cardPr(() => issue, { createdAt: new Date(T0 - 30 * 60_000) })
    })
    const c = await h.addCard(['ac/status:done'])
    issue = c.issueNumber
    const done = await prisma.kanbanCard.update({
      where: { id: c.id },
      data: {
        status: 'done',
        linkedPrNumber: 12,
        workEpisodeStartedAt: new Date(T0 - 60 * 60_000),
        contractFlags: ['pr_unbound#11']
      }
    })
    const cards = new PgKanbanCardRepo(prisma)
    // The orchestrator's epic-budget fallback (orchestrator.ts moveEpicToTriage) goes through casStatus.
    expect(await cards.casStatus(c.id, done.stateRevision, 'triage')).toBe(true)
    expect(await h.card(c.id)).toMatchObject({
      status: 'triage',
      linkedPrNumber: null,
      workEpisodeStartedAt: null,
      contractFlags: []
    })
    // A human readies it; new work reports no PR; the verifier approves: the card waits, it never completes.
    expect(await cards.casStatus(c.id, (await h.card(c.id)).stateRevision, 'ready')).toBe(true)
    h.store.issues.set(c.issueNumber, { labels: ['ac/status:ready'], state: 'open', stateReason: null })
    await acknowledgeKanbanProjection(c.id)
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    const work = h.sent.at(-1)!.d
    expect(work.cardId).toBe(c.id)
    expect((await h.run(work.leaseId)).role).toBe('work')
    expect((await h.card(c.id)).workEpisodeStartedAt).toEqual(new Date(T0))
    await h.dispatcher.onReport(D1, 4, h.reportFor(work, { outcome: 'review_requested' }))
    await h.dispatcher.settle()
    await h.dispatcher.onReport(D2, 2, h.reportFor(h.sent.at(-1)!.d, { outcome: 'completed' }))
    await h.dispatcher.settle()
    await h.contracts!.sweep(h.board.id)
    expect(await h.card(c.id)).toMatchObject({ status: 'review', linkedPrNumber: null })
  })

  it('vera-415r2: B5 casStatus inside an episode keeps it', async () => {
    const h = await harness({ completionContract: 'pr_merged' })
    const c = await h.addCard()
    const blocked = await prisma.kanbanCard.update({
      where: { id: c.id },
      data: { status: 'blocked', linkedPrNumber: 12, workEpisodeStartedAt: new Date(T0), contractFlags: ['x#12'] }
    })
    expect(await new PgKanbanCardRepo(prisma).casStatus(c.id, blocked.stateRevision, 'todo')).toBe(true)
    expect(await h.card(c.id)).toMatchObject({
      status: 'todo',
      linkedPrNumber: 12,
      workEpisodeStartedAt: new Date(T0),
      contractFlags: ['x#12']
    })
  })
})

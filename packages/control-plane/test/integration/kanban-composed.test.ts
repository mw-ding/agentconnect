// Kanban composed like the container (#590): KanbanDispatcher({ sync }) + KanbanSync({ gate }) + controls on real Postgres, with a store that never fakes an ack.
import { describe, expect, it, vi } from 'vitest'
import type { KanbanDispatch, KanbanReport } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { FakeClock } from '../fakes/fake-clock.js'
import { PgKanbanDispatchRepo } from '../../src/persistence/repositories/kanban-dispatch.repo.js'
import { PgKanbanBoardRepo, PgKanbanCardRepo } from '../../src/persistence/repositories/kanban.repo.js'
import { PgKanbanSyncRepo } from '../../src/persistence/repositories/kanban-sync.repo.js'
import { KanbanDispatcher, RECHECK_HOLD_MS } from '../../src/kanban/dispatcher.js'
import { KanbanSync } from '../../src/kanban/sync.js'
import { KanbanControls } from '../../src/kanban/controls.js'
import { KanbanPrContracts } from '../../src/kanban/pr-contracts.js'
import type {
  CardGraph,
  CardIssue,
  KanbanRepoRef,
  LabelEvent,
  LabelWriteObserver
} from '../../src/kanban/card-store.js'
import type { LabelPlan, ObservedIssue } from '../../src/kanban/card-state.js'
import type { LivePullRequest } from '../../src/kanban/contracts.js'
import { OrgId } from '../../src/domain/ids.js'

const D1 = 'd1111111-1111-4111-8111-111111111111'
const D2 = 'd2222222-2222-4222-8222-222222222222'
const A1 = 'a1111111-1111-4111-8111-111111111111'
const A2 = 'a2222222-2222-4222-8222-222222222222'
const REPO_ID = 987654321n
const T0 = Date.parse('2026-10-15T12:00:00.000Z')
const APP_SLUG = 'agentconnect'
const ACTORS = {
  human: { type: 'User', login: 'maintainer' },
  app: { type: 'Bot', login: `${APP_SLUG}[bot]` }
} as const

// GitHub as the container sees it: label writes record App events, and nothing here touches the database.
class FakeGithub {
  readonly writes: LabelPlan[] = []
  readonly issues = new Map<number, { labels: string[]; state: 'open' | 'closed'; stateReason: string | null }>()
  readonly events = new Map<number, LabelEvent[]>()
  /** Posted comments; a keyed one is skipped when its key is already on the issue, as the label writer's marker scan does. */
  readonly comments: Array<{ n: number; body: string; key: string | null }> = []
  /** The next this-many label writes fail, as a GitHub outage would. */
  failWrites = 0
  /** The next this-many writes land in full and then throw, as a lost response would. */
  lostAcks = 0
  private eventId = 0

  open(n: number, labels: string[]): void {
    this.issues.set(n, { labels: [], state: 'open', stateReason: null })
    this.record(n, labels, [], 'human')
    this.issues.get(n)!.labels = [...labels]
  }
  private record(n: number, added: string[], removed: string[], actor: keyof typeof ACTORS): void {
    const events = this.events.get(n) ?? []
    for (const name of added)
      events.push({
        id: ++this.eventId,
        event: 'labeled',
        created_at: new Date(T0 + this.eventId * 1000).toISOString(),
        label: { name },
        actor: ACTORS[actor]
      })
    for (const name of removed)
      events.push({ id: ++this.eventId, event: 'unlabeled', label: { name }, actor: ACTORS[actor] })
    this.events.set(n, events)
  }
  async readCard(_repo: KanbanRepoRef, n: number): Promise<CardIssue | null> {
    const i = this.issues.get(n)
    return i ? { issueId: BigInt(n), nodeId: `I_${n}`, number: n, ...i, labels: [...i.labels] } : null
  }
  async readLabelEvents(_repo: KanbanRepoRef, n: number): Promise<LabelEvent[]> {
    return [...(this.events.get(n) ?? [])]
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
  async applyPlan(
    _repo: KanbanRepoRef,
    n: number,
    _observed: ObservedIssue,
    plan: LabelPlan,
    onLabelAdded?: LabelWriteObserver
  ): Promise<void> {
    if (this.failWrites > 0) {
      this.failWrites -= 1
      throw new Error('GitHub unavailable')
    }
    this.writes.push(plan)
    const i = this.issues.get(n)!
    const added = plan.addLabels.filter((l) => !i.labels.includes(l))
    const removed = plan.removeLabels.filter((l) => i.labels.includes(l))
    this.record(n, added, removed, 'app')
    for (const label of plan.addLabels) await onLabelAdded?.(label)
    i.labels = [...i.labels.filter((l) => !plan.removeLabels.includes(l)), ...plan.addLabels]
    if (plan.issueState) {
      i.state = plan.issueState.state
      i.stateReason = plan.issueState.state === 'closed' ? plan.issueState.reason : null
    }
    const key = plan.commentKey ?? null
    if (plan.comment && !(key && this.comments.some((c) => c.n === n && c.key === key)))
      this.comments.push({ n, body: plan.comment, key })
    if (this.lostAcks > 0) {
      this.lostAcks -= 1
      throw new Error('GitHub response lost')
    }
  }
}

// The read-only PR reader over a fixed set of PRs: head-branch lists for claims, single reads for contracts.
class FakePrs {
  readonly pulls: LivePullRequest[] = []
  lookups = 0
  /** The next this-many lookups fail, as a GitHub outage would. */
  failReads = 0
  /** Every PR read waits on this while it is set, as a slow GitHub read would. */
  held: Promise<void> | undefined
  /** The next this-many PR reads fail once released. */
  failPrReads = 0
  async readPullRequest(_repo: KanbanRepoRef, n: number): Promise<LivePullRequest | null> {
    await this.held
    if (this.failPrReads > 0) {
      this.failPrReads -= 1
      throw new Error('GitHub unavailable')
    }
    return this.pulls.find((pr) => pr.number === n) ?? null
  }
  async readCheckRuns(): Promise<{ runs: []; complete: true }> {
    return { runs: [], complete: true }
  }
  async listOpenPullRequestsByHead(_repo: KanbanRepoRef, headRef: string): Promise<LivePullRequest[]> {
    this.lookups += 1
    if (this.failReads > 0) {
      this.failReads -= 1
      throw new Error('GitHub unavailable')
    }
    return this.pulls.filter((pr) => pr.state === 'open' && pr.headRef === headRef)
  }
}

function cardPr(number: number, issueNumber: number, createdAt: number, patch: Partial<LivePullRequest> = {}) {
  return {
    number,
    state: 'open',
    merged: false,
    headSha: 'a'.repeat(40),
    authorLogin: `${APP_SLUG}[bot]`,
    authorType: 'Bot',
    headRef: `ac/card-${issueNumber}`,
    headRepoId: REPO_ID,
    baseRef: 'main',
    defaultBranch: null,
    createdAt: new Date(createdAt),
    mergedByLogin: null,
    ...patch
  } satisfies LivePullRequest
}

async function harness(opts: { verifier?: boolean; sync?: boolean; contract?: boolean } = {}) {
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
      maxInProgress: 5,
      maxInProgressPerAgent: 5,
      ...(opts.verifier ? { verifierAgentId: A2 } : {}),
      ...(opts.contract ? { completionContract: 'pr_merged' as const } : {})
    }
  })
  const clock = new FakeClock(T0)
  const github = new FakeGithub()
  const prs = new FakePrs()
  const warn = vi.fn()
  const log = { debug: vi.fn(), info: vi.fn(), warn }
  const sent: Array<{ daemonId: string; d: KanbanDispatch }> = []
  const repoRef: KanbanRepoRef = { installationId: 77n, repoId: REPO_ID, repoFullName: 'acme/web' }
  const installations = {
    liveByOrgAndAccount: async (orgId: OrgId, login: string) =>
      orgId === OrgId(DEFAULT_ORG_ID) && login === 'acme'
        ? ({
            id: 'inst-row',
            orgId,
            installationId: 77n,
            accountLogin: 'acme',
            revokedAt: null,
            suspendedAt: null,
            createdAt: new Date(T0)
          } as never)
        : null
  }
  const repo = new PgKanbanDispatchRepo(prisma)
  vi.spyOn(repo, 'now').mockImplementation(async () => new Date(clock.now()))
  // The container's wiring: the sync holds the dispatcher's per-card write queue, and the dispatcher projects through the sync.
  const sync =
    opts.sync === false
      ? undefined
      : new KanbanSync({
          gate: { holdStatusWrite: (cardId) => dispatcher.holdStatusWrite(cardId) },
          repo: new PgKanbanSyncRepo(prisma),
          cards: new PgKanbanCardRepo(prisma),
          store: github,
          permissions: { permission: async () => 'write' as const },
          appSlug: APP_SLUG,
          repoRef: async () => repoRef,
          revoke: async () => {},
          promote: async () => {},
          log,
          now: () => new Date(clock.now())
        })
  // The container's contract wiring: settles and flags hold the same per-card write queue.
  const contracts = opts.contract
    ? new KanbanPrContracts({
        appSlug: APP_SLUG,
        repo,
        prs,
        store: github,
        gate: { holdStatusWrite: (cardId) => dispatcher.holdStatusWrite(cardId) },
        repoRef: async () => repoRef,
        onSettled: (card) => dispatcher.poke(card.boardId),
        log
      })
    : undefined
  const dispatcher: KanbanDispatcher = new KanbanDispatcher({
    repo,
    ...(sync ? { sync } : {}),
    ...(contracts
      ? {
          contracts: {
            sweep: (boardId: string) => contracts.sweep(boardId),
            onReview: (cardId: string) => contracts.onVerified(cardId),
            onLeftReview: (cardId: string) => contracts.onLeftReview(cardId)
          }
        }
      : {}),
    installations,
    store: github,
    prs,
    humanAuthz: { appSlug: APP_SLUG, permissions: { permission: async () => 'write' as const } },
    send: async (daemonId, d) => {
      sent.push({ daemonId, d })
      return { leaseId: d.leaseId, accepted: true }
    },
    isDaemonLive: () => true,
    clock,
    log
  })
  const controls = new KanbanControls({
    boards: new PgKanbanBoardRepo(prisma),
    cards: new PgKanbanCardRepo(prisma),
    installations,
    store: github,
    resolveLogin: async () => 'maintainer',
    poke: (boardId) => dispatcher.poke(boardId),
    gate: dispatcher,
    log
  })
  let issue = 1
  const addCard = async (status: 'ready' | 'triage') => {
    const n = issue++
    github.open(n, [`ac/status:${status}`])
    const row = await prisma.kanbanCard.create({
      data: { boardId: board.id, issueId: BigInt(n), issueNumber: n, status, assigneeAgentId: A1 }
    })
    // The human's status label arrived through the sync, which consumed its event before any CP write.
    await sync?.onCardChanged(board.id, n)
    return row
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
  const labels = (n: number) => github.issues.get(n)!.labels.filter((l) => l.startsWith('ac/status:'))
  return { board, clock, github, prs, warn, sent, dispatcher, controls, addCard, reportFor, card, labels }
}

describe('590: Kanban composed like the container (real Postgres)', () => {
  it('a restart whose GitHub write failed stays unclaimed until a tick repairs it, then claims it', async () => {
    const h = await harness()
    const c = await h.addCard('triage')
    h.github.failWrites = 1
    const result = await h.controls.restart(DEFAULT_ORG_ID, h.board.id, c.id, DEFAULT_OWNER_ID)
    await h.dispatcher.settle()
    expect(result.ok).toBe(true)
    // Committed but not on GitHub: the restart's own poke must not claim a card whose issue still says triage.
    expect(await h.card(c.id)).toMatchObject({
      status: 'ready',
      labelWritePending: true,
      controlVersion: 1n,
      controlWrittenVersion: 0n
    })
    expect(h.labels(c.issueNumber)).toEqual(['ac/status:triage'])
    expect(h.sent).toEqual([])

    await h.dispatcher.tick()
    await h.dispatcher.settle()
    expect(h.sent.map(({ d }) => d.cardId)).toEqual([c.id])
    expect(await h.card(c.id)).toMatchObject({
      status: 'running',
      controlWrittenVersion: 1n,
      labelWritePending: false
    })
    expect(h.labels(c.issueNumber)).toEqual(['ac/status:running'])
  })

  it('a verifier send-back re-arms the card through the sync projection and the worker claims it again', async () => {
    const h = await harness({ verifier: true })
    const c = await h.addCard('ready')
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    const work = h.sent[0]!
    expect(work).toMatchObject({ daemonId: D1 })
    expect((await h.dispatcher.onReport(D1, 4, h.reportFor(work.d))).accepted).toBe(true)
    await h.dispatcher.settle()
    // review projected through the sync's queue, its ack re-armed the claim, and the verifier got the card.
    expect(h.sent.map(({ daemonId, d }) => [daemonId, d.role ?? 'work'])).toEqual([
      [D1, 'work'],
      [D2, 'verify']
    ])
    expect(h.labels(c.issueNumber)).toEqual(['ac/status:review'])
    const verify = h.sent[1]!
    expect((await h.dispatcher.onReport(D2, 2, h.reportFor(verify.d, { outcome: 'changes_requested' }))).accepted).toBe(
      true
    )
    await h.dispatcher.settle()
    expect(h.sent.map(({ daemonId, d }) => [daemonId, d.role ?? 'work'])).toEqual([
      [D1, 'work'],
      [D2, 'verify'],
      [D1, 'work']
    ])
    expect(await h.card(c.id)).toMatchObject({ status: 'running', labelWritePending: false })
    expect(h.labels(c.issueNumber)).toEqual(['ac/status:running'])
  })

  it('a dispatcher without a sync clears the label write it landed, so a send-back is claimed again', async () => {
    const h = await harness({ verifier: true, sync: false })
    const c = await h.addCard('ready')
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    expect((await h.dispatcher.onReport(D1, 4, h.reportFor(h.sent[0]!.d))).accepted).toBe(true)
    await h.dispatcher.settle()
    expect(h.sent).toHaveLength(2)
    await h.dispatcher.onReport(D2, 2, h.reportFor(h.sent[1]!.d, { outcome: 'changes_requested' }))
    await h.dispatcher.settle()
    expect(h.sent.map(({ d }) => d.role ?? 'work')).toEqual(['work', 'verify', 'work'])
    expect(await h.card(c.id)).toMatchObject({ status: 'running', labelWritePending: false })
  })
})

describe('598: a label-sync repair re-posts the control comment once (real Postgres)', () => {
  it('a restart whose write failed is repaired with its comment, and a repeated repair posts it once', async () => {
    const h = await harness()
    const c = await h.addCard('triage')
    h.github.failWrites = 1
    expect((await h.controls.restart(DEFAULT_ORG_ID, h.board.id, c.id, DEFAULT_OWNER_ID)).ok).toBe(true)
    await h.dispatcher.settle()
    expect(h.github.comments).toEqual([])

    // The first repair lands, comment included, but its response is lost, so the next tick repairs again.
    h.github.lostAcks = 1
    await h.dispatcher.tick()
    await h.dispatcher.settle()
    expect(await h.card(c.id)).toMatchObject({ status: 'ready', controlWrittenVersion: 0n })
    await h.dispatcher.tick()
    await h.dispatcher.settle()
    expect(await h.card(c.id)).toMatchObject({ status: 'running', controlWrittenVersion: 1n })
    expect(h.github.comments).toEqual([
      { n: c.issueNumber, body: 'restarted via AgentConnect', key: `control:${c.id}:1` }
    ])
  })

  it("a skip whose write failed is repaired with the actor's comment", async () => {
    const h = await harness()
    const c = await h.addCard('ready')
    h.github.failWrites = 1
    expect((await h.controls.skip(DEFAULT_ORG_ID, h.board.id, c.id, DEFAULT_OWNER_ID)).ok).toBe(true)
    await h.dispatcher.settle()
    expect(h.github.comments).toEqual([])

    await h.dispatcher.tick()
    await h.dispatcher.settle()
    expect(await h.card(c.id)).toMatchObject({ status: 'archived', controlWrittenVersion: 1n })
    expect(h.github.issues.get(c.issueNumber)).toMatchObject({ state: 'closed', stateReason: 'not_planned' })
    expect(h.github.comments).toEqual([
      { n: c.issueNumber, body: 'skipped by @maintainer via AgentConnect', key: `control:${c.id}:1` }
    ])
  })

  it('a control write that landed but lost its response is repaired without a second comment', async () => {
    const h = await harness()
    const c = await h.addCard('triage')
    h.github.lostAcks = 1
    expect((await h.controls.restart(DEFAULT_ORG_ID, h.board.id, c.id, DEFAULT_OWNER_ID)).ok).toBe(true)
    await h.dispatcher.settle()
    expect(await h.card(c.id)).toMatchObject({ controlWrittenVersion: 0n })

    await h.dispatcher.tick()
    await h.dispatcher.settle()
    expect(await h.card(c.id)).toMatchObject({ status: 'running', controlWrittenVersion: 1n })
    expect(h.github.comments).toEqual([
      { n: c.issueNumber, body: 'restarted via AgentConnect', key: `control:${c.id}:1` }
    ])
  })
})

describe('598: a write claim re-validates the open card-branch PR a restart dropped (real Postgres)', () => {
  async function restartedWithOpenPr() {
    const h = await harness()
    const c = await h.addCard('ready')
    await prisma.kanbanCard.update({ where: { id: c.id }, data: { mode: 'write' } })
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    expect(h.sent.map(({ d }) => d.attempt)).toEqual([1])
    // The revoked run opened #12 but never reported it, so the restart (no linked PR) names nothing; a fork's PR is not ours.
    h.prs.pulls.push(cardPr(11, c.issueNumber, T0 + 20_000, { headRepoId: REPO_ID + 1n }))
    h.prs.pulls.push(cardPr(12, c.issueNumber, T0 + 30_000))
    h.clock.advance(60_000)
    return { h, c }
  }

  it('a restart that could not name the open card-branch PR has the next write claim name it for closing', async () => {
    const { h, c } = await restartedWithOpenPr()
    expect((await h.controls.restart(DEFAULT_ORG_ID, h.board.id, c.id, DEFAULT_OWNER_ID)).ok).toBe(true)
    await h.dispatcher.settle()
    expect(h.sent.map(({ d }) => [d.attempt, d.supersededPrNumber])).toEqual([
      [1, undefined],
      [2, 12]
    ])
  })

  it('a restart during the head-branch lookup fences the old claim before sending its close target', async () => {
    const { h, c } = await restartedWithOpenPr()
    let enter!: () => void
    let resume!: () => void
    const entered = new Promise<void>((resolve) => (enter = resolve))
    const held = new Promise<void>((resolve) => (resume = resolve))
    const list = h.prs.listOpenPullRequestsByHead.bind(h.prs)
    vi.spyOn(h.prs, 'listOpenPullRequestsByHead').mockImplementationOnce(async (...args) => {
      enter()
      await held
      return list(...args)
    })
    try {
      expect((await h.controls.restart(DEFAULT_ORG_ID, h.board.id, c.id, DEFAULT_OWNER_ID)).ok).toBe(true)
      await entered
      h.clock.advance(1_000)
      expect((await h.controls.restart(DEFAULT_ORG_ID, h.board.id, c.id, DEFAULT_OWNER_ID)).ok).toBe(true)
    } finally {
      resume()
    }
    await h.dispatcher.settle()
    expect(h.sent.map(({ d }) => [d.attempt, d.supersededPrNumber])).toEqual([
      [1, undefined],
      [3, 12]
    ])
    expect(await prisma.kanbanRun.findFirstOrThrow({ where: { cardId: c.id, attempt: 2 } })).toMatchObject({
      outcome: 'reclaimed',
      reasonCode: 'restarted'
    })
  })

  it('a failed card-branch PR lookup ends the claim as transient, and the retry names the PR', async () => {
    const { h, c } = await restartedWithOpenPr()
    h.prs.failReads = 1
    expect((await h.controls.restart(DEFAULT_ORG_ID, h.board.id, c.id, DEFAULT_OWNER_ID)).ok).toBe(true)
    await h.dispatcher.settle()
    expect(h.sent).toHaveLength(1)
    const failed = await prisma.kanbanRun.findFirstOrThrow({ where: { cardId: c.id, attempt: 2 } })
    expect(failed).toMatchObject({ outcome: 'transient', reasonCode: 'github_read_failed' })
    expect(await h.card(c.id)).toMatchObject({ status: 'ready', consecutiveFailures: 0 })

    h.clock.advance(61_000)
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    expect(h.sent.map(({ d }) => [d.attempt, d.supersededPrNumber])).toEqual([
      [1, undefined],
      [3, 12]
    ])
  })

  it('an open card-branch PR the current episode opened is never named, since it can still bind', async () => {
    const h = await harness()
    const c = await h.addCard('ready')
    await prisma.kanbanCard.update({ where: { id: c.id }, data: { mode: 'write' } })
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    h.prs.pulls.push(cardPr(12, c.issueNumber, T0 + 30_000))
    const first = h.sent[0]!.d
    expect((await h.dispatcher.onReport(D1, 4, h.reportFor(first, { outcome: 'transient' }))).accepted).toBe(true)
    await h.dispatcher.settle()
    h.clock.advance(61_000)
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    expect(h.prs.lookups).toBe(1)
    expect(h.sent.map(({ d }) => [d.attempt, d.supersededPrNumber])).toEqual([
      [1, undefined],
      [2, undefined]
    ])
  })
})

describe("602: another sync's label ack cannot free a card before its run end's re-check flags it (real Postgres)", () => {
  const roles = (h: { sent: Array<{ d: KanbanDispatch }> }) => h.sent.map(({ d }) => d.role ?? 'work')
  const hold = (prs: FakePrs) => {
    let open!: () => void
    prs.held = new Promise<void>((resolve) => (open = resolve))
    return () => {
      prs.held = undefined
      open()
    }
  }
  // A human doorbell's sync projects the live status and acks it while the re-check's PR read is held, then a claim runs.
  async function doorbellThenClaim(h: Awaited<ReturnType<typeof harness>>, c: { id: string; issueNumber: number }) {
    await h.dispatcher.onCardChanged(h.board.id, c.issueNumber, 'human')
    expect(await h.card(c.id)).toMatchObject({ labelWritePending: false, needsAttention: false })
    await h.dispatcher.reconcileBoard(h.board.id)
  }

  it('602: a work run end into review is not claimed for verify while its re-check is pending', async () => {
    const h = await harness({ verifier: true, contract: true })
    const c = await h.addCard('ready')
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    // Created before the work episode, the PR is not this card's.
    h.prs.pulls.push(cardPr(12, c.issueNumber, T0 - 1_000, { defaultBranch: 'main' }))
    h.clock.advance(30_000)
    const release = hold(h.prs)
    await h.dispatcher.onReport(D1, 4, h.reportFor(h.sent[0]!.d, { outcome: 'review_requested', prNumber: 12 }))
    await doorbellThenClaim(h, c)
    expect(h.labels(c.issueNumber)).toEqual(['ac/status:review'])
    expect(roles(h)).toEqual(['work'])
    release()
    await h.dispatcher.settle()
    expect(await h.card(c.id)).toMatchObject({
      status: 'review',
      needsAttention: true,
      attentionReason: 'pr_unbound',
      contractFlags: ['pr_unbound#12']
    })
    for (let i = 0; i < 3; i++) {
      await h.dispatcher.tick()
      await h.dispatcher.settle()
    }
    expect(roles(h)).toEqual(['work'])
    expect(h.github.comments.filter((cm) => cm.body.includes('(pr_unbound)'))).toHaveLength(1)
  })

  it('602: a changes_requested verdict to ready is not claimed for rework while its re-check is pending', async () => {
    const h = await harness({ verifier: true, contract: true })
    const c = await h.addCard('ready')
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    const pr = cardPr(12, c.issueNumber, T0 + 1_000, { defaultBranch: 'main' })
    h.prs.pulls.push(pr)
    h.clock.advance(30_000)
    await h.dispatcher.onReport(D1, 4, h.reportFor(h.sent[0]!.d, { outcome: 'review_requested', prNumber: 12 }))
    await h.dispatcher.settle()
    // Bound at the work run's end, the card went to its verifier unflagged; then the PR was retargeted.
    expect(roles(h)).toEqual(['work', 'verify'])
    h.prs.pulls[0] = { ...pr, baseRef: 'release' }
    const release = hold(h.prs)
    await h.dispatcher.onReport(D2, 2, h.reportFor(h.sent[1]!.d, { outcome: 'changes_requested' }))
    await doorbellThenClaim(h, c)
    expect(h.labels(c.issueNumber)).toEqual(['ac/status:ready'])
    expect(roles(h)).toEqual(['work', 'verify'])
    release()
    await h.dispatcher.settle()
    expect(await h.card(c.id)).toMatchObject({
      status: 'ready',
      needsAttention: true,
      attentionReason: 'pr_unbound',
      contractFlags: ['pr_unbound#12']
    })
    for (let i = 0; i < 3; i++) {
      await h.dispatcher.tick()
      await h.dispatcher.settle()
    }
    expect(roles(h)).toEqual(['work', 'verify'])
    const flagged = h.github.comments.filter((cm) => cm.body.includes('(pr_unbound)'))
    expect(flagged).toHaveLength(1)
    expect(flagged[0]!.body).toContain('stays in `ac/status:ready`')
  })

  it('602: a failed re-check releases its hold and claims the card it skipped without waiting for a tick', async () => {
    const h = await harness({ verifier: true, contract: true })
    const c = await h.addCard('ready')
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    h.prs.pulls.push(cardPr(12, c.issueNumber, T0 + 1_000, { defaultBranch: 'main' }))
    h.clock.advance(30_000)
    const release = hold(h.prs)
    h.prs.failPrReads = 1
    await h.dispatcher.onReport(D1, 4, h.reportFor(h.sent[0]!.d, { outcome: 'review_requested', prNumber: 12 }))
    await doorbellThenClaim(h, c)
    expect(roles(h)).toEqual(['work'])
    release()
    await h.dispatcher.settle()
    // The re-check threw, so nothing flagged it; the claim it had skipped ran again once the hold lifted.
    expect(await h.card(c.id)).toMatchObject({ status: 'review', needsAttention: false })
    expect(roles(h)).toEqual(['work', 'verify'])
  })

  it('602: a claim skipped during a re-check that owes no label write is retried once the re-check settles', async () => {
    const h = await harness({ verifier: true, contract: true })
    const c = await h.addCard('ready')
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    h.prs.pulls.push(cardPr(12, c.issueNumber, T0 + 1_000, { defaultBranch: 'main' }))
    h.clock.advance(30_000)
    await h.dispatcher.onReport(D1, 4, h.reportFor(h.sent[0]!.d, { outcome: 'review_requested', prNumber: 12 }))
    await h.dispatcher.settle()
    expect(roles(h)).toEqual(['work', 'verify'])
    // Its heartbeat stale (the board default is 4h), the verify run is reclaimed review to review: no status write follows.
    h.clock.advance(4 * 60 * 60_000 + 60_000)
    const release = hold(h.prs)
    expect(await h.dispatcher.reap()).toBe(1)
    await h.dispatcher.reconcileBoard(h.board.id)
    expect(roles(h)).toEqual(['work', 'verify'])
    release()
    await h.dispatcher.settle()
    expect(roles(h)).toEqual(['work', 'verify', 'verify'])
  })

  it('602: a re-check still pending after the hold bound no longer blocks the claim', async () => {
    const h = await harness({ verifier: true, contract: true })
    const c = await h.addCard('ready')
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    h.prs.pulls.push(cardPr(12, c.issueNumber, T0 + 1_000, { defaultBranch: 'main' }))
    h.clock.advance(30_000)
    const release = hold(h.prs)
    await h.dispatcher.onReport(D1, 4, h.reportFor(h.sent[0]!.d, { outcome: 'review_requested', prNumber: 12 }))
    await doorbellThenClaim(h, c)
    expect(roles(h)).toEqual(['work'])
    h.clock.advance(RECHECK_HOLD_MS)
    await h.dispatcher.reconcileBoard(h.board.id)
    expect(roles(h)).toEqual(['work', 'verify'])
    release()
    await h.dispatcher.settle()
  })
})

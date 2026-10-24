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
import { KanbanDispatcher } from '../../src/kanban/dispatcher.js'
import { KanbanSync } from '../../src/kanban/sync.js'
import { KanbanControls } from '../../src/kanban/controls.js'
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
  /** The next this-many label writes fail, as a GitHub outage would. */
  failWrites = 0
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
  }
}

async function harness(opts: { verifier?: boolean; sync?: boolean } = {}) {
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
      ...(opts.verifier ? { verifierAgentId: A2 } : {})
    }
  })
  const clock = new FakeClock(T0)
  const github = new FakeGithub()
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
  const dispatcher: KanbanDispatcher = new KanbanDispatcher({
    repo,
    ...(sync ? { sync } : {}),
    installations,
    store: github,
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
  return { board, clock, github, warn, sent, dispatcher, controls, addCard, reportFor, card, labels }
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

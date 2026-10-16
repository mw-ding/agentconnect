// KanbanDispatcher (issue #2 M2) on real Postgres with a fake GitHub store and daemon link: dispatch, fencing, reaper, accounting.
import { describe, expect, it, vi } from 'vitest'
import type { KanbanDispatch, KanbanDispatchOk, KanbanReport } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { FakeClock } from '../fakes/fake-clock.js'
import { PgKanbanDispatchRepo } from '../../src/persistence/repositories/kanban-dispatch.repo.js'
import { KanbanDispatcher, WRITE_MODE_LABEL } from '../../src/kanban/dispatcher.js'
import {
  promotionAttributed,
  type CardGraph,
  type CardIssue,
  type KanbanRepoRef,
  type LabelEvent,
  type LabelWriteObserver
} from '../../src/kanban/card-store.js'
import type { LabelPlan, ObservedIssue } from '../../src/kanban/card-state.js'
import { PgKanbanBoardRepo, PgKanbanCardRepo } from '../../src/persistence/repositories/kanban.repo.js'
import { KanbanGraphDoorbell } from '../../src/kanban/graph-doorbell.js'
import { KanbanGraphReconciler } from '../../src/kanban/graph-reconciler.js'
import { OrgId } from '../../src/domain/ids.js'

const D1 = 'd1111111-1111-4111-8111-111111111111'
const D2 = 'd2222222-2222-4222-8222-222222222222'
const A1 = 'a1111111-1111-4111-8111-111111111111'
const REPO_ID = 987654321n
const T0 = Date.parse('2026-10-15T12:00:00.000Z')
const APP_SLUG = 'agentconnect'
/** Who GitHub's issue events name for a label write: a person, this App's bot (CP and agents alike), or another bot. */
const ACTORS = {
  human: { type: 'User', login: 'maintainer' },
  app: { type: 'Bot', login: `${APP_SLUG}[bot]` },
  other: { type: 'Bot', login: 'renovate[bot]' }
} as const

class FakeStore {
  readonly writes: LabelPlan[] = []
  readonly issues = new Map<number, { labels: string[]; state: 'open' | 'closed'; stateReason: string | null }>()
  /** Who last set each issue's status label; unset means a human. */
  readonly statusActors = new Map<number, 'human' | 'bot'>()
  /** The issue events API: label adds/removes with their actor, replayed by the real attribution check. */
  readonly events = new Map<number, LabelEvent[]>()
  readonly graphs = new Map<number, CardGraph>()
  readonly reads: number[] = []
  private eventId = 0
  async statusSetByHuman(_repo: KanbanRepoRef, n: number): Promise<boolean> {
    return (this.statusActors.get(n) ?? 'human') === 'human'
  }
  async promotionAttributed(_repo: KanbanRepoRef, n: number, readyAddedAt: Date | null): Promise<boolean | null> {
    return promotionAttributed(this.events.get(n) ?? [], APP_SLUG, readyAddedAt)
  }
  async readGraph(_repo: KanbanRepoRef, n: number): Promise<CardGraph> {
    return this.graphs.get(n) ?? emptyGraph()
  }
  /** Set an issue's labels as `actor`, recording the add-then-remove events GitHub would. */
  relabel(n: number, labels: string[], actor: keyof typeof ACTORS): void {
    const i = this.issues.get(n)!
    this.record(
      n,
      labels.filter((l) => !i.labels.includes(l)),
      i.labels.filter((l) => !labels.includes(l)),
      actor
    )
    i.labels = [...labels]
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
    for (const name of removed) {
      events.push({ id: ++this.eventId, event: 'unlabeled', label: { name }, actor: ACTORS[actor] })
    }
    this.events.set(n, events)
  }
  async readCard(_repo: KanbanRepoRef, n: number): Promise<CardIssue | null> {
    this.reads.push(n)
    const i = this.issues.get(n)
    return i
      ? {
          issueId: BigInt(n),
          nodeId: `I_${n}`,
          number: n,
          ...i,
          labels: [...i.labels]
        }
      : null
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
    this.record(n, plan.addLabels, plan.removeLabels, 'app')
    for (const label of plan.addLabels) {
      const event = [...this.events.get(n)!].reverse().find((e) => e.event === 'labeled' && e.label?.name === label)!
      onLabelAdded?.(label, new Date(event.created_at!))
    }
    i.labels = [...i.labels.filter((l) => !plan.removeLabels.includes(l)), ...plan.addLabels]
    if (plan.issueState) {
      i.state = plan.issueState.state
      i.stateReason = plan.issueState.state === 'closed' ? plan.issueState.reason : null
    }
  }
}

async function harness(opts: { reply?: (d: KanbanDispatch) => KanbanDispatchOk | Promise<KanbanDispatchOk> } = {}) {
  await seedDaemon(prisma, D1, { sessionEpoch: 4n })
  await seedDaemon(prisma, D2, { sessionEpoch: 1n })
  await seedAgent(prisma, A1, { daemonId: D1 })
  const board = await prisma.kanbanBoard.create({
    data: {
      orgId: DEFAULT_ORG_ID,
      name: 'eng',
      repoId: REPO_ID,
      repoFullName: 'acme/web',
      maxInProgress: 5,
      maxInProgressPerAgent: 5
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
              id: 'inst-row',
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
  const addCard = async (labels: string[] = ['ac/status:ready'], mode: 'read' | 'write' | null = null) => {
    const n = issue++
    store.issues.set(n, { labels, state: 'open', stateReason: null })
    return prisma.kanbanCard.create({
      data: { mode, boardId: board.id, issueId: BigInt(n), issueNumber: n, status: 'ready', assigneeAgentId: A1 }
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
  return { board, clock, store, graphs: store.graphs, log, sent, repo, dispatcher, addCard, reportFor, card, run }
}

describe('KanbanDispatcher — dispatch (real Postgres)', () => {
  it('sends a body-free lease, records the ack, and labels the card running', async () => {
    const h = await harness()
    const c = await h.addCard(['ac/status:ready', WRITE_MODE_LABEL, 'bug'], 'write')
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()

    expect(h.sent).toHaveLength(1)
    const { daemonId, d } = h.sent[0]!
    expect(daemonId).toBe(D1)
    expect(Object.keys(d).sort()).toEqual(
      [
        'agentId',
        'attempt',
        'boardId',
        'cardId',
        'dispatchRevision',
        'issueNumber',
        'leaseId',
        'mode',
        'repoFullName',
        'repoId',
        'sessionKeyPrefix'
      ].sort()
    )
    expect(d).toMatchObject({ cardId: c.id, agentId: A1, repoId: '987654321', mode: 'write', attempt: 1 })
    expect(await h.run(d.leaseId)).toMatchObject({ mode: 'write', ackedAt: new Date(T0) })
    expect((await h.card(c.id)).status).toBe('running')
    expect(h.store.issues.get(c.issueNumber)?.labels).toEqual([WRITE_MODE_LABEL, 'bug', 'ac/status:running'])
  })

  it('defaults to a read run without DB write configuration', async () => {
    const h = await harness()
    await h.addCard()
    await h.dispatcher.reconcileBoard(h.board.id)
    expect(h.sent[0]?.d.mode).toBe('read')
  })

  it('a completed report moves the card to done and closes the issue; a late duplicate is superseded', async () => {
    const h = await harness()
    const c = await h.addCard()
    await h.dispatcher.reconcileBoard(h.board.id)
    const d = h.sent[0]!.d
    expect(await h.dispatcher.onReport(D1, 4, h.reportFor(d))).toEqual({ leaseId: d.leaseId, accepted: true })
    await h.dispatcher.settle()
    expect((await h.card(c.id)).status).toBe('done')
    expect(h.store.issues.get(c.issueNumber)).toMatchObject({
      labels: ['ac/status:done'],
      state: 'closed',
      stateReason: 'completed'
    })
    expect(await h.dispatcher.onReport(D1, 4, h.reportFor(d, { outcome: 'failed' }))).toEqual({
      leaseId: d.leaseId,
      accepted: false,
      reason: 'superseded'
    })
    expect((await h.card(c.id)).consecutiveFailures).toBe(0)
  })

  it('rejects a report from a daemon that does not hold the lease', async () => {
    const h = await harness()
    await h.addCard()
    await h.dispatcher.reconcileBoard(h.board.id)
    const d = h.sent[0]!.d
    expect((await h.dispatcher.onReport(D2, 1, h.reportFor(d))).accepted).toBe(false)
  })

  it('a capability refusal routes the card to triage; a transient one cools down without counting', async () => {
    const h = await harness({
      reply: (d) => ({
        leaseId: d.leaseId,
        accepted: false,
        reason: d.mode === 'write' ? 'write_needs_worktree' : 'busy'
      })
    })
    const write = await h.addCard(['ac/status:ready', WRITE_MODE_LABEL], 'write')
    const read = await h.addCard()
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()

    expect(await h.card(write.id)).toMatchObject({ status: 'triage', blockKind: 'capability' })
    expect(h.store.issues.get(write.issueNumber)?.labels).toContain('ac/status:triage')
    const cooled = await h.card(read.id)
    expect(cooled).toMatchObject({ status: 'ready', consecutiveFailures: 0 })
    expect(cooled.cooldownUntil?.getTime()).toBeGreaterThan(T0)
    const runs = await prisma.kanbanRun.findMany({ orderBy: { reasonCode: 'asc' } })
    expect(runs.map((r) => r.reasonCode)).toEqual(['dispatch_refused:busy', 'dispatch_refused:write_needs_worktree'])

    // Cooling down: not re-claimed until the cooldown passes.
    await h.dispatcher.reconcileBoard(h.board.id)
    expect(h.sent).toHaveLength(2)
    h.clock.advance(61_000)
    await h.dispatcher.reconcileBoard(h.board.id)
    expect(h.sent).toHaveLength(3)
    expect(h.sent[2]?.d.attempt).toBe(2)
  })

  it('a dispatch that throws (nack or timeout) returns the card to ready with a cooldown', async () => {
    const h = await harness({
      reply: () => {
        throw new Error('ack timeout')
      }
    })
    const c = await h.addCard()
    await h.dispatcher.reconcileBoard(h.board.id)
    expect(await h.card(c.id)).toMatchObject({ status: 'ready', consecutiveFailures: 0 })
    expect((await prisma.kanbanRun.findFirstOrThrow()).reasonCode).toBe('dispatch_failed')
  })

  it.each([
    { labels: ['ac/status:blocked'], status: 'blocked' },
    { labels: ['ac/status:ready', 'ac/status:blocked'], status: 'triage' }
  ])('recovers a mismatch ($status) after a human ready transition', async ({ labels, status }) => {
    const h = await harness()
    const c = await h.addCard([...labels, 'human-label'])
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    expect(h.sent).toHaveLength(0)
    expect((await h.card(c.id)).status).toBe(status)
    expect(await prisma.kanbanRun.findFirstOrThrow()).toMatchObject({
      reasonCode: 'github_state_mismatch',
      endedAt: new Date(T0)
    })
    expect(await prisma.kanbanRun.count({ where: { endedAt: null } })).toBe(0)
    expect(h.store.writes).toEqual([])
    expect(h.store.issues.get(c.issueNumber)?.labels).toEqual([...labels, 'human-label'])
    h.store.issues.get(c.issueNumber)!.labels = ['ac/status:ready', 'human-label']
    await h.dispatcher.ingestCard(h.board.id, c.issueNumber)
    expect((await h.card(c.id)).status).toBe('ready')
    await h.dispatcher.tick()
    await h.dispatcher.settle()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.d).toMatchObject({ cardId: c.id, attempt: 2 })
    expect((await h.card(c.id)).status).toBe('running')
  })
})

describe('KanbanDispatcher — failure accounting through reports (real Postgres)', () => {
  it('two consecutive failures trip failureLimit and route to triage', async () => {
    const h = await harness()
    const c = await h.addCard()
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.onReport(D1, 4, h.reportFor(h.sent[0]!.d, { outcome: 'failed', reasonCode: 'turn_error' }))
    await h.dispatcher.settle()
    const first = await h.card(c.id)
    expect(first).toMatchObject({ status: 'ready', consecutiveFailures: 1 })

    h.clock.advance(61_000)
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.onReport(D1, 4, h.reportFor(h.sent[1]!.d, { outcome: 'failed' }))
    await h.dispatcher.settle()
    expect(await h.card(c.id)).toMatchObject({ status: 'triage', consecutiveFailures: 2 })
    expect(h.store.issues.get(c.issueNumber)?.labels).toEqual(['ac/status:triage'])
  })

  it('a block counts recurrence and parks the card in blocked', async () => {
    const h = await harness()
    const c = await h.addCard()
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.onReport(D1, 4, h.reportFor(h.sent[0]!.d, { outcome: 'blocked', blockKind: 'needs_input' }))
    expect(await h.card(c.id)).toMatchObject({ status: 'blocked', blockKind: 'needs_input', blockRecurrence: 1 })
  })
})

describe('KanbanDispatcher — stale lease reaper (real Postgres)', () => {
  async function leased(h: Awaited<ReturnType<typeof harness>>) {
    const c = await h.addCard()
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    return { c, d: h.sent.at(-1)!.d }
  }
  const beat = (d: KanbanDispatch) => [
    { leaseId: d.leaseId, cardId: d.cardId, dispatchRevision: d.dispatchRevision, liveness: 'turn' as const }
  ]

  it('keeps a beating lease and reclaims it once the heartbeat goes stale, counting no failure', async () => {
    const h = await harness()
    const { c, d } = await leased(h)
    h.clock.advance(3 * 60 * 60_000)
    expect(await h.dispatcher.onHeartbeat(D1, 4, beat(d))).toEqual([])
    h.clock.advance(3 * 60 * 60_000)
    expect(await h.dispatcher.reap()).toBe(0)

    h.clock.advance(4 * 60 * 60_000 + 1_000)
    expect(await h.dispatcher.reap()).toBe(1)
    await h.dispatcher.settle()
    expect(await h.card(c.id)).toMatchObject({ status: 'ready', consecutiveFailures: 0, cooldownUntil: null })
    expect(await h.run(d.leaseId)).toMatchObject({ outcome: 'reclaimed', reasonCode: 'reclaimed:stale_heartbeat' })
    expect(h.store.issues.get(c.issueNumber)?.labels).toEqual(['ac/status:ready'])

    // The superseded run is fenced out: its heartbeat is refused and its late report cannot land.
    expect(await h.dispatcher.onHeartbeat(D1, 4, beat(d))).toEqual([d.leaseId])
    expect((await h.dispatcher.onReport(D1, 4, h.reportFor(d))).accepted).toBe(false)
    expect((await h.card(c.id)).status).toBe('ready')
  })

  it('reclaims after a daemon epoch change unless the daemon re-asserts the lease', async () => {
    const h = await harness()
    const { d } = await leased(h)
    await prisma.daemon.update({ where: { id: D1 }, data: { sessionEpoch: 5n } })
    h.clock.advance(60_000)
    // A reconnect whose turn survived re-stamps the epoch with its first heartbeat.
    expect(await h.dispatcher.onHeartbeat(D1, 5, beat(d))).toEqual([])
    h.clock.advance(10 * 60_000)
    expect(await h.dispatcher.reap()).toBe(0)

    // A restart that lost the turn never beats again under the new epoch.
    await prisma.daemon.update({ where: { id: D1 }, data: { sessionEpoch: 6n } })
    h.clock.advance(4 * 60_000)
    expect(await h.dispatcher.reap()).toBe(1)
    expect((await h.run(d.leaseId)).reasonCode).toBe('reclaimed:epoch_changed')
  })

  it('reclaims when the agent moved off the leasing daemon', async () => {
    const h = await harness()
    const { d } = await leased(h)
    await prisma.agent.update({ where: { id: A1 }, data: { daemonId: D2 } })
    expect(await h.dispatcher.reap()).toBe(1)
    expect((await h.run(d.leaseId)).reasonCode).toBe('reclaimed:agent_moved')
  })

  it('reclaims an unacked dispatch quickly', async () => {
    const h = await harness({ reply: () => new Promise<KanbanDispatchOk>(() => {}) })
    await h.addCard()
    void h.dispatcher.reconcileBoard(h.board.id)
    await new Promise((r) => setTimeout(r, 200))
    h.clock.advance(3 * 60_000)
    expect(await h.dispatcher.reap()).toBe(1)
    expect((await prisma.kanbanRun.findFirstOrThrow()).reasonCode).toBe('reclaimed:dispatch_unacked')
  })

  it('a tick reaps first, so the reclaimed slot is claimed again in the same pass', async () => {
    const h = await harness()
    const { c, d } = await leased(h)
    h.clock.advance(4 * 60 * 60_000 + 1_000)
    await h.dispatcher.tick()
    await h.dispatcher.settle()
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1]?.d).toMatchObject({ cardId: c.id, attempt: 2 })
    expect(BigInt(h.sent[1]!.d.dispatchRevision)).toBeGreaterThan(BigInt(d.dispatchRevision))
  })
})

it('orders slow running-label writes before terminal labels and persists the linked PR', async () => {
  const h = await harness()
  const c = await h.addCard()
  let release!: () => void
  let entered!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const apply = h.store.applyPlan.bind(h.store)
  h.store.applyPlan = async (...args) => {
    if (args[3].addLabels.includes('ac/status:running')) {
      entered()
      await held
    }
    await apply(...args)
  }
  await h.dispatcher.reconcileBoard(h.board.id)
  await started
  try {
    expect((await h.dispatcher.onReport(D1, 4, h.reportFor(h.sent[0]!.d, { prNumber: 12 }))).accepted).toBe(true)
  } finally {
    release()
  }
  await h.dispatcher.settle()
  expect((await h.card(c.id)).linkedPrNumber).toBe(12)
  expect(h.store.issues.get(c.issueNumber)).toMatchObject({ labels: ['ac/status:done'], state: 'closed' })
})

it('records write mode when a fast worker reports before its dispatch ACK arrives', async () => {
  const h = await harness({
    reply: async (d) => {
      await h.dispatcher.onReport(D1, 4, h.reportFor(d))
      return { leaseId: d.leaseId, accepted: true }
    }
  })
  await h.addCard(['ac/status:ready', WRITE_MODE_LABEL], 'write')
  await h.dispatcher.reconcileBoard(h.board.id)
  await h.dispatcher.settle()
  expect(await h.run(h.sent[0]!.d.leaseId)).toMatchObject({ mode: 'write', outcome: 'completed' })
})

it.each([
  ['completed', 'done'],
  ['not_planned', 'archived']
])('preserves closed issue %s and reconciles DB to %s', async (reason, status) => {
  const h = await harness()
  const c = await h.addCard(['ac/status:ready', 'human-label'])
  const issue = h.store.issues.get(c.issueNumber)!
  issue.state = 'closed'
  issue.stateReason = reason
  await h.dispatcher.tick()
  await h.dispatcher.settle()
  h.clock.advance(5 * 60_000)
  await h.dispatcher.tick()
  await h.dispatcher.settle()
  expect(h.sent).toEqual([])
  expect(h.store.writes).toEqual([])
  expect(issue).toEqual({ labels: ['ac/status:ready', 'human-label'], state: 'closed', stateReason: reason })
  expect((await h.card(c.id)).status).toBe(status)
  expect(await prisma.kanbanRun.count({ where: { endedAt: null } })).toBe(0)
  expect(await prisma.kanbanRun.count()).toBe(1)
  // Reopening an archived card follows the existing archived -> triage -> ready transitions.
  issue.state = 'open'
  issue.stateReason = null
  issue.labels = ['ac/status:triage', 'human-label']
  await h.dispatcher.ingestCard(h.board.id, c.issueNumber)
  expect((await h.card(c.id)).status).toBe('triage')
  issue.labels = ['ac/status:ready', 'human-label']
  await h.dispatcher.ingestCard(h.board.id, c.issueNumber)
  expect((await h.card(c.id)).status).toBe('ready')
  expect(h.store.writes).toEqual([])
  await h.dispatcher.tick()
  await h.dispatcher.settle()
  expect(h.sent[0]?.d).toMatchObject({ cardId: c.id, attempt: 2 })
})

it('keeps an accepted lease alive after its ACK write fails, without reaping or redispatching', async () => {
  const h = await harness()
  const c = await h.addCard()
  vi.spyOn(h.repo, 'markAcked').mockRejectedValueOnce(new Error('ACK transaction failed'))
  await h.dispatcher.reconcileBoard(h.board.id)
  const d = h.sent[0]!.d
  expect((await h.run(d.leaseId)).ackedAt).toBeNull()
  for (let i = 0; i < 6; i++) {
    h.clock.advance(60_000)
    expect(
      await h.dispatcher.onHeartbeat(D1, 4, [
        {
          leaseId: d.leaseId,
          cardId: d.cardId,
          dispatchRevision: d.dispatchRevision,
          liveness: 'turn'
        }
      ])
    ).toEqual([])
    expect(await h.dispatcher.reap()).toBe(0)
    await h.dispatcher.tick()
  }
  expect(await h.run(d.leaseId)).toMatchObject({ ackedAt: new Date(T0 + 60_000), endedAt: null })
  expect((await h.card(c.id)).status).toBe('running')
  expect(h.sent).toHaveLength(1)
  expect(await prisma.kanbanRun.count()).toBe(1)
})

it('ignores a User/PAT-added write label on the next lease after a transient report', async () => {
  const h = await harness()
  const c = await h.addCard()
  await h.dispatcher.reconcileBoard(h.board.id)
  await h.dispatcher.settle()
  h.store.issues.get(c.issueNumber)!.labels.push(WRITE_MODE_LABEL)
  await h.dispatcher.onReport(D1, 4, h.reportFor(h.sent[0]!.d, { outcome: 'transient' }))
  await h.dispatcher.settle()
  h.clock.advance(61_000)
  await h.dispatcher.tick()
  await h.dispatcher.settle()
  expect(h.sent.map(({ d }) => d.mode)).toEqual(['read', 'read'])
  expect((await h.run(h.sent[1]!.d.leaseId)).mode).toBe('read')
})

it('rejects an old connection report after reauthentication and accepts the current epoch', async () => {
  const h = await harness()
  await h.addCard()
  await h.dispatcher.reconcileBoard(h.board.id)
  const d = h.sent[0]!.d
  await prisma.daemon.update({ where: { id: D1 }, data: { sessionEpoch: 5n } })
  expect((await h.dispatcher.onReport(D1, 4, h.reportFor(d))).accepted).toBe(false)
  expect((await h.dispatcher.onReport(D1, 5, h.reportFor(d))).accepted).toBe(true)
  await h.dispatcher.settle()
})

it('uses a board default and lets a nullable card override restrict or inherit it', async () => {
  const h = await harness()
  const admin = new PgKanbanBoardRepo(prisma)
  expect(await admin.setDefaultMode(DEFAULT_ORG_ID, h.board.id, DEFAULT_OWNER_ID, 'write')).toBe(true)
  const inherited = await h.addCard()
  const restricted = await h.addCard(['ac/status:ready', WRITE_MODE_LABEL], 'read')
  await h.dispatcher.reconcileBoard(h.board.id)
  expect(h.sent.find(({ d }) => d.cardId === inherited.id)?.d.mode).toBe('write')
  expect(h.sent.find(({ d }) => d.cardId === restricted.id)?.d.mode).toBe('read')
})

it('restricts mode administration to an owner in the board org and supports clearing card overrides', async () => {
  const h = await harness()
  const c = await h.addCard()
  const admin = new PgKanbanBoardRepo(prisma)
  expect(await admin.setDefaultMode(DEFAULT_ORG_ID, h.board.id, 'worker-id', 'write')).toBe(false)
  expect(await admin.setCardMode('other-org', h.board.id, c.id, DEFAULT_OWNER_ID, 'write')).toBe(false)
  expect(await admin.setCardMode(DEFAULT_ORG_ID, h.board.id, c.id, 'worker-id', 'write')).toBe(false)
  expect((await h.card(c.id)).mode).toBeNull()
  expect(await admin.setCardMode(DEFAULT_ORG_ID, h.board.id, c.id, DEFAULT_OWNER_ID, 'write')).toBe(true)
  expect((await h.card(c.id)).mode).toBe('write')
  expect(await admin.setCardMode(DEFAULT_ORG_ID, h.board.id, c.id, DEFAULT_OWNER_ID, null)).toBe(true)
  expect((await h.card(c.id)).mode).toBeNull()
})

it('periodically recovers a blocked mismatch when a ready webhook was missed', async () => {
  const h = await harness()
  const c = await h.addCard(['ac/status:blocked'])
  await h.dispatcher.tick()
  expect((await h.card(c.id)).status).toBe('blocked')
  expect(h.store.writes).toEqual([])
  h.store.issues.get(c.issueNumber)!.labels = ['ac/status:ready']
  await h.dispatcher.tick()
  await h.dispatcher.settle()
  expect(h.sent).toHaveLength(1)
  expect(h.sent[0]?.d.attempt).toBe(2)
})

describe('KanbanDispatcher — mismatch recovery is human-only and bounded (real Postgres)', () => {
  it('an agent/bot-written ready label never un-parks a card; a human-written one does', async () => {
    const h = await harness()
    const c = await h.addCard(['ac/status:blocked'])
    await h.dispatcher.tick()
    expect((await h.card(c.id)).status).toBe('blocked')
    h.store.issues.get(c.issueNumber)!.labels = ['ac/status:ready']
    h.store.statusActors.set(c.issueNumber, 'bot')
    expect(await h.dispatcher.ingestCard(h.board.id, c.issueNumber)).toBe(false)
    for (let i = 0; i < 3; i++) {
      h.clock.advance(60 * 60_000)
      await h.dispatcher.tick()
      await h.dispatcher.settle()
    }
    expect((await h.card(c.id)).status).toBe('blocked')
    expect(h.sent).toEqual([])
    expect(h.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ issueNumber: c.issueNumber, from: 'blocked', to: 'ready' }),
      'kanban: recovery ignored a non-human status label'
    )
    h.store.statusActors.set(c.issueNumber, 'human')
    expect(await h.dispatcher.ingestCard(h.board.id, c.issueNumber)).toBe(true)
    await h.dispatcher.tick()
    await h.dispatcher.settle()
    expect(h.sent[0]?.d).toMatchObject({ cardId: c.id, attempt: 2 })
  })

  it('recovers only on ticks, backs off per card, and resets after a change', async () => {
    const h = await harness()
    const c = await h.addCard(['ac/status:blocked'])
    await h.dispatcher.tick()
    await h.dispatcher.settle()
    const readsOf = () => h.store.reads.filter((n) => n === c.issueNumber).length
    expect(readsOf()).toBe(1)
    // Doorbell and report pokes never run recovery reads.
    await h.dispatcher.reconcileBoard(h.board.id)
    h.dispatcher.poke(h.board.id)
    await h.dispatcher.settle()
    expect(readsOf()).toBe(1)
    await h.dispatcher.tick()
    expect(readsOf()).toBe(2)
    // Backed off 1 min, then 2 min: a tick inside the window makes no GitHub read.
    await h.dispatcher.tick()
    expect(readsOf()).toBe(2)
    h.clock.advance(60_000)
    await h.dispatcher.tick()
    expect(readsOf()).toBe(3)
    h.clock.advance(60_000)
    await h.dispatcher.tick()
    expect(readsOf()).toBe(3)
    expect((await h.card(c.id)).recoveryChecks).toBe(2)
    h.store.issues.get(c.issueNumber)!.labels = ['ac/status:triage']
    h.clock.advance(60_000)
    await h.dispatcher.tick()
    expect(await h.card(c.id)).toMatchObject({ status: 'triage', recoveryChecks: 0, recoveryCheckAt: null })
  })

  it('stays under the GitHub budget with 100 closed and 100 parked cards', async () => {
    const h = await harness()
    await prisma.kanbanBoard.update({
      where: { id: h.board.id },
      data: { maxInProgress: 500, maxInProgressPerAgent: 500 }
    })
    const closed: Array<{ issueNumber: number }> = []
    for (let i = 0; i < 100; i++) closed.push(await h.addCard())
    for (const c of closed) h.store.issues.get(c.issueNumber)!.state = 'closed'
    for (let i = 0; i < 100; i++) await h.addCard(['ac/status:blocked'])
    await h.dispatcher.tick()
    await h.dispatcher.settle()
    expect(await prisma.kanbanCard.count({ where: { status: 'done' } })).toBe(100)
    expect(await prisma.kanbanCard.count({ where: { status: 'blocked' } })).toBe(100)
    const hour = async () => {
      h.store.reads.length = 0
      for (let minute = 0; minute < 60; minute++) {
        await h.dispatcher.tick()
        h.clock.advance(60_000)
      }
      // Terminal cards are never re-read.
      expect(h.store.reads.some((n) => closed.some((c) => c.issueNumber === n))).toBe(false)
      return h.store.reads.length
    }
    // The first hour is capped by the per-tick batch; once backed off, each parked card costs about one read an hour.
    expect(await hour()).toBeLessThanOrEqual(60 * 25)
    expect(await hour()).toBeLessThanOrEqual(200)
  })

  it('logs a human move the state machine cannot apply instead of dropping it silently', async () => {
    const h = await harness()
    const c = await h.addCard()
    const issue = h.store.issues.get(c.issueNumber)!
    issue.state = 'closed'
    issue.stateReason = 'not_planned'
    await h.dispatcher.tick()
    expect((await h.card(c.id)).status).toBe('archived')
    issue.state = 'open'
    issue.labels = ['ac/status:ready']
    expect(await h.dispatcher.ingestCard(h.board.id, c.issueNumber)).toBe(false)
    expect((await h.card(c.id)).status).toBe('archived')
    expect(h.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'archived', requested: 'ready' }),
      'kanban: recovery ignored a status move the state machine does not allow'
    )
  })

  it('dispatches a ready card that still carries todo+ready promotion residue instead of parking it in triage', async () => {
    const h = await harness()
    const c = await h.addCard(['ac/status:todo', 'ac/status:ready', 'bug'])
    await h.dispatcher.tick()
    await h.dispatcher.settle()
    expect(h.sent[0]?.d.cardId).toBe(c.id)
    expect((await h.card(c.id)).status).toBe('running')
    expect(h.store.issues.get(c.issueNumber)?.labels).toEqual(['bug', 'ac/status:running'])
  })
})

const emptyGraph = (): CardGraph => ({ parent: null, subIssues: [], blockedBy: [], blocking: [], truncated: false })
const completedBlocker = {
  issueId: 100n,
  number: 100,
  repoId: REPO_ID,
  state: 'closed' as const,
  stateReason: 'completed'
}

async function graphHarness() {
  const h = await harness()
  const { graphs, store } = h
  const log = { debug: vi.fn(), warn: vi.fn() }
  const reconciler = new KanbanGraphReconciler({ cards: new PgKanbanCardRepo(prisma), store, log })
  const ingest = vi.spyOn(h.dispatcher, 'ingestCard')
  const poke = vi.spyOn(h.dispatcher, 'poke')
  const bell = new KanbanGraphDoorbell({
    boards: new PgKanbanBoardRepo(prisma),
    installations: {
      getByInstallationId: async () =>
        ({ orgId: OrgId(DEFAULT_ORG_ID), installationId: 77n, revokedAt: null, suspendedAt: null }) as never
    },
    store,
    onGraph: async (board, repo, n, graph) => {
      await reconciler.apply(board, repo, n, graph)
      await h.dispatcher.onCardChanged(board.id, n)
      h.dispatcher.poke(board.id)
    },
    onCard: async (board, _repo, n) => {
      await h.dispatcher.onCardChanged(board.id, n)
      h.dispatcher.poke(board.id)
    },
    log
  })
  const ring = async (n: number, deliveryKey = 'graph-1') => {
    bell.poke({
      deliveryKey,
      installationId: '77',
      repoId: REPO_ID.toString(),
      event: 'issue_dependencies',
      action: 'blocked_by_added',
      ids: [],
      numbers: [n]
    })
    await bell.settle()
    await h.dispatcher.settle()
  }
  // The relay's `issues` doorbell for a human status relabel; it never reads the graph.
  const ringLabel = async (n: number, deliveryKey = 'label-1') => {
    bell.poke({
      deliveryKey,
      installationId: '77',
      repoId: REPO_ID.toString(),
      event: 'issues',
      action: 'labeled',
      ids: [String(n)],
      numbers: [n]
    })
    await bell.settle()
    await h.dispatcher.settle()
  }
  return { ...h, graphs, store, bell, ring, ringLabel, ingest, poke }
}

describe('Kanban card-status doorbell un-parks a re-readied card at once (real Postgres)', () => {
  // Park a card in blocked, then let recovery back it off to the one-hour ceiling.
  const parkAtCeiling = async (h: Awaited<ReturnType<typeof graphHarness>>) => {
    const c = await h.addCard(['ac/status:blocked'])
    await h.dispatcher.tick()
    for (let i = 0; i < 8; i++) {
      const { recoveryCheckAt } = await h.card(c.id)
      if (recoveryCheckAt) h.clock.advance(recoveryCheckAt.getTime() - h.clock.now())
      await h.dispatcher.tick()
    }
    const parked = await h.card(c.id)
    expect(parked.status).toBe('blocked')
    expect(parked.recoveryCheckAt!.getTime() - h.clock.now()).toBe(60 * 60_000)
    return c
  }

  it('dispatches a human-re-readied card on the labeled webhook instead of after the backoff', async () => {
    const h = await graphHarness()
    const c = await parkAtCeiling(h)
    h.store.issues.get(c.issueNumber)!.labels = ['ac/status:ready']
    await h.ringLabel(c.issueNumber)
    expect(h.store.reads.at(-2)).toBe(c.issueNumber)
    expect(h.sent.map(({ d }) => d)).toEqual([expect.objectContaining({ cardId: c.id, attempt: 2 })])
    expect(await h.card(c.id)).toMatchObject({ status: 'running', recoveryCheckAt: null, recoveryChecks: 0 })
    expect(h.bell.landedDeliveryKeys(['label-1'])).toEqual(new Set(['label-1']))
  })

  it('resets the backoff on the webhook even when the change cannot un-park the card', async () => {
    const h = await graphHarness()
    const c = await parkAtCeiling(h)
    h.store.issues.get(c.issueNumber)!.labels = ['ac/status:ready']
    h.store.statusActors.set(c.issueNumber, 'bot')
    await h.ringLabel(c.issueNumber)
    expect(h.sent).toEqual([])
    expect(await h.card(c.id)).toMatchObject({ status: 'blocked', recoveryCheckAt: null, recoveryChecks: 0 })
    // The very next tick re-reads it, so a human fix moments later is not stuck behind the old hour.
    const reads = h.store.reads.length
    await h.dispatcher.tick()
    expect(h.store.reads.length).toBe(reads + 1)
    h.store.statusActors.set(c.issueNumber, 'human')
    h.clock.advance(60_000)
    await h.dispatcher.tick()
    await h.dispatcher.settle()
    expect(h.sent[0]?.d).toMatchObject({ cardId: c.id, attempt: 2 })
  })

  it('restarts the backoff when a tick read sees GitHub changed, even without a webhook', async () => {
    const h = await graphHarness()
    const c = await parkAtCeiling(h)
    h.store.issues.get(c.issueNumber)!.labels = ['ac/status:blocked', 'ac/status:triage']
    h.clock.advance(60 * 60_000)
    await h.dispatcher.tick()
    const card = await h.card(c.id)
    expect(card).toMatchObject({ status: 'blocked', recoveryChecks: 1 })
    expect(card.recoveryCheckAt!.getTime() - h.clock.now()).toBe(60_000)
  })
})

describe('Kanban graph reconciliation composed with dispatch (real Postgres)', () => {
  it('promotes despite a mode change between reading the card and the status CAS', async () => {
    const h = await graphHarness()
    const c = await h.addCard(['ac/status:todo'])
    await prisma.kanbanCard.update({ where: { id: c.id }, data: { status: 'todo' } })
    h.graphs.set(c.issueNumber, { ...emptyGraph(), blockedBy: [completedBlocker] })
    const readCard = h.store.readCard.bind(h.store)
    vi.spyOn(h.store, 'readCard').mockImplementationOnce(async (repo, number) => {
      expect(
        await new PgKanbanBoardRepo(prisma).setCardMode(DEFAULT_ORG_ID, h.board.id, c.id, DEFAULT_OWNER_ID, 'read')
      ).toBe(true)
      expect(await h.card(c.id)).toMatchObject({ stateRevision: c.stateRevision, modeRevision: 1 })
      return readCard(repo, number)
    })
    await h.ring(c.issueNumber)
    expect(h.sent[0]?.d.cardId).toBe(c.id)
    expect((await h.card(c.id)).status).toBe('running')
    expect(h.store.writes.map((p) => p.status)).toEqual(['ready', 'running'])
  })

  it('promotes todo and writes ready before the dispatcher reads and claims it', async () => {
    const h = await graphHarness()
    const c = await h.addCard(['ac/status:todo', 'human-label'])
    await prisma.kanbanCard.update({ where: { id: c.id }, data: { status: 'todo' } })
    h.graphs.set(c.issueNumber, { ...emptyGraph(), blockedBy: [completedBlocker] })
    await h.ring(c.issueNumber)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.d).toMatchObject({ cardId: c.id, attempt: 1 })
    expect((await h.card(c.id)).status).toBe('running')
    expect(h.store.writes.map((p) => p.status)).toEqual(['ready', 'running'])
    expect(h.store.issues.get(c.issueNumber)?.labels).toEqual(['human-label', 'ac/status:running'])
    expect(h.bell.landedDeliveryKeys(['graph-1'])).toEqual(new Set(['graph-1']))
    await h.ring(c.issueNumber, 'graph-2')
    expect(h.sent).toHaveLength(1)
  })

  it('dispatches a newly unblocked dependent when only its completed blocker is poked', async () => {
    const h = await graphHarness()
    const c = await h.addCard(['ac/status:todo'])
    await prisma.kanbanCard.update({ where: { id: c.id }, data: { status: 'todo' } })
    h.graphs.set(100, {
      ...emptyGraph(),
      blocking: [{ ...completedBlocker, issueId: c.issueId, number: c.issueNumber, state: 'open', stateReason: null }]
    })
    h.graphs.set(c.issueNumber, { ...emptyGraph(), blockedBy: [completedBlocker] })
    await h.ring(100)
    expect(h.sent[0]?.d.cardId).toBe(c.id)
    expect(h.store.writes.map((p) => p.status)).toEqual(['ready', 'running'])
  })

  it.each([
    { labels: ['ac/status:blocked'], status: 'blocked' },
    { labels: ['ac/status:ready', 'ac/status:blocked'], status: 'triage' }
  ])('preserves human labels ($status) and recovers only after a human ready edit', async ({ labels, status }) => {
    const h = await graphHarness()
    const c = await h.addCard(labels)
    h.graphs.set(c.issueNumber, { ...emptyGraph(), blockedBy: [completedBlocker] })
    await h.ring(c.issueNumber)
    expect((await h.card(c.id)).status).toBe(status)
    expect(h.sent).toEqual([])
    expect(h.store.writes).toEqual([])
    h.store.issues.get(c.issueNumber)!.labels = ['ac/status:ready']
    await h.ring(c.issueNumber, 'graph-2')
    expect(h.sent[0]?.d).toMatchObject({ cardId: c.id, attempt: 2 })
    expect((await h.card(c.id)).status).toBe('running')
  })

  // A failed promotion write: nothing landed, the add landed (todo+ready), or both landed but the DELETE timed out.
  const failPromotion = async (
    h: Awaited<ReturnType<typeof graphHarness>>,
    landed: string[] | null,
    changeMode = false
  ) => {
    const c = await h.addCard(['ac/status:todo'])
    await prisma.kanbanCard.update({ where: { id: c.id }, data: { status: 'todo' } })
    h.graphs.set(c.issueNumber, { ...emptyGraph(), blockedBy: [completedBlocker] })
    const apply = h.store.applyPlan.bind(h.store)
    vi.spyOn(h.store, 'applyPlan')
      .mockImplementationOnce(async (_repo, _n, _observed, _plan, onLabelAdded) => {
        // #19: an owner flips the card's write mode while the promotion is in flight.
        if (changeMode)
          expect(
            await new PgKanbanBoardRepo(prisma).setCardMode(DEFAULT_ORG_ID, h.board.id, c.id, DEFAULT_OWNER_ID, 'read')
          ).toBe(true)
        if (landed) {
          h.store.relabel(c.issueNumber, landed, 'app')
          const event = [...h.store.events.get(c.issueNumber)!]
            .reverse()
            .find((e) => e.event === 'labeled' && e.label?.name === 'ac/status:ready')!
          onLabelAdded?.('ac/status:ready', new Date(event.created_at!))
        }
        throw new Error('label write timed out')
      })
      .mockImplementation(apply)
    await h.ring(c.issueNumber)
    expect(h.bell.landedDeliveryKeys(['graph-1'])).toEqual(new Set())
    expect(h.ingest).not.toHaveBeenCalled()
    expect(h.poke).not.toHaveBeenCalled()
    expect(h.sent).toEqual([])
    // The undone promotion leaves DB todo, flagged for recovery, so no claim can mismatch it.
    expect(await h.card(c.id)).toMatchObject({ status: 'todo', promotionPending: true })
    return c
  }

  it.each([
    { name: 'add landed, removal failed', landed: ['ac/status:todo', 'ac/status:ready'] },
    { name: 'removal landed but timed out', landed: ['ac/status:ready'] }
  ])('the next tick adopts a half-landed promotion ($name) without waiting for redelivery', async ({ landed }) => {
    const h = await graphHarness()
    const c = await failPromotion(h, landed)
    await h.dispatcher.tick()
    await h.dispatcher.settle()
    expect(h.sent.map(({ d }) => d.cardId)).toEqual([c.id])
    expect(await h.card(c.id)).toMatchObject({ status: 'running', promotionPending: false })
    expect(h.store.issues.get(c.issueNumber)?.labels).toEqual(['ac/status:running'])
    expect(h.log.info).toHaveBeenCalledWith(
      { boardId: h.board.id, issueNumber: c.issueNumber },
      'kanban: adopted a half-landed graph promotion'
    )
  })

  it.each([{ labels: ['ac/status:ready'] }, { labels: ['ac/status:todo', 'ac/status:ready'] }])(
    'never adopts $labels re-added by an agent using the same App after a human removal',
    async ({ labels }) => {
      const h = await graphHarness()
      const c = await failPromotion(h, labels)
      const receipt = (await h.card(c.id)).promotionReadyAddedAt
      expect(receipt).not.toBeNull()
      h.store.relabel(
        c.issueNumber,
        labels.filter((label) => label !== 'ac/status:ready'),
        'human'
      )
      h.store.relabel(c.issueNumber, labels, 'app')
      await h.dispatcher.tick()
      await h.dispatcher.settle()
      await h.ring(c.issueNumber, 'graph-2')
      expect(h.sent).toEqual([])
      expect(await h.card(c.id)).toMatchObject({ status: 'todo', promotionPending: false, promotionReadyAddedAt: null })
    }
  )

  it.each(['tick', 'doorbell'] as const)(
    'a thrown %s read preserves the receipt and a later tick repairs',
    async (trigger) => {
      const h = await graphHarness()
      const c = await failPromotion(h, ['ac/status:ready'])
      const receipt = (await h.card(c.id)).promotionReadyAddedAt
      vi.spyOn(h.store, 'readCard').mockRejectedValueOnce(new Error('GitHub 503'))
      if (trigger === 'doorbell')
        await expect(h.dispatcher.onCardChanged(h.board.id, c.issueNumber)).rejects.toThrow('GitHub 503')
      else await h.dispatcher.tick()
      expect(await h.card(c.id)).toMatchObject({
        status: 'todo',
        promotionPending: true,
        promotionReadyAddedAt: receipt,
        recoveryChecks: 1
      })
      const reads = h.store.reads.length
      await h.dispatcher.tick()
      expect(h.store.reads.length).toBe(reads)
      expect(h.sent).toEqual([])
      h.clock.advance(60_000)
      await h.dispatcher.tick()
      await h.dispatcher.settle()
      expect(h.sent.map(({ d }) => d.cardId)).toEqual([c.id])
      expect(await h.card(c.id)).toMatchObject({
        status: 'running',
        promotionPending: false,
        promotionReadyAddedAt: null
      })
    }
  )

  it.each(['tick', 'doorbell'] as const)(
    'lagging events on a %s keep pending and back off until a later tick repairs',
    async (trigger) => {
      const h = await graphHarness()
      const c = await failPromotion(h, ['ac/status:todo', 'ac/status:ready'])
      const events = h.store.events.get(c.issueNumber)!
      h.store.events.set(c.issueNumber, [])
      if (trigger === 'doorbell') expect(await h.dispatcher.onCardChanged(h.board.id, c.issueNumber)).toBe(false)
      else await h.dispatcher.tick()
      expect(await h.card(c.id)).toMatchObject({ status: 'todo', promotionPending: true, recoveryChecks: 1 })
      h.clock.advance(60_000)
      await h.dispatcher.tick()
      expect(await h.card(c.id)).toMatchObject({ promotionPending: true, recoveryChecks: 2 })
      const reads = h.store.reads.length
      h.store.events.set(c.issueNumber, events)
      h.clock.advance(60_000)
      await h.dispatcher.tick()
      expect(h.store.reads.length).toBe(reads)
      h.clock.advance(60_000)
      await h.dispatcher.tick()
      await h.dispatcher.settle()
      expect(h.sent.map(({ d }) => d.cardId)).toEqual([c.id])
      expect(await h.card(c.id)).toMatchObject({ status: 'running', promotionPending: false })
    }
  )

  it('a failed promotion rollback keeps a concurrent mode change (#19) and still flags the card', async () => {
    const h = await graphHarness()
    const c = await failPromotion(h, ['ac/status:todo', 'ac/status:ready'], true)
    expect(await h.card(c.id)).toMatchObject({
      status: 'todo',
      stateRevision: c.stateRevision + 2n,
      mode: 'read',
      modeRevision: 1,
      promotionPending: true
    })
  })

  it('a redelivered doorbell adopts a ready label that landed before its removal timed out', async () => {
    const h = await graphHarness()
    const c = await failPromotion(h, ['ac/status:ready'])
    await h.ring(c.issueNumber)
    expect(h.bell.landedDeliveryKeys(['graph-1'])).toEqual(new Set(['graph-1']))
    expect(h.sent[0]?.d.cardId).toBe(c.id)
    expect(await h.card(c.id)).toMatchObject({ status: 'running', promotionPending: false })
  })

  it('a tick after a promotion whose add failed clears the flag and leaves todo; redelivery promotes', async () => {
    const h = await graphHarness()
    const c = await failPromotion(h, null)
    await h.dispatcher.tick()
    await h.dispatcher.settle()
    expect(h.sent).toEqual([])
    expect(await prisma.kanbanRun.count()).toBe(0)
    expect(await h.card(c.id)).toMatchObject({ status: 'todo', promotionPending: false })
    // The recovery read happened once; the cleared flag is not re-read on later ticks.
    const reads = h.store.reads.length
    h.clock.advance(60 * 60_000)
    await h.dispatcher.tick()
    expect(h.store.reads.length).toBe(reads)
    await h.ring(c.issueNumber)
    expect(h.bell.landedDeliveryKeys(['graph-1'])).toEqual(new Set(['graph-1']))
    expect(h.sent[0]?.d.cardId).toBe(c.id)
    expect((await h.card(c.id)).status).toBe('running')
  })

  it('never adopts a pending promotion that a human moved elsewhere on GitHub', async () => {
    const h = await graphHarness()
    const c = await failPromotion(h, null)
    h.store.relabel(c.issueNumber, ['ac/status:blocked'], 'human')
    await h.dispatcher.tick()
    await h.dispatcher.settle()
    expect(h.sent).toEqual([])
    expect(await h.card(c.id)).toMatchObject({ status: 'todo', promotionPending: false })
  })

  // Vera's #18 sequence: the promotion write fails, a human parks the card, then an agent (the App bot) or another bot readies it.
  it.each([
    { swapper: 'app' as const, doorbell: false },
    { swapper: 'app' as const, doorbell: true },
    { swapper: 'other' as const, doorbell: false }
  ])(
    'a $swapper swap to ready after a human park is never dispatched (human doorbell rang: $doorbell)',
    async ({ swapper, doorbell }) => {
      const h = await graphHarness()
      const c = await failPromotion(h, null)
      h.store.relabel(c.issueNumber, ['ac/status:blocked'], 'human')
      if (doorbell) {
        await h.ringLabel(c.issueNumber)
        // A conclusive human park settles the pending flag.
        expect(await h.card(c.id)).toMatchObject({ status: 'todo', promotionPending: false })
      }
      h.store.relabel(c.issueNumber, ['ac/status:ready'], swapper)
      await h.dispatcher.tick()
      await h.dispatcher.settle()
      // A later graph doorbell for the card does not adopt the bot's ready either.
      await h.ring(c.issueNumber, 'graph-2')
      h.clock.advance(60 * 60_000)
      await h.dispatcher.tick()
      await h.dispatcher.settle()
      expect(h.sent).toEqual([])
      expect(await prisma.kanbanRun.count()).toBe(0)
      expect(await h.card(c.id)).toMatchObject({ status: 'todo', promotionPending: false })
      expect(h.store.issues.get(c.issueNumber)?.labels).toEqual(['ac/status:ready'])
      if (!doorbell) {
        expect(h.log.info).toHaveBeenCalledWith(
          { boardId: h.board.id, issueNumber: c.issueNumber },
          'kanban: refused a pending promotion whose ready label is not ours'
        )
      }
    }
  )

  it('adopts a pending promotion a human finished by hand', async () => {
    const h = await graphHarness()
    const c = await failPromotion(h, null)
    h.store.relabel(c.issueNumber, ['ac/status:ready'], 'human')
    await h.dispatcher.tick()
    await h.dispatcher.settle()
    expect(h.sent.map(({ d }) => d.cardId)).toEqual([c.id])
  })

  it('refuses a half-landed promotion once a blocker has reopened', async () => {
    const h = await graphHarness()
    const c = await failPromotion(h, ['ac/status:ready'])
    h.graphs.set(c.issueNumber, {
      ...emptyGraph(),
      blockedBy: [{ ...completedBlocker, state: 'open', stateReason: null }]
    })
    await h.dispatcher.tick()
    await h.dispatcher.settle()
    expect(h.sent).toEqual([])
    expect(await h.card(c.id)).toMatchObject({ status: 'todo', promotionPending: false })
    expect(h.log.info).toHaveBeenCalledWith(
      { boardId: h.board.id, issueNumber: c.issueNumber },
      'kanban: refused a pending promotion whose blockers reopened'
    )
  })

  it('rejects a stale graph CAS after mismatch ingest advances the card revision', async () => {
    const h = await graphHarness()
    const c = await h.addCard(['ac/status:todo'])
    await h.dispatcher.reconcileBoard(h.board.id)
    const cards = new PgKanbanCardRepo(prisma)
    const before = await cards.findByIssueNumber(h.board.id, c.issueNumber)
    expect(before?.status).toBe('todo')
    h.store.issues.get(c.issueNumber)!.labels = ['ac/status:blocked']
    await h.dispatcher.ingestCard(h.board.id, c.issueNumber)
    expect(await cards.casStatus(c.id, before!.stateRevision, 'ready')).toBe(false)
    expect((await h.card(c.id)).status).toBe('blocked')
    expect(h.sent).toEqual([])
    expect(h.store.writes).toEqual([])
  })
})

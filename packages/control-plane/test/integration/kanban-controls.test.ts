// Kanban M4 controls (issue #2 B5) on real Postgres: pause/resume gate claims, skip/restart revoke leases and reset counters.
import { describe, expect, it, vi } from 'vitest'
import type { KanbanDispatch, KanbanDispatchOk, KanbanReport } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { FakeClock } from '../fakes/fake-clock.js'
import { PgKanbanDispatchRepo } from '../../src/persistence/repositories/kanban-dispatch.repo.js'
import { PgKanbanBoardRepo, PgKanbanCardRepo } from '../../src/persistence/repositories/kanban.repo.js'
import { KanbanDispatcher } from '../../src/kanban/dispatcher.js'
import { KanbanGraphReconciler } from '../../src/kanban/graph-reconciler.js'
import { KanbanControls } from '../../src/kanban/controls.js'
import type { CardGraph, CardIssue, KanbanRepoRef, LabelWriteObserver } from '../../src/kanban/card-store.js'
import type { LabelPlan, ObservedIssue } from '../../src/kanban/card-state.js'
import { OrgId } from '../../src/domain/ids.js'

const D1 = 'd1111111-1111-4111-8111-111111111111'
const D2 = 'd2222222-2222-4222-8222-222222222222'
const A1 = 'a1111111-1111-4111-8111-111111111111'
const REPO_ID = 987654321n
const T0 = Date.parse('2026-10-15T12:00:00.000Z')

class FakeStore {
  readonly writes: LabelPlan[] = []
  readonly issues = new Map<number, { labels: string[]; state: 'open' | 'closed'; stateReason: string | null }>()
  async readCard(_repo: KanbanRepoRef, n: number): Promise<CardIssue | null> {
    const i = this.issues.get(n)
    return i ? { issueId: BigInt(n), nodeId: `I_${n}`, number: n, ...i, labels: [...i.labels] } : null
  }
  async readGraph(_repo: KanbanRepoRef, _n: number): Promise<CardGraph> {
    return { parent: null, subIssues: [], blockedBy: [], blocking: [], truncated: false }
  }
  async lastEventId(): Promise<number> {
    return 0
  }
  async statusSetByHuman(_repo: KanbanRepoRef, _n: number, _status: never): Promise<boolean> {
    return true
  }
  async promotionVerdict(
    _repo: KanbanRepoRef,
    _n: number,
    _cursor: number,
    _acked: boolean
  ): Promise<'adopt' | 'reject' | 'inconclusive'> {
    return 'reject'
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
    for (const label of plan.addLabels) await onLabelAdded?.(label)
    i.labels = [...i.labels.filter((l) => !plan.removeLabels.includes(l)), ...plan.addLabels]
    if (plan.issueState) {
      i.state = plan.issueState.state
      i.stateReason = plan.issueState.state === 'closed' ? plan.issueState.reason : null
    }
  }
}

async function harness() {
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
      return { leaseId: d.leaseId, accepted: true } satisfies KanbanDispatchOk
    },
    isDaemonLive: () => true,
    clock,
    log
  })
  const controls = new KanbanControls({
    boards: new PgKanbanBoardRepo(prisma),
    cards: new PgKanbanCardRepo(prisma),
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
    resolveLogin: async () => 'maintainer',
    poke: (boardId) => dispatcher.poke(boardId),
    log: { warn: vi.fn() }
  })
  let issue = 1
  const addCard = async (labels: string[] = ['ac/status:ready'], status: 'ready' | 'triage' | 'running' = 'ready') => {
    const n = issue++
    store.issues.set(n, { labels, state: 'open', stateReason: null })
    return prisma.kanbanCard.create({
      data: { boardId: board.id, issueId: BigInt(n), issueNumber: n, status, assigneeAgentId: A1 }
    })
  }
  const card = (id: string) => prisma.kanbanCard.findUniqueOrThrow({ where: { id } })
  const boardRow = () => prisma.kanbanBoard.findUniqueOrThrow({ where: { id: board.id } })
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
  return { board, clock, store, sent, repo, dispatcher, controls, addCard, card, boardRow, reportFor }
}

describe('Kanban M4 controls — pause/resume gate (real Postgres)', () => {
  it('a paused board claims nothing, keeps reports and reaps, and claims again on resume', async () => {
    const h = await harness()
    const ready = await h.addCard()
    await h.controls.pause(DEFAULT_ORG_ID, h.board.id, DEFAULT_OWNER_ID)
    expect((await h.boardRow()).paused).toBe(true)

    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    expect(h.sent).toEqual([])

    // Re-pausing is a no-op with no extra audit row.
    await h.controls.pause(DEFAULT_ORG_ID, h.board.id, DEFAULT_OWNER_ID)
    expect(await prisma.auditEvent.count({ where: { kind: 'board_paused' } })).toBe(1)

    // An open lease still reports while paused.
    await prisma.kanbanCard.update({ where: { id: ready.id }, data: { status: 'ready' } })
    await h.dispatcher.reconcileBoard(h.board.id)
    expect(h.sent).toEqual([])

    await h.controls.resume(DEFAULT_ORG_ID, h.board.id, DEFAULT_OWNER_ID)
    expect((await h.boardRow()).paused).toBe(false)
    expect(await prisma.auditEvent.count({ where: { kind: 'board_resumed' } })).toBe(1)

    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.d.cardId).toBe(ready.id)
  })

  it('accepts an open lease report and heartbeat while paused', async () => {
    const h = await harness()
    const c = await h.addCard()
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    const d = h.sent[0]!.d
    await h.controls.pause(DEFAULT_ORG_ID, h.board.id, DEFAULT_OWNER_ID)
    expect(
      await h.dispatcher.onHeartbeat(D1, 4, [
        { leaseId: d.leaseId, cardId: d.cardId, dispatchRevision: d.dispatchRevision, liveness: 'turn' }
      ])
    ).toEqual([])
    expect(await h.dispatcher.onReport(D1, 4, h.reportFor(d))).toMatchObject({ accepted: true })
    await h.dispatcher.settle()
    expect((await h.card(c.id)).status).toBe('done')
  })

  it('the reaper still reclaims a stale lease on a paused board', async () => {
    const h = await harness()
    const c = await h.addCard()
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    expect(h.sent).toHaveLength(1)
    await h.controls.pause(DEFAULT_ORG_ID, h.board.id, DEFAULT_OWNER_ID)
    h.clock.advance(4 * 60 * 60_000 + 1_000)
    expect(await h.dispatcher.reap()).toBe(1)
    await h.dispatcher.settle()
    expect((await h.card(c.id)).status).toBe('ready')
    // Still paused: the reclaimed card is not re-claimed.
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    expect(h.sent).toHaveLength(1)
  })
})

describe('Kanban M4 controls — skip (real Postgres)', () => {
  it('archives the card, closes not_planned, revokes the lease, and fences the late report', async () => {
    const h = await harness()
    const c = await h.addCard()
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    const d = h.sent[0]!.d

    const result = await h.controls.skip(DEFAULT_ORG_ID, h.board.id, c.id, DEFAULT_OWNER_ID)
    expect(result.ok).toBe(true)
    expect(await h.card(c.id)).toMatchObject({ status: 'archived' })
    // The issue closed not_planned and one body-free comment posted (after the running label write).
    expect(h.store.issues.get(c.issueNumber)).toMatchObject({ state: 'closed', stateReason: 'not_planned' })
    const skip = h.store.writes.at(-1)!
    expect(skip.comment).toBe('skipped by @maintainer via AgentConnect')
    expect(skip.status).toBe('archived')
    expect(h.store.writes.filter((w) => w.comment === 'skipped by @maintainer via AgentConnect')).toHaveLength(1)

    // A late report from the superseded lease fails the fence.
    expect((await h.dispatcher.onReport(D1, 4, h.reportFor(d))).accepted).toBe(false)
    expect((await h.card(c.id)).status).toBe('archived')
    expect(await prisma.auditEvent.count({ where: { kind: 'card_skipped' } })).toBe(1)
  })

  it('does not promote a dependent when its blocker was skipped as not_planned', async () => {
    const h = await harness()
    const blocker = await h.addCard()
    const dependent = await h.addCard(['ac/status:todo'])
    await prisma.kanbanCard.update({ where: { id: dependent.id }, data: { status: 'todo' } })
    await h.controls.skip(DEFAULT_ORG_ID, h.board.id, blocker.id, DEFAULT_OWNER_ID)
    const reconciler = new KanbanGraphReconciler({
      cards: new PgKanbanCardRepo(prisma),
      store: h.store,
      agentSlug: async () => null,
      log: { debug: vi.fn() }
    })
    const observed = h.store.issues.get(blocker.issueNumber)!
    await reconciler.apply(
      { ...h.board, synthesizerAgentId: null, orgId: OrgId(DEFAULT_ORG_ID) },
      { installationId: 77n, repoId: REPO_ID, repoFullName: h.board.repoFullName },
      dependent.issueNumber,
      {
        parent: null,
        subIssues: [],
        blocking: [],
        truncated: false,
        blockedBy: [
          {
            issueId: blocker.issueId,
            number: blocker.issueNumber,
            repoId: REPO_ID,
            state: observed.state,
            stateReason: observed.stateReason
          }
        ]
      }
    )
    expect((await h.card(dependent.id)).status).toBe('todo')
    expect(h.store.writes.filter((w) => w.status === 'ready')).toEqual([])
  })

  it('refuses a card not on the board and a transition that is not allowed', async () => {
    const h = await harness()
    const done = await h.addCard(['ac/status:done'], 'running')
    await prisma.kanbanCard.update({ where: { id: done.id }, data: { status: 'done' } })
    expect(await h.controls.skip(DEFAULT_ORG_ID, h.board.id, done.id, DEFAULT_OWNER_ID)).toEqual({
      ok: false,
      reason: 'illegal_transition'
    })
    expect(
      await h.controls.skip(DEFAULT_ORG_ID, h.board.id, '00000000-0000-4000-8000-000000000000', DEFAULT_OWNER_ID)
    ).toEqual({
      ok: false,
      reason: 'not_found'
    })
  })
})

describe('Kanban M4 controls — restart (real Postgres)', () => {
  it('resets counters to ready, revokes the lease, and re-claims', async () => {
    const h = await harness()
    const c = await h.addCard(['ac/status:triage'], 'triage')
    await prisma.kanbanCard.update({
      where: { id: c.id },
      data: {
        consecutiveFailures: 2,
        protocolViolations: 1,
        blockRecurrence: 3,
        blockKind: 'needs_input',
        needsAttention: true,
        attentionReason: 'unattributed'
      }
    })
    const result = await h.controls.restart(DEFAULT_ORG_ID, h.board.id, c.id, DEFAULT_OWNER_ID)
    expect(result.ok).toBe(true)
    expect(await h.card(c.id)).toMatchObject({
      status: 'ready',
      consecutiveFailures: 0,
      protocolViolations: 0,
      blockRecurrence: 0,
      cooldownUntil: null,
      blockKind: null,
      needsAttention: false,
      attentionReason: null
    })
    expect(h.store.issues.get(c.issueNumber)).toMatchObject({ labels: ['ac/status:ready'], state: 'open' })
    expect(h.store.writes.at(-1)!.comment).toBe('restarted via AgentConnect')
    expect(await prisma.auditEvent.count({ where: { kind: 'card_restarted' } })).toBe(1)

    // Re-armed: the ready card is claimed on the next reconcile.
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    expect(h.sent.map(({ d }) => d.cardId)).toEqual([c.id])
  })

  it('allows an explicit reset of an already-ready card', async () => {
    const h = await harness()
    const c = await h.addCard()
    await h.controls.pause(DEFAULT_ORG_ID, h.board.id, DEFAULT_OWNER_ID)
    await prisma.kanbanCard.update({
      where: { id: c.id },
      data: { consecutiveFailures: 2, cooldownUntil: new Date(T0 + 60_000) }
    })
    expect((await h.controls.restart(DEFAULT_ORG_ID, h.board.id, c.id, DEFAULT_OWNER_ID)).ok).toBe(true)
    await h.dispatcher.settle()
    expect(await h.card(c.id)).toMatchObject({ status: 'ready', consecutiveFailures: 0, cooldownUntil: null })
  })

  it('bumps the running lease fence, refuses late reports, and creates a fresh attempt', async () => {
    const h = await harness()
    const c = await h.addCard()
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    const d = h.sent[0]!.d
    await h.controls.pause(DEFAULT_ORG_ID, h.board.id, DEFAULT_OWNER_ID)
    expect((await h.controls.restart(DEFAULT_ORG_ID, h.board.id, c.id, DEFAULT_OWNER_ID)).ok).toBe(true)
    await h.dispatcher.settle()
    expect((await h.card(c.id)).dispatchRevision).toBe(BigInt(d.dispatchRevision) + 1n)
    expect(await prisma.kanbanRun.findUniqueOrThrow({ where: { leaseId: d.leaseId } })).toMatchObject({
      outcome: 'reclaimed',
      reasonCode: 'restarted',
      endedAt: expect.any(Date)
    })
    expect((await h.dispatcher.onReport(D1, 4, h.reportFor(d))).accepted).toBe(false)
    expect((await h.card(c.id)).status).toBe('ready')
    await h.controls.resume(DEFAULT_ORG_ID, h.board.id, DEFAULT_OWNER_ID)
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    expect(h.sent.at(-1)!.d).toMatchObject({ cardId: c.id, attempt: d.attempt + 1 })
    expect(h.sent.at(-1)!.d.leaseId).not.toBe(d.leaseId)
  })

  it.each(['done', 'archived'] as const)('reopens a %s card', async (status) => {
    const h = await harness()
    const c = await h.addCard(['ac/status:done'], 'running')
    await prisma.kanbanCard.update({ where: { id: c.id }, data: { status } })
    h.store.issues.get(c.issueNumber)!.state = 'closed'
    h.store.issues.get(c.issueNumber)!.stateReason = status === 'done' ? 'completed' : 'not_planned'
    const result = await h.controls.restart(DEFAULT_ORG_ID, h.board.id, c.id, DEFAULT_OWNER_ID)
    expect(result.ok).toBe(true)
    expect((await h.card(c.id)).status).toBe('ready')
    expect(h.store.issues.get(c.issueNumber)).toMatchObject({ state: 'open', labels: ['ac/status:ready'] })
  })
})

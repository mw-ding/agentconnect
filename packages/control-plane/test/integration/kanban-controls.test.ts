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
import type {
  CardGraph,
  CardIssue,
  KanbanRepoRef,
  LabelEvent,
  LabelWriteObserver
} from '../../src/kanban/card-store.js'
import type { LabelPlan, ObservedIssue } from '../../src/kanban/card-state.js'
import { OrgId } from '../../src/domain/ids.js'
import { KanbanSync } from '../../src/kanban/sync.js'
import { PgKanbanSyncRepo } from '../../src/persistence/repositories/kanban-sync.repo.js'
import { KanbanPrContracts } from '../../src/kanban/pr-contracts.js'
import type { LivePullRequest } from '../../src/kanban/contracts.js'
import { kanbanCardBranch } from '../../../daemon/src/kanban/card-branch.js'

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
  async readLabelEvents(_repo: KanbanRepoRef, _n: number): Promise<LabelEvent[]> {
    return []
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

async function harness(opts: { completionContract?: 'close' | 'pr_merged' } = {}) {
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
      maxInProgressPerAgent: 5,
      ...(opts.completionContract ? { completionContract: opts.completionContract } : {})
    }
  })
  const clock = new FakeClock(T0)
  const store = new FakeStore()
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() }
  const sent: Array<{ daemonId: string; d: KanbanDispatch }> = []
  const revoked: Array<{ daemonId: string; leaseId: string; cardId: string }> = []
  const projected: Array<{ boardId: string; issueNumber: number }> = []
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
    gate: dispatcher,
    revoke: async (lease, cardId) => {
      revoked.push({ daemonId: lease.daemonId, leaseId: lease.leaseId, cardId })
    },
    project: { onStatusCommitted: (ref) => projected.push({ boardId: ref.boardId, issueNumber: ref.issueNumber }) },
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
  return {
    board,
    clock,
    store,
    sent,
    revoked,
    projected,
    repo,
    dispatcher,
    controls,
    addCard,
    card,
    boardRow,
    reportFor
  }
}

describe('Kanban M4 controls — pause/resume gate (real Postgres)', () => {
  it('416c: a paused board claims nothing, keeps reports and reaps, and claims again on resume', async () => {
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

  it('416c: accepts an open lease report and heartbeat while paused', async () => {
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

  it('416c: the reaper still reclaims a stale lease on a paused board', async () => {
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
  it('416c: archives the card, closes not_planned, revokes the lease, and fences the late report', async () => {
    const h = await harness()
    const c = await h.addCard()
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    const d = h.sent[0]!.d

    const result = await h.controls.skip(DEFAULT_ORG_ID, h.board.id, c.id, DEFAULT_OWNER_ID)
    expect(result.ok).toBe(true)
    expect(await h.card(c.id)).toMatchObject({ status: 'archived', dispatchRevision: BigInt(d.dispatchRevision) + 1n })
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

  it('416c: does not promote a dependent when its blocker was skipped as not_planned', async () => {
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

  it('416c: refuses a card not on the board and a transition that is not allowed', async () => {
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
  it('416c: resets counters to ready, revokes the lease, and re-claims', async () => {
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

  it('416c: allows an explicit reset of an already-ready card', async () => {
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

  it('416c: bumps the running lease fence, refuses late reports, and creates a fresh attempt', async () => {
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

  it.each(['done', 'archived'] as const)('416c: reopens a %s card', async (status) => {
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

describe('416c: skip/restart lease revocation, episode reset and repair (real Postgres)', () => {
  it.each(['skip', 'restart'] as const)(
    '416c: %s revokes the open lease on its daemon at once and fences its heartbeat and late report',
    async (op) => {
      const h = await harness()
      const c = await h.addCard()
      await h.dispatcher.reconcileBoard(h.board.id)
      await h.dispatcher.settle()
      const d = h.sent[0]!.d
      await h.controls.pause(DEFAULT_ORG_ID, h.board.id, DEFAULT_OWNER_ID)
      expect((await h.controls[op](DEFAULT_ORG_ID, h.board.id, c.id, DEFAULT_OWNER_ID)).ok).toBe(true)
      expect(h.revoked).toEqual([{ daemonId: D1, leaseId: d.leaseId, cardId: c.id }])
      expect((await h.card(c.id)).dispatchRevision).toBe(BigInt(d.dispatchRevision) + 1n)
      const beat = {
        leaseId: d.leaseId,
        cardId: d.cardId,
        dispatchRevision: d.dispatchRevision,
        liveness: 'turn' as const
      }
      expect(await h.dispatcher.onHeartbeat(D1, 4, [beat])).toEqual([d.leaseId])
      expect((await h.dispatcher.onReport(D1, 4, h.reportFor(d))).accepted).toBe(false)
      expect((await h.card(c.id)).status).toBe(op === 'skip' ? 'archived' : 'ready')
    }
  )

  it('416c: a control on a card with no open lease revokes nothing', async () => {
    const h = await harness()
    const c = await h.addCard()
    await h.controls.pause(DEFAULT_ORG_ID, h.board.id, DEFAULT_OWNER_ID)
    expect((await h.controls.skip(DEFAULT_ORG_ID, h.board.id, c.id, DEFAULT_OWNER_ID)).ok).toBe(true)
    expect(h.revoked).toEqual([])
  })

  it.each(['review', 'done'] as const)(
    '416c: restart from %s starts a new work episode and clears the attention hold',
    async (from) => {
      const h = await harness()
      const c = await h.addCard()
      await prisma.kanbanCard.update({
        where: { id: c.id },
        data: {
          status: from,
          linkedPrNumber: 12,
          workEpisodeStartedAt: new Date(T0 - 60_000),
          contractFlags: ['pr_unbound#12'],
          verifiedAt: new Date(T0 - 30_000),
          reviewRounds: 2,
          needsAttention: true,
          attentionReason: 'pr_unbound'
        }
      })
      expect((await h.controls.restart(DEFAULT_ORG_ID, h.board.id, c.id, DEFAULT_OWNER_ID)).ok).toBe(true)
      expect(await h.card(c.id)).toMatchObject({
        status: 'ready',
        linkedPrNumber: null,
        workEpisodeStartedAt: null,
        contractFlags: [],
        verifiedAt: null,
        reviewRounds: 0,
        needsAttention: false,
        attentionReason: null
      })
    }
  )

  it('416c: a repeated skip is a no-op with no second audit, comment, revision or GitHub write', async () => {
    const h = await harness()
    const c = await h.addCard()
    expect((await h.controls.skip(DEFAULT_ORG_ID, h.board.id, c.id, DEFAULT_OWNER_ID)).ok).toBe(true)
    const after = await h.card(c.id)
    const writes = h.store.writes.length
    const audits = await prisma.auditEvent.count()
    expect(await h.controls.skip(DEFAULT_ORG_ID, h.board.id, c.id, DEFAULT_OWNER_ID)).toMatchObject({
      ok: true,
      value: { status: 'archived', revokedLease: null }
    })
    expect(await h.card(c.id)).toMatchObject({
      status: 'archived',
      stateRevision: after.stateRevision,
      dispatchRevision: after.dispatchRevision
    })
    expect(h.store.writes).toHaveLength(writes)
    expect(await prisma.auditEvent.count()).toBe(audits)
    expect(h.projected).toHaveLength(1)
  })

  it('416c: concurrent repeats of a restart leave one reset, audit, notification and comment', async () => {
    const h = await harness()
    const c = await h.addCard(['ac/status:triage'], 'triage')
    await h.controls.pause(DEFAULT_ORG_ID, h.board.id, DEFAULT_OWNER_ID)
    await prisma.kanbanBoard.update({ where: { id: h.board.id }, data: { targetChannel: 'C_TEST' } })
    const restart = () => h.controls.restart(DEFAULT_ORG_ID, h.board.id, c.id, DEFAULT_OWNER_ID)
    const results = await Promise.all([restart(), restart()])
    expect(results.every((r) => r.ok)).toBe(true)
    expect(await h.card(c.id)).toMatchObject({ status: 'ready', stateRevision: 2n, dispatchRevision: 2n })
    expect(await prisma.auditEvent.count({ where: { kind: 'card_restarted' } })).toBe(1)
    expect(await prisma.kanbanNotification.count({ where: { cardId: c.id } })).toBe(1)
    expect(h.store.writes).toHaveLength(1)
    expect(h.projected).toHaveLength(1)
    expect(await restart()).toMatchObject({ ok: true, value: { changed: false } })
    expect(h.store.writes).toHaveLength(1)
  })

  it.each(['skip', 'restart'] as const)(
    '416c: %s writes the status audit, projects the status, and a failed GitHub write is repaired by the label sync',
    async (op) => {
      const h = await harness()
      const c = await h.addCard(['ac/status:running'], 'running')
      await h.controls.pause(DEFAULT_ORG_ID, h.board.id, DEFAULT_OWNER_ID)
      const apply = vi.spyOn(h.store, 'applyPlan').mockRejectedValueOnce(new Error('GitHub 502'))
      expect((await h.controls[op](DEFAULT_ORG_ID, h.board.id, c.id, DEFAULT_OWNER_ID)).ok).toBe(true)
      expect(apply).toHaveBeenCalledTimes(1)
      const to = op === 'skip' ? 'archived' : 'ready'
      expect(await h.card(c.id)).toMatchObject({ status: to, labelWritePending: true })
      expect(h.projected).toEqual([{ boardId: h.board.id, issueNumber: c.issueNumber }])
      const audit = await prisma.auditEvent.findFirstOrThrow({ where: { kind: 'kanban_card_change' } })
      expect(audit.details).toMatchObject({ cardId: c.id, from: 'running', to, source: op })
      expect(h.store.issues.get(c.issueNumber)).toMatchObject({ labels: ['ac/status:running'], state: 'open' })
      const sync = new KanbanSync({
        repo: new PgKanbanSyncRepo(prisma),
        cards: new PgKanbanCardRepo(prisma),
        store: h.store,
        permissions: { permission: async () => 'write' as const },
        appSlug: 'agentconnect-test',
        repoRef: async () => ({ installationId: 77n, repoId: REPO_ID, repoFullName: 'acme/web' }),
        revoke: async () => {},
        promote: async () => {},
        log: { warn: vi.fn() }
      })
      // The App wrote the running label, so the visible history reproduces the live labels and the repair may run.
      vi.spyOn(h.store, 'readLabelEvents').mockResolvedValue([
        {
          id: 1,
          event: 'labeled',
          label: { name: 'ac/status:running' },
          actor: { login: 'agentconnect-test[bot]', type: 'Bot' }
        }
      ] as never)
      await sync.reconcileBoard(h.board.id)
      expect(h.store.issues.get(c.issueNumber)).toMatchObject(
        op === 'skip'
          ? { labels: ['ac/status:archived'], state: 'closed', stateReason: 'not_planned' }
          : { labels: ['ac/status:ready'], state: 'open' }
      )
      expect(await h.card(c.id)).toMatchObject({ status: to, labelWritePending: false })
    }
  )
})

describe('416c: cross-lane, a PR from the daemon ac/card-<n> branch under the #415 binding (real Postgres)', () => {
  const pull = (issueNumber: number, createdAt: Date, over: Partial<LivePullRequest> = {}): LivePullRequest => ({
    number: 21,
    state: 'closed',
    merged: true,
    headSha: 'c'.repeat(40),
    authorLogin: 'agentconnect-test[bot]',
    authorType: 'Bot',
    headRef: kanbanCardBranch(issueNumber),
    headRepoId: REPO_ID,
    baseRef: 'main',
    defaultBranch: 'main',
    createdAt,
    mergedByLogin: 'alice',
    ...over
  })

  async function workedCard(h: Awaited<ReturnType<typeof harness>>) {
    const c = await h.addCard()
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    const d = h.sent.at(-1)!.d
    expect(d.cardId).toBe(c.id)
    expect((await h.dispatcher.onReport(D1, 4, h.reportFor(d, { prNumber: 21 }))).accepted).toBe(true)
    await h.dispatcher.settle()
    const card = await h.card(c.id)
    expect(card).toMatchObject({ status: 'review', linkedPrNumber: 21 })
    return { c, d, episode: card.workEpisodeStartedAt! }
  }

  const contracts = (h: Awaited<ReturnType<typeof harness>>, pr: () => LivePullRequest) =>
    new KanbanPrContracts({
      repo: h.repo,
      appSlug: 'agentconnect-test',
      prs: { readPullRequest: async () => pr(), readCheckRuns: async () => ({ runs: [], complete: true }) },
      store: h.store,
      repoRef: async () => ({ installationId: 77n, repoId: REPO_ID, repoFullName: 'acme/web' }),
      log: { info: vi.fn(), warn: vi.fn() }
    })

  it('416c: the binding accepts the App PR opened from ac/card-<n> after the work episode started', async () => {
    const h = await harness({ completionContract: 'pr_merged' })
    const { c, episode } = await workedCard(h)
    await contracts(h, () => pull(c.issueNumber, new Date(episode.getTime() + 1_000))).sweep(h.board.id)
    expect(await h.card(c.id)).toMatchObject({ status: 'done', needsAttention: false })
  })

  it.each([
    ['another card branch', (n: number) => ({ headRef: kanbanCardBranch(n + 1) })],
    ['a session branch', () => ({ headRef: 'ac/session-quiet-otter' })]
  ])('416c: the binding refuses %s', async (_name, over) => {
    const h = await harness({ completionContract: 'pr_merged' })
    const { c, episode } = await workedCard(h)
    await contracts(h, () => pull(c.issueNumber, new Date(episode.getTime() + 1_000), over(c.issueNumber))).sweep(
      h.board.id
    )
    expect(await h.card(c.id)).toMatchObject({ status: 'review', needsAttention: true, attentionReason: 'pr_unbound' })
  })

  it('416c: after a restart the card branch PR from the old episode no longer binds', async () => {
    const h = await harness({ completionContract: 'pr_merged' })
    const { c, episode } = await workedCard(h)
    const oldPr = pull(c.issueNumber, new Date(episode.getTime() + 1_000), { state: 'open', merged: false })
    h.clock.advance(60_000)
    // The restart re-arms the board, so its poke is the next claim.
    expect((await h.controls.restart(DEFAULT_ORG_ID, h.board.id, c.id, DEFAULT_OWNER_ID)).ok).toBe(true)
    await h.dispatcher.settle()
    const d = h.sent.at(-1)!.d
    expect(d).toMatchObject({ cardId: c.id, attempt: 2 })
    const next = (await h.card(c.id)).workEpisodeStartedAt!
    expect(next.getTime()).toBeGreaterThan(episode.getTime())
    expect((await h.dispatcher.onReport(D1, 4, h.reportFor(d, { prNumber: 21 }))).accepted).toBe(true)
    await h.dispatcher.settle()
    await contracts(h, () => ({ ...oldPr, state: 'closed', merged: true })).sweep(h.board.id)
    expect(await h.card(c.id)).toMatchObject({ status: 'review', needsAttention: true, attentionReason: 'pr_unbound' })
  })
})

describe('416c: a paused board keeps its sync and graph loops (real Postgres)', () => {
  it('416c: label sync adopts a human move and graph promotion runs while paused, but nothing is claimed until resume', async () => {
    const h = await harness()
    await h.controls.pause(DEFAULT_ORG_ID, h.board.id, DEFAULT_OWNER_ID)
    const human = await h.addCard(['ac/status:ready'], 'triage')
    const blocked = await h.addCard(['ac/status:todo'])
    await prisma.kanbanCard.update({ where: { id: blocked.id }, data: { status: 'todo' } })
    const bot = { login: 'agentconnect-test[bot]', type: 'Bot' }
    const alice = { login: 'alice', type: 'User', id: 1001 }
    vi.spyOn(h.store, 'readLabelEvents').mockImplementation(async (_repo, n) =>
      n === human.issueNumber
        ? ([
            { id: 1, event: 'labeled', label: { name: 'ac/status:triage' }, actor: bot },
            { id: 2, event: 'labeled', label: { name: 'ac/status:ready' }, actor: alice },
            { id: 3, event: 'unlabeled', label: { name: 'ac/status:triage' }, actor: alice }
          ] as never)
        : ([{ id: 1, event: 'labeled', label: { name: 'ac/status:todo' }, actor: bot }] as never)
    )
    const sync = new KanbanSync({
      repo: new PgKanbanSyncRepo(prisma),
      cards: new PgKanbanCardRepo(prisma),
      store: h.store,
      permissions: { permission: async () => 'write' as const },
      appSlug: 'agentconnect-test',
      repoRef: async () => ({ installationId: 77n, repoId: REPO_ID, repoFullName: 'acme/web' }),
      revoke: async () => {},
      promote: async () => {},
      log: { warn: vi.fn() }
    })
    await sync.onCardChanged(h.board.id, human.issueNumber, true)
    expect((await h.card(human.id)).status).toBe('ready')
    const reconciler = new KanbanGraphReconciler({
      cards: new PgKanbanCardRepo(prisma),
      store: h.store,
      agentSlug: async () => null,
      log: { debug: vi.fn() }
    })
    const doneBlocker = {
      issueId: 99n,
      number: 99,
      repoId: REPO_ID,
      state: 'closed' as const,
      stateReason: 'completed'
    }
    await reconciler.apply(
      { ...h.board, orgId: OrgId(DEFAULT_ORG_ID) },
      { installationId: 77n, repoId: REPO_ID, repoFullName: 'acme/web' },
      blocked.issueNumber,
      { parent: null, subIssues: [], blocking: [], truncated: false, blockedBy: [doneBlocker] }
    )
    expect((await h.card(blocked.id)).status).toBe('ready')

    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    expect(h.sent).toEqual([])
    const explained = await h.repo.explainBoard(h.board.id, { now: new Date(T0), isDaemonLive: () => true })
    expect(explained!.cards.map((c) => c.verdict)).toEqual([
      { eligible: false, gate: 'board_paused' },
      { eligible: false, gate: 'board_paused' }
    ])
    expect(explained!.wouldClaimNext).toEqual([])

    await h.controls.resume(DEFAULT_ORG_ID, h.board.id, DEFAULT_OWNER_ID)
    await h.dispatcher.settle()
    await h.dispatcher.reconcileBoard(h.board.id)
    await h.dispatcher.settle()
    expect(h.sent.map(({ d }) => d.cardId).sort()).toEqual([human.id, blocked.id].sort())
  })
})

describe('416r2: controls on an unpaused board race the dispatcher (real Postgres)', () => {
  it('416r2: restart on an UNPAUSED board survives a claim/reconcile racing the GitHub write', async () => {
    const h = await harness()
    const c = await h.addCard(['ac/status:done'], 'running')
    await prisma.kanbanCard.update({ where: { id: c.id }, data: { status: 'done' } })
    Object.assign(h.store.issues.get(c.issueNumber)!, { state: 'closed', stateReason: 'completed' })
    const restartCard = PgKanbanCardRepo.prototype.restartCard
    let race: Promise<void> | undefined
    vi.spyOn(PgKanbanCardRepo.prototype, 'restartCard').mockImplementation(async function (
      this: PgKanbanCardRepo,
      input
    ) {
      const result = await restartCard.call(this, input)
      // The committed card is claimable now; the cap only keeps a gated claim from hanging the control.
      race = h.dispatcher.reconcileBoard(h.board.id)
      await Promise.race([race, new Promise((resolve) => setTimeout(resolve, 1_500))])
      return result
    })
    expect((await h.controls.restart(DEFAULT_ORG_ID, h.board.id, c.id, DEFAULT_OWNER_ID)).ok).toBe(true)
    await race
    await h.dispatcher.settle()
    expect(h.sent.map(({ d }) => d.cardId)).toEqual([c.id])
    expect((await h.card(c.id)).status).toBe('running')
    expect(h.store.issues.get(c.issueNumber)).toMatchObject({ state: 'open', labels: ['ac/status:running'] })
  })

  it("416r2: skip's GitHub write is ordered after the dispatcher's in-flight label write for the card", async () => {
    const h = await harness()
    const c = await h.addCard()
    let land!: () => void
    const held = new Promise<void>((resolve) => (land = resolve))
    const apply = h.store.applyPlan.bind(h.store)
    vi.spyOn(h.store, 'applyPlan').mockImplementation(async (repo, n, observed, plan, onLabelAdded) => {
      if (plan.status === 'running') await held
      return apply(repo, n, observed, plan, onLabelAdded)
    })
    await h.dispatcher.reconcileBoard(h.board.id)
    expect(h.sent.map(({ d }) => d.cardId)).toEqual([c.id])
    const skipped = h.controls.skip(DEFAULT_ORG_ID, h.board.id, c.id, DEFAULT_OWNER_ID)
    await new Promise((resolve) => setTimeout(resolve, 300))
    land()
    expect((await skipped).ok).toBe(true)
    await h.dispatcher.settle()
    expect((await h.card(c.id)).status).toBe('archived')
    expect(h.store.issues.get(c.issueNumber)).toMatchObject({
      state: 'closed',
      stateReason: 'not_planned',
      labels: ['ac/status:archived']
    })
  })

  it('416r2: skip clears an open promotion intent', async () => {
    const h = await harness()
    const c = await h.addCard(['ac/status:todo'])
    await prisma.kanbanCard.update({
      where: { id: c.id },
      data: {
        status: 'todo',
        promotionPending: true,
        promotionPostAccepted: true,
        promotionStartedAt: new Date(T0),
        promotionChecks: 2
      }
    })
    expect((await h.controls.skip(DEFAULT_ORG_ID, h.board.id, c.id, DEFAULT_OWNER_ID)).ok).toBe(true)
    expect(await h.card(c.id)).toMatchObject({
      status: 'archived',
      promotionPending: false,
      promotionPostAccepted: false,
      promotionStartedAt: null,
      promotionChecks: 0
    })
  })

  it('416r2: restart names the pull request linked to the earlier work so it can be closed and replaced', async () => {
    const h = await harness()
    const c = await h.addCard(['ac/status:review'])
    await prisma.kanbanCard.update({
      where: { id: c.id },
      data: { status: 'review', linkedPrNumber: 21, workEpisodeStartedAt: new Date(T0 - 60_000) }
    })
    await h.controls.pause(DEFAULT_ORG_ID, h.board.id, DEFAULT_OWNER_ID)
    expect((await h.controls.restart(DEFAULT_ORG_ID, h.board.id, c.id, DEFAULT_OWNER_ID)).ok).toBe(true)
    expect(h.store.writes.at(-1)!.comment).toBe(
      `restarted via AgentConnect; pull request #21 from the earlier work can no longer complete this card, ` +
        `so close it if it is still open and open a new one from \`ac/card-${c.issueNumber}\``
    )
  })
})

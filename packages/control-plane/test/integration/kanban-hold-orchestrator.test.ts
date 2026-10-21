// #587 on real Postgres: an orchestrator move never lifts a human hold; only a human status move does.
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { KanbanOrchestrate } from '@agentconnect.md/protocol'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { OrgId } from '../../src/domain/ids.js'
import { KanbanOrchestrator } from '../../src/kanban/orchestrator.js'
import { planLabelReconcile, type KanbanStatus } from '../../src/kanban/card-state.js'
import type { CardIssue } from '../../src/kanban/card-store.js'
import { PgKanbanCardRepo } from '../../src/persistence/repositories/kanban.repo.js'
import { PgKanbanDispatchRepo } from '../../src/persistence/repositories/kanban-dispatch.repo.js'
import { PgKanbanOrchestratorRepo } from '../../src/persistence/repositories/kanban-orchestrator.repo.js'
import { PgKanbanSyncRepo } from '../../src/persistence/repositories/kanban-sync.repo.js'
import { acknowledgeKanbanProjection } from '../fixtures/kanban-projection.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { prisma } from '../setup.db.js'

const ORG = OrgId(DEFAULT_ORG_ID)
const NOW = new Date('2026-10-21T12:00:00.000Z')
const HOLD = { needsAttention: true, attentionReason: 'label_attribution_timeout' } as const

function fakeStore() {
  const issue = (number: number): CardIssue => ({
    issueId: BigInt(5_870_000 + number),
    nodeId: `I_${number}`,
    number,
    state: 'open',
    stateReason: null,
    labels: [],
    authorType: 'Bot',
    authorLogin: 'agentconnect[bot]'
  })
  return {
    readCard: vi.fn(async (_repo: unknown, n: number) => issue(n)),
    readGraph: vi.fn(async () => ({ parent: null, subIssues: [], blockedBy: [], blocking: [], truncated: false })),
    applyPlan: vi.fn(async () => {}),
    addSubIssue: vi.fn(async () => {}),
    addBlockedBy: vi.fn(async () => {}),
    removeBlockedBy: vi.fn(async () => {}),
    closeIssue: vi.fn(async (_repo: unknown, _issueNumber: number) => {})
  }
}

// The orchestrator and the worker sit on one live daemon; the board allows one child per epic.
async function setup() {
  const daemonId = randomUUID()
  const orchestratorId = randomUUID()
  const workerId = randomUUID()
  await seedDaemon(prisma, daemonId, { sessionEpoch: 1n })
  await seedAgent(prisma, orchestratorId, { daemonId, name: `orch-${orchestratorId.slice(0, 8)}` })
  await seedAgent(prisma, workerId, { daemonId, name: `work-${workerId.slice(0, 8)}` })
  const board = await prisma.kanbanBoard.create({
    data: {
      orgId: DEFAULT_ORG_ID,
      name: `hold-${orchestratorId.slice(0, 8)}`,
      repoId: 587n,
      repoFullName: 'acme/web',
      orchestratorAgentId: orchestratorId,
      epicMaxCards: 1
    }
  })
  const card = (issueNumber: number, status: KanbanStatus, data: Record<string, unknown> = {}) =>
    prisma.kanbanCard.create({
      data: {
        boardId: board.id,
        issueId: BigInt(5_870_000 + issueNumber),
        issueNumber,
        status,
        assigneeAgentId: workerId,
        ...data
      }
    })
  const store = fakeStore()
  const cards = new PgKanbanCardRepo(prisma)
  const svc = new KanbanOrchestrator({
    cards,
    orchestrator: new PgKanbanOrchestratorRepo(prisma),
    store,
    installations: {
      liveByOrgAndAccount: async () => ({ installationId: 1n, revokedAt: null, suspendedAt: null }) as never
    },
    appSlug: 'agentconnect'
  })
  const orchestrate = (req: Record<string, unknown>) =>
    svc.orchestrate(ORG, orchestratorId, { agentId: orchestratorId, boardId: board.id, ...req } as KanbanOrchestrate)
  const dispatch = new PgKanbanDispatchRepo(prisma)
  const claim = async () => (await dispatch.claim(board.id, { now: NOW, isDaemonLive: () => true })).leases
  const read = (id: string) => prisma.kanbanCard.findUniqueOrThrow({ where: { id } })
  const sync = new PgKanbanSyncRepo(prisma)
  // A human status label lands through the live sync apply path, the explicit hold release.
  const humanMove = async (issueNumber: number, to: KanbanStatus, cursor: bigint) => {
    const snapshot = (await sync.get(board.id, issueNumber))!
    const plan = planLabelReconcile(
      { status: snapshot.status, leased: snapshot.lease !== null },
      { state: 'open', labels: [`ac/status:${to}`] }
    )
    expect(plan).toMatchObject({ outcome: 'accepted', status: to })
    return sync.apply(snapshot, plan, cursor, true, 0n, { login: 'octocat', id: 1 })
  }
  return { board, workerId, card, store, cards, orchestrate, claim, read, humanMove }
}

describe('#587: a human hold survives orchestrator moves (Postgres)', () => {
  it('#587: casStatus refuses a held card, so it never gets a work lease (the scratch repro)', async () => {
    const h = await setup()
    const c = await h.card(10, 'todo', HOLD)
    expect(await h.cards.casStatus(c.id, c.stateRevision, 'ready')).toBe(false)
    expect(await h.read(c.id)).toMatchObject({ status: 'todo', ...HOLD, stateRevision: c.stateRevision })
    await acknowledgeKanbanProjection(c.id)
    expect(await h.claim()).toEqual([])
    expect(await prisma.kanbanRun.count({ where: { cardId: c.id } })).toBe(0)
  })

  it('#587: an orchestrator unblock leaves a held blocked card blocked, held and unclaimable', async () => {
    const h = await setup()
    const c = await h.card(11, 'blocked', HOLD)
    expect(await h.orchestrate({ op: 'unblock', issueNumber: 11 })).toEqual({
      ok: true,
      op: 'unblock',
      status: 'blocked'
    })
    expect(await h.read(c.id)).toMatchObject({ status: 'blocked', ...HOLD, stateRevision: c.stateRevision })
    expect(h.store.applyPlan).not.toHaveBeenCalled()
    // The graph reconciler cannot promote it past the hold either.
    expect(await h.cards.beginPromotion(c.id, c.stateRevision, 1n, NOW)).toBe(false)
    expect(await h.claim()).toEqual([])
  })

  it('#587: the epic-budget triage fallback refuses but never moves a held epic', async () => {
    const h = await setup()
    const epic = await h.card(1, 'todo', HOLD)
    const create = (step: string, issueNumber?: number) =>
      h.orchestrate({
        op: issueNumber === undefined ? 'prepare_create' : 'commit_create',
        epicIssueNumber: 1,
        step,
        specDigest: 'd'.repeat(64),
        ...(issueNumber !== undefined ? { issueNumber } : {})
      })
    expect(await create('first', 20)).toMatchObject({ ok: true, op: 'commit_create', issueNumber: 20 })
    expect(await create('second')).toEqual({ ok: false, op: 'prepare_create', code: 'epic_budget_exhausted' })
    expect(await h.read(epic.id)).toMatchObject({ status: 'todo', ...HOLD })
  })

  it('#587: a human status move still lifts the hold, and the card becomes claimable', async () => {
    const h = await setup()
    const c = await h.card(12, 'blocked', HOLD)
    expect(await h.orchestrate({ op: 'unblock', issueNumber: 12 })).toMatchObject({ status: 'blocked' })
    expect(await h.humanMove(12, 'ready', 10n)).toMatchObject({ changed: true })
    expect(await h.read(c.id)).toMatchObject({ status: 'ready', needsAttention: false, attentionReason: null })
    expect(await h.claim()).toMatchObject([{ cardId: c.id, role: 'work', agentId: h.workerId }])
  })
})

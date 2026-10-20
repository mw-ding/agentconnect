// Parent synthesis through an issues-close doorbell uses real CAS writes and preserves negative graph cases.
import { describe, expect, it, vi } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { KanbanGraphDoorbell } from '../../src/kanban/graph-doorbell.js'
import { KanbanGraphReconciler } from '../../src/kanban/graph-reconciler.js'
import { PgKanbanBoardRepo, PgKanbanCardRepo } from '../../src/persistence/repositories/kanban.repo.js'
import type { CardGraph, CardIssue, KanbanRepoRef, LabelWriteObserver } from '../../src/kanban/card-store.js'
import type { LabelPlan, ObservedIssue } from '../../src/kanban/card-state.js'

const AGENT = 'a1111111-1111-4111-8111-111111111111'
const DAEMON = 'd1111111-1111-4111-8111-111111111111'
const empty = (): CardGraph => ({ parent: null, subIssues: [], blockedBy: [], blocking: [], truncated: false })

async function harness() {
  await seedDaemon(prisma, DAEMON)
  await seedAgent(prisma, AGENT, { daemonId: DAEMON, name: 'synthesizer' })
  const board = await prisma.kanbanBoard.create({
    data: {
      orgId: DEFAULT_ORG_ID,
      name: 'synthesis',
      repoId: 42n,
      repoFullName: 'acme/web',
      synthesizerAgentId: AGENT,
      targetPlatform: 'slack',
      targetChannel: 'FAKE-ONLY'
    }
  })
  const epic = await prisma.kanbanCard.create({
    data: { boardId: board.id, issueId: 1n, issueNumber: 1, status: 'todo' }
  })
  const graphs = new Map<number, CardGraph>([
    [
      1,
      {
        ...empty(),
        subIssues: [2, 3].map((number) => ({
          issueId: BigInt(number),
          number,
          repoId: 42n,
          state: 'closed',
          stateReason: 'completed'
        }))
      }
    ],
    [2, { ...empty(), parent: { issueId: 1n, number: 1, repoId: 42n, state: 'open', stateReason: null } }]
  ])
  let labels = ['ac/status:todo', 'ac/agent:previous', 'keep-me']
  const writes: LabelPlan[] = []
  const store = {
    readGraph: async (_repo: KanbanRepoRef, n: number) => graphs.get(n) ?? empty(),
    readCard: async (_repo: KanbanRepoRef, n: number): Promise<CardIssue | null> =>
      n === 1 ? { issueId: 1n, nodeId: 'I_1', number: 1, labels, state: 'open', stateReason: null } : null,
    lastEventId: async () => 41,
    applyPlan: async (
      _repo: KanbanRepoRef,
      _n: number,
      _observed: ObservedIssue,
      plan: LabelPlan,
      observer?: LabelWriteObserver
    ) => {
      writes.push(plan)
      for (const label of plan.addLabels) await observer?.(label)
      labels = [...labels.filter((l) => !plan.removeLabels.includes(l)), ...plan.addLabels]
    }
  }
  const log = { debug: vi.fn(), warn: vi.fn() }
  const reconciler = new KanbanGraphReconciler({
    cards: new PgKanbanCardRepo(prisma),
    store,
    agentSlug: async (orgId, id) =>
      (await prisma.agent.findFirst({ where: { orgId, id }, select: { name: true } }))?.name ?? null,
    log
  })
  const bell = new KanbanGraphDoorbell({
    boards: new PgKanbanBoardRepo(prisma),
    installations: {
      getByInstallationId: async () =>
        ({ orgId: board.orgId, installationId: 77n, revokedAt: null, suspendedAt: null }) as never
    },
    store,
    onCard: async (b, repo, n, doorbell) => {
      if (doorbell.action === 'closed' || doorbell.action === 'reopened')
        await reconciler.apply(b, repo, n, await store.readGraph(repo, n))
    },
    log
  })
  const ring = async (key = 'close-1') => {
    bell.poke({
      deliveryKey: key,
      installationId: '77',
      repoId: '42',
      event: 'issues',
      action: 'closed',
      ids: ['2'],
      numbers: [2]
    })
    await bell.settle()
    expect(log.warn).not.toHaveBeenCalled()
    expect(bell.landedDeliveryKeys([key])).toEqual(new Set([key]))
  }
  return {
    board,
    epic,
    graphs,
    ring,
    writes,
    labels: () => labels,
    row: () => prisma.kanbanCard.findUniqueOrThrow({ where: { id: epic.id } })
  }
}

describe('synthesizer parent re-evaluation (real Postgres)', () => {
  it('416c: promotes and assigns the parent on sub-issue close, replaces the agent label, and is idempotent', async () => {
    const h = await harness()
    await h.ring()
    expect(await h.row()).toMatchObject({
      status: 'ready',
      assigneeAgentId: AGENT,
      stateRevision: 2n,
      promotionPending: false
    })
    expect(h.labels().sort()).toEqual(['ac/agent:synthesizer', 'ac/status:ready', 'keep-me'])
    await h.ring('close-2')
    expect(h.writes).toHaveLength(1)
    expect((await h.row()).stateRevision).toBe(2n)
  })

  it.each(['not_planned', 'open', 'truncated', 'no_synthesizer', 'already_ready'] as const)(
    '416c: does not promote on %s',
    async (reason) => {
      const h = await harness()
      const graph = h.graphs.get(1)!
      if (reason === 'not_planned') graph.subIssues[0]!.stateReason = 'not_planned'
      if (reason === 'open') {
        graph.subIssues[0]!.state = 'open'
        graph.subIssues[0]!.stateReason = null
      }
      if (reason === 'truncated') graph.truncated = true
      if (reason === 'no_synthesizer')
        await prisma.kanbanBoard.update({ where: { id: h.board.id }, data: { synthesizerAgentId: null } })
      if (reason === 'already_ready')
        await prisma.kanbanCard.update({ where: { id: h.epic.id }, data: { status: 'ready' } })
      await h.ring()
      expect(await h.row()).toMatchObject({
        status: reason === 'already_ready' ? 'ready' : 'todo',
        assigneeAgentId: null,
        stateRevision: 1n
      })
      expect(h.writes).toEqual([])
    }
  )
})

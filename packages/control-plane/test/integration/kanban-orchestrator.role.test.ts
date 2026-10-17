// Orchestrator repo role gate + list (issue #2 M3): the board is only visible to its own org and its orchestrator.
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { PgKanbanOrchestratorRepo } from '../../src/persistence/repositories/kanban-orchestrator.repo.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { prisma } from '../setup.db.js'

const REPO_ID = 990003n

describe('PgKanbanOrchestratorRepo role gate (real Postgres)', () => {
  it('returns board_not_found for an unknown or other-org board, never leaking it', async () => {
    const repo = new PgKanbanOrchestratorRepo(prisma)
    const agentId = randomUUID()
    const otherAgent = randomUUID()
    await seedAgent(prisma, otherAgent, { name: `orchestrator-${otherAgent}` })
    const other = await prisma.kanbanBoard.create({
      data: {
        orgId: DEFAULT_ORG_ID,
        name: 'other',
        repoId: REPO_ID,
        repoFullName: 'acme/web',
        orchestratorAgentId: otherAgent
      }
    })
    expect(await repo.boardForOrchestrator(agentId, DEFAULT_ORG_ID, other.id)).toEqual({
      ok: false,
      reason: 'not_orchestrator'
    })
    expect(await repo.boardForOrchestrator(agentId, DEFAULT_ORG_ID, randomUUID())).toEqual({
      ok: false,
      reason: 'board_not_found'
    })
    // A board in another org is indistinguishable from a missing one.
    const otherOrg = await prisma.org.create({ data: { id: 'org-b', name: 'b', slug: 'b' } })
    const foreign = await prisma.kanbanBoard.create({
      data: { orgId: otherOrg.id, name: 'foreign', repoId: REPO_ID + 1n, repoFullName: 'acme/secret' }
    })
    expect(await repo.boardForOrchestrator(agentId, DEFAULT_ORG_ID, foreign.id)).toEqual({
      ok: false,
      reason: 'board_not_found'
    })
  })

  it('returns board_disabled for a disabled board and the board for its orchestrator', async () => {
    const repo = new PgKanbanOrchestratorRepo(prisma)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { name: `orchestrator-${agentId}` })
    const board = await prisma.kanbanBoard.create({
      data: {
        orgId: DEFAULT_ORG_ID,
        name: 'mine',
        repoId: REPO_ID,
        repoFullName: 'acme/web',
        orchestratorAgentId: agentId,
        epicMaxCards: 5
      }
    })
    const gate = await repo.boardForOrchestrator(agentId, DEFAULT_ORG_ID, board.id)
    expect(gate).toMatchObject({ ok: true, board: { id: board.id, repoId: REPO_ID, epicMaxCards: 5 } })
    await prisma.kanbanBoard.update({ where: { id: board.id }, data: { enabled: false } })
    expect(await repo.boardForOrchestrator(agentId, DEFAULT_ORG_ID, board.id)).toEqual({
      ok: false,
      reason: 'board_disabled'
    })
  })

  it('lists only the boards this agent orchestrates, with card facts', async () => {
    const daemonId = randomUUID()
    const agentId = randomUUID()
    const workerId = randomUUID()
    await seedDaemon(prisma, daemonId, { sessionEpoch: 1n })
    await seedAgent(prisma, agentId, { daemonId })
    await seedAgent(prisma, workerId, { daemonId, name: 'worker' })
    const board = await prisma.kanbanBoard.create({
      data: {
        orgId: DEFAULT_ORG_ID,
        name: 'mine',
        repoId: REPO_ID,
        repoFullName: 'acme/web',
        orchestratorAgentId: agentId,
        epicMaxCards: 10
      }
    })
    const epic = await prisma.kanbanCard.create({
      data: { boardId: board.id, issueId: 9_100n, issueNumber: 1, status: 'todo' }
    })
    await prisma.kanbanCard.create({
      data: {
        boardId: board.id,
        issueId: 9_101n,
        issueNumber: 2,
        status: 'todo',
        assigneeAgentId: workerId,
        epicCardId: epic.id,
        priority: 3
      }
    })
    const repo = new PgKanbanOrchestratorRepo(prisma)
    const { truncated, boards } = await repo.orchestratorBoards(agentId, undefined, undefined, 200)
    expect(truncated).toBe(false)
    expect(boards).toHaveLength(1)
    expect(boards[0]!.repoFullName).toBe('acme/web')
    expect(boards[0]!.cards).toHaveLength(2)
    const child = boards[0]!.cards.find((c) => c.issueNumber === 2)!
    expect(child).toMatchObject({ assigneeSlug: 'worker', epicIssueNumber: 1, priority: 3, leased: false })
    // Another agent orchestrates nothing.
    expect((await repo.orchestratorBoards(randomUUID(), undefined, undefined, 200)).boards).toEqual([])
  })

  it('resolves an assignee slug into unknown_agent / agent_not_assignable / an agent id', async () => {
    const repo = new PgKanbanOrchestratorRepo(prisma)
    expect(await repo.resolveAssignee(DEFAULT_ORG_ID, 'missing')).toEqual({ ok: false, reason: 'unknown_agent' })
    const restricted = randomUUID()
    await seedAgent(prisma, restricted, { visibility: 'restricted', sharedWith: ['member-1'] })
    expect(await repo.resolveAssignee(DEFAULT_ORG_ID, `agent-${restricted}`)).toEqual({
      ok: false,
      reason: 'agent_not_assignable'
    })
    const ok = randomUUID()
    await seedAgent(prisma, ok, { name: 'available' })
    expect(await repo.resolveAssignee(DEFAULT_ORG_ID, 'available')).toEqual({ ok: true, agentId: ok })
  })
})

// B2 epic-budget repo tests (issue #2 M3): the epic card's row lock is the mutex, so a concurrent create at the
// budget boundary admits exactly the remaining room and a same-key race yields exactly one card.
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { PgKanbanCardRepo } from '../../src/persistence/repositories/kanban.repo.js'
import { PgKanbanOrchestratorRepo } from '../../src/persistence/repositories/kanban-orchestrator.repo.js'
import { prisma } from '../setup.db.js'

const REPO_ID = 990001n
const issueId = (n: number) => BigInt(9_000_000 + n)
const key = (step: string) => step

function upsert(boardId: string, issueNumber: number, step: string) {
  return {
    boardId,
    expectedRepoId: REPO_ID,
    issueId: issueId(issueNumber),
    issueNumber,
    idempotencyKey: key(step),
    status: 'todo' as const,
    source: 'orchestrator' as const,
    actorAgentId: randomUUID()
  }
}

describe('PgKanbanOrchestratorRepo (B2 epic budgets)', () => {
  it('files a top-level card and an epic child, linking and counting', async () => {
    const board = await prisma.kanbanBoard.create({
      data: { orgId: DEFAULT_ORG_ID, name: 'b2-1', repoId: REPO_ID, repoFullName: 'acme/web', epicMaxCards: 10 }
    })
    const repo = new PgKanbanOrchestratorRepo(prisma)

    const top = await repo.createEpicChild({ boardId: board.id, upsert: upsert(board.id, 1, 'top') })
    expect(top).toMatchObject({ ok: true, created: true, matchedBy: 'created' })
    const topCard = await prisma.kanbanCard.findUniqueOrThrow({ where: { id: top.ok ? top.card.id : '' } })
    expect(topCard.epicCardId).toBeNull()

    const child = await repo.createEpicChild({
      boardId: board.id,
      epicIssueNumber: 1,
      upsert: upsert(board.id, 2, 'c1')
    })
    expect(child).toMatchObject({ ok: true, created: true })
    const childCard = await prisma.kanbanCard.findUniqueOrThrow({
      where: { id: child.ok ? child.card.id : '' }
    })
    expect(childCard.epicCardId).toBe(topCard.id)
    expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: topCard.id } })).epicCardsCreated).toBe(1)

    // Replaying the same key returns the same card and counts nothing new.
    const replay = await repo.createEpicChild({
      boardId: board.id,
      epicIssueNumber: 1,
      upsert: upsert(board.id, 3, 'c1')
    })
    expect(replay).toMatchObject({ ok: true, created: false, matchedBy: 'idempotency_key' })
    expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: topCard.id } })).epicCardsCreated).toBe(1)
  })

  it('refuses an unknown epic with epic_not_found', async () => {
    const board = await prisma.kanbanBoard.create({
      data: { orgId: DEFAULT_ORG_ID, name: 'b2-2', repoId: REPO_ID, repoFullName: 'acme/web' }
    })
    const repo = new PgKanbanOrchestratorRepo(prisma)
    const result = await repo.createEpicChild({
      boardId: board.id,
      epicIssueNumber: 424242,
      upsert: upsert(board.id, 1, 'x')
    })
    expect(result).toEqual({ ok: false, reason: 'epic_not_found' })
    expect(await prisma.kanbanCard.count({ where: { boardId: board.id } })).toBe(0)
  })

  it('admits exactly the remaining budget across concurrent creates at the boundary', async () => {
    const board = await prisma.kanbanBoard.create({
      data: { orgId: DEFAULT_ORG_ID, name: 'b2-3', repoId: REPO_ID, repoFullName: 'acme/web', epicMaxCards: 2 }
    })
    const cards = new PgKanbanCardRepo(prisma)
    const epic = await cards.upsertCard({ ...upsert(board.id, 100, 'epic'), idempotencyKey: key('epic') })
    const repo = new PgKanbanOrchestratorRepo(prisma)

    const attempts = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        repo.createEpicChild({
          boardId: board.id,
          epicIssueNumber: 100,
          upsert: upsert(board.id, 200 + i, `child-${i}`)
        })
      )
    )
    const created = attempts.filter((r) => r.ok && r.created)
    const refused = attempts.filter((r) => !r.ok)
    expect(created).toHaveLength(2)
    expect(refused).toHaveLength(3)
    for (const r of refused) expect(r).toEqual({ ok: false, reason: 'epic_budget_exhausted' })
    expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: epic.card.id } })).epicCardsCreated).toBe(2)
  })

  it('concurrent same-key commits yield exactly one card', async () => {
    const board = await prisma.kanbanBoard.create({
      data: { orgId: DEFAULT_ORG_ID, name: 'b2-4', repoId: REPO_ID, repoFullName: 'acme/web', epicMaxCards: 10 }
    })
    const repo = new PgKanbanOrchestratorRepo(prisma)
    const same = upsert(board.id, 300, 'same-key')
    const attempts = await Promise.all(
      Array.from({ length: 4 }, () => repo.createEpicChild({ boardId: board.id, upsert: { ...same } }))
    )
    const created = attempts.filter((r) => r.ok && r.created)
    expect(created).toHaveLength(1)
    expect(attempts.every((r) => r.ok)).toBe(true)
    expect(await prisma.kanbanCard.count({ where: { boardId: board.id, issueNumber: 300 } })).toBe(1)
  })

  it('adoptEpic links an existing card under an epic, counting against B2', async () => {
    const board = await prisma.kanbanBoard.create({
      data: { orgId: DEFAULT_ORG_ID, name: 'b2-5', repoId: REPO_ID, repoFullName: 'acme/web', epicMaxCards: 1 }
    })
    const cards = new PgKanbanCardRepo(prisma)
    const repo = new PgKanbanOrchestratorRepo(prisma)
    const epic = await cards.upsertCard({ ...upsert(board.id, 400, 'epic'), idempotencyKey: key('epic2') })
    const child = await cards.upsertCard({ ...upsert(board.id, 401, 'adopt') })
    const adopted = await repo.adoptEpic({ cardId: child.card.id, epicIssueNumber: 400 })
    expect(adopted).toMatchObject({ ok: true, changed: true })
    expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: child.card.id } })).epicCardId).toBe(epic.card.id)

    // A second child exceeds the budget.
    const child2 = await cards.upsertCard({ ...upsert(board.id, 402, 'adopt2') })
    expect(await repo.adoptEpic({ cardId: child2.card.id, epicIssueNumber: 400 })).toEqual({
      ok: false,
      reason: 'epic_budget_exhausted'
    })
    // Re-adopting the same epic is a no-op that counts nothing new.
    expect(await repo.adoptEpic({ cardId: child.card.id, epicIssueNumber: 400 })).toMatchObject({
      ok: true,
      changed: false
    })
    expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: epic.card.id } })).epicCardsCreated).toBe(1)
  })
})

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
  it('a replay on a full epic returns the existing card; only an actual create is refused and rolled back', async () => {
    const board = await prisma.kanbanBoard.create({
      data: { orgId: DEFAULT_ORG_ID, name: 'b2-r1', repoId: REPO_ID, repoFullName: 'acme/web', epicMaxCards: 1 }
    })
    const cards = new PgKanbanCardRepo(prisma)
    const repo = new PgKanbanOrchestratorRepo(prisma)
    const epic = await cards.upsertCard({ ...upsert(board.id, 500, 'epic-r1') })
    const first = await repo.createEpicChild({
      boardId: board.id,
      epicIssueNumber: 500,
      upsert: upsert(board.id, 501, 'r1')
    })
    expect(first).toMatchObject({ ok: true, created: true })
    // The epic is now full; the same key (any issue) and the same issue (no key) both come back ok.
    const byKey = await repo.createEpicChild({
      boardId: board.id,
      epicIssueNumber: 500,
      upsert: upsert(board.id, 502, 'r1')
    })
    expect(byKey).toMatchObject({ ok: true, created: false, matchedBy: 'idempotency_key' })
    const byIssue = await repo.createEpicChild({
      boardId: board.id,
      epicIssueNumber: 500,
      upsert: { ...upsert(board.id, 501, 'r1'), idempotencyKey: null }
    })
    expect(byIssue).toMatchObject({ ok: true, created: false, matchedBy: 'issue' })
    // A real create on the full epic rolls back to the savepoint: no card and no created-audit row survive.
    const audits = await prisma.auditEvent.count({ where: { kind: 'kanban_card_change' } })
    const over = await repo.createEpicChild({
      boardId: board.id,
      epicIssueNumber: 500,
      upsert: upsert(board.id, 503, 'r1-new')
    })
    expect(over).toEqual({ ok: false, reason: 'epic_budget_exhausted' })
    expect(await prisma.kanbanCard.count({ where: { boardId: board.id, issueNumber: 503 } })).toBe(0)
    expect(await prisma.auditEvent.count({ where: { kind: 'kanban_card_change' } })).toBe(audits)
    expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: epic.card.id } })).epicCardsCreated).toBe(1)
    // A top-level create on the same board is unaffected by the epic's budget.
    expect(await repo.createEpicChild({ boardId: board.id, upsert: upsert(board.id, 504, 'top-r1') })).toMatchObject({
      ok: true,
      created: true
    })
  })

  it('an upsert error inside createEpicChild leaves the ambient transaction usable', async () => {
    const board = await prisma.kanbanBoard.create({
      data: { orgId: DEFAULT_ORG_ID, name: 'b2-err', repoId: REPO_ID, repoFullName: 'acme/web' }
    })
    const repo = new PgKanbanOrchestratorRepo(prisma)
    await expect(
      repo.createEpicChild({ boardId: board.id, upsert: { ...upsert(board.id, 1, 'err'), expectedRepoId: 1n } })
    ).rejects.toMatchObject({ name: 'KanbanCardUpsertError', code: 'repo_mismatch' })
    expect(await prisma.kanbanCard.count({ where: { boardId: board.id } })).toBe(0)
  })

  it('adoptEpic refuses a self-parent, a cycle, a re-parent, and a chain past the depth bound', async () => {
    const board = await prisma.kanbanBoard.create({
      data: { orgId: DEFAULT_ORG_ID, name: 'b2-r4', repoId: REPO_ID, repoFullName: 'acme/web', epicMaxCards: 100 }
    })
    const cards = new PgKanbanCardRepo(prisma)
    const repo = new PgKanbanOrchestratorRepo(prisma)
    const mk = async (n: number) => (await cards.upsertCard({ ...upsert(board.id, n, `r4-${n}`) })).card
    const a = await mk(601)
    const b = await mk(602)
    const c = await mk(603)
    expect(await repo.adoptEpic({ cardId: a.id, epicIssueNumber: 601 })).toEqual({ ok: false, reason: 'invalid_link' })
    // b under a, c under b; then a under c would close a three-card cycle.
    expect(await repo.adoptEpic({ cardId: b.id, epicIssueNumber: 601 })).toMatchObject({ ok: true, changed: true })
    expect(await repo.adoptEpic({ cardId: c.id, epicIssueNumber: 602 })).toMatchObject({ ok: true, changed: true })
    expect(await repo.adoptEpic({ cardId: a.id, epicIssueNumber: 603 })).toEqual({ ok: false, reason: 'invalid_link' })
    // Re-parenting a card that already has an epic is refused, not moved.
    const d = await mk(604)
    expect(await repo.adoptEpic({ cardId: c.id, epicIssueNumber: 604 })).toEqual({ ok: false, reason: 'invalid_link' })
    expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: c.id } })).epicCardId).toBe(b.id)
    expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: d.id } })).epicCardsCreated).toBe(0)
    // A chain deeper than 32 hops is refused as if it cycled.
    let parent = await mk(700)
    for (let i = 1; i <= 33; i++) {
      const next = await mk(700 + i)
      await prisma.kanbanCard.update({ where: { id: next.id }, data: { epicCardId: parent.id } })
      parent = next
    }
    const loose = await mk(800)
    expect(await repo.adoptEpic({ cardId: loose.id, epicIssueNumber: 733 })).toEqual({
      ok: false,
      reason: 'invalid_link'
    })
    expect(await repo.adoptEpic({ cardId: loose.id, epicIssueNumber: 710 })).toMatchObject({ ok: true })
  })

  it('opposite concurrent adopts serialize on the board lock: exactly one wins, no deadlock', async () => {
    const board = await prisma.kanbanBoard.create({
      data: { orgId: DEFAULT_ORG_ID, name: 'b2-r4c', repoId: REPO_ID, repoFullName: 'acme/web', epicMaxCards: 100 }
    })
    const cards = new PgKanbanCardRepo(prisma)
    const repo = new PgKanbanOrchestratorRepo(prisma)
    const a = (await cards.upsertCard({ ...upsert(board.id, 901, 'c-a') })).card
    const b = (await cards.upsertCard({ ...upsert(board.id, 902, 'c-b') })).card
    for (let round = 0; round < 5; round++) {
      await prisma.kanbanCard.updateMany({ where: { boardId: board.id }, data: { epicCardId: null } })
      const results = await Promise.all([
        repo.adoptEpic({ cardId: a.id, epicIssueNumber: 902 }),
        repo.adoptEpic({ cardId: b.id, epicIssueNumber: 901 })
      ])
      expect(results.filter((r) => r.ok)).toHaveLength(1)
      expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'invalid_link' }])
    }
  })
})

// Mode updates and their audit records commit together, including concurrent owner edits.
import { describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { PgKanbanBoardRepo } from '../../src/persistence/repositories/kanban.repo.js'
import type { PrismaLike } from '../../src/persistence/prisma.js'

async function fixture() {
  const board = await prisma.kanbanBoard.create({
    data: { orgId: DEFAULT_ORG_ID, name: 'eng', repoId: 4242n, repoFullName: 'acme/web' }
  })
  const card = await prisma.kanbanCard.create({ data: { boardId: board.id, issueId: 1n, issueNumber: 1 } })
  return { board, card }
}

describe('Kanban mode audit transactions (real Postgres)', () => {
  it.each(['board', 'card'] as const)('rolls back the %s mode update if its audit insert fails', async (target) => {
    const { board, card } = await fixture()
    const db = prisma.$extends({
      query: {
        auditEvent: {
          create: async () => {
            throw new Error('audit insert failed')
          }
        }
      }
    })
    // The query extension retains transactions but omits the root client's $on type.
    const repo = new PgKanbanBoardRepo(db as PrismaLike)
    const update =
      target === 'board'
        ? repo.setDefaultMode(DEFAULT_ORG_ID, board.id, DEFAULT_OWNER_ID, 'write')
        : repo.setCardMode(DEFAULT_ORG_ID, board.id, card.id, DEFAULT_OWNER_ID, 'write')
    await expect(update).rejects.toThrow('audit insert failed')
    expect(await prisma.kanbanBoard.findUniqueOrThrow({ where: { id: board.id } })).toMatchObject({
      defaultMode: board.defaultMode,
      configRevision: board.configRevision,
      lastModifiedByUserId: board.lastModifiedByUserId
    })
    expect(await prisma.kanbanCard.findUniqueOrThrow({ where: { id: card.id } })).toMatchObject({
      mode: card.mode,
      modeRevision: card.modeRevision,
      stateRevision: card.stateRevision
    })
    expect(await prisma.auditEvent.count({ where: { kind: 'kanban_mode_change' } })).toBe(0)
  })

  it.each(['board', 'card'] as const)('records the actual previous %s mode during concurrent edits', async (target) => {
    const { board, card } = await fixture()
    const repo = new PgKanbanBoardRepo(prisma)
    const results = await Promise.all(
      (['write', 'read', 'write'] as const).map((mode) =>
        target === 'board'
          ? repo.setDefaultMode(DEFAULT_ORG_ID, board.id, DEFAULT_OWNER_ID, mode)
          : repo.setCardMode(DEFAULT_ORG_ID, board.id, card.id, DEFAULT_OWNER_ID, mode)
      )
    )
    expect(results).toEqual([true, true, true])
    const events = await prisma.auditEvent.findMany({
      where: { orgId: DEFAULT_ORG_ID, kind: 'kanban_mode_change' },
      orderBy: { id: 'asc' }
    })
    expect(events).toHaveLength(3)
    let previous: string | null = target === 'board' ? board.defaultMode : card.mode
    for (const event of events) {
      expect(event).toMatchObject({
        actorUserId: DEFAULT_OWNER_ID,
        details: { boardId: board.id, ...(target === 'card' ? { cardId: card.id } : {}), oldMode: previous }
      })
      previous = (event.details as { newMode: string }).newMode
    }
    if (target === 'board') {
      expect(await prisma.kanbanBoard.findUniqueOrThrow({ where: { id: board.id } })).toMatchObject({
        defaultMode: previous,
        configRevision: board.configRevision + 3n
      })
    } else {
      expect(await prisma.kanbanCard.findUniqueOrThrow({ where: { id: card.id } })).toMatchObject({
        mode: previous,
        modeRevision: 3,
        stateRevision: card.stateRevision
      })
    }
  })
})

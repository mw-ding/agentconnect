// Kanban orchestrator repo (issue #2 M3, Lane 2b): B2 epic budgets, checked under the epic card's row lock so a
// concurrent create at the budget boundary admits exactly the remaining room, and the create/upsert composes in one tx.
import { Prisma } from '../../generated/prisma/client.js'
import { withAmbientTx, type PrismaLike } from '../prisma.js'
import { isKanbanStatus } from '../../kanban/card-state.js'
import { PgKanbanCardRepo } from './kanban.repo.js'
import type {
  KanbanAdoptEpicInput,
  KanbanAdoptEpicResult,
  KanbanCardRow,
  KanbanEpicChildInput,
  KanbanEpicChildResult,
  KanbanOrchestratorRepo
} from '../ports.js'

const CARD_ROW_SELECT = {
  id: true,
  boardId: true,
  issueId: true,
  issueNumber: true,
  issueNodeId: true,
  idempotencyKey: true,
  status: true,
  assigneeAgentId: true,
  priority: true,
  mode: true,
  stateRevision: true,
  dispatchRevision: true,
  createdAt: true
} as const

interface EpicRow {
  id: string
  epicCardsCreated: number
  epicMaxCards: number
}

export class PgKanbanOrchestratorRepo implements KanbanOrchestratorRepo {
  constructor(private readonly db: PrismaLike) {}

  createEpicChild(input: KanbanEpicChildInput): Promise<KanbanEpicChildResult> {
    return withAmbientTx(this.db, async (tx) => {
      let epic: EpicRow | null = null
      if (input.epicIssueNumber !== undefined) {
        const locked = await this.lockEpic(tx, input.boardId, input.epicIssueNumber)
        if (locked === 'not_found') return { ok: false, reason: 'epic_not_found' }
        if (exhausted(locked)) return { ok: false, reason: 'epic_budget_exhausted' }
        epic = locked
      }
      // Composes under this tx: the outer transaction's boundary wins.
      const result = await new PgKanbanCardRepo(tx).upsertCard(input.upsert)
      if (result.created && epic) {
        await tx.kanbanCard.update({ where: { id: result.card.id }, data: { epicCardId: epic.id } })
        await tx.kanbanCard.update({ where: { id: epic.id }, data: { epicCardsCreated: { increment: 1 } } })
      }
      return { ok: true, card: result.card, created: result.created, matchedBy: result.matchedBy }
    })
  }

  adoptEpic(input: KanbanAdoptEpicInput): Promise<KanbanAdoptEpicResult> {
    return withAmbientTx(this.db, async (tx) => {
      const [card] = await tx.$queryRaw<Array<{ id: string; boardId: string; epicCardId: string | null }>>(Prisma.sql`
        SELECT c."id", c."boardId", c."epicCardId" FROM "kanban_card" c WHERE c."id" = ${input.cardId}::uuid FOR UPDATE OF c
      `)
      if (!card) return { ok: false, reason: 'card_not_found' }
      const locked = await this.lockEpic(tx, card.boardId, input.epicIssueNumber)
      if (locked === 'not_found') return { ok: false, reason: 'epic_not_found' }
      if (card.epicCardId === locked.id) {
        const row = await tx.kanbanCard.findUnique({ where: { id: card.id }, select: CARD_ROW_SELECT })
        return { ok: true, changed: false, card: toCardRow(row!) }
      }
      if (exhausted(locked)) return { ok: false, reason: 'epic_budget_exhausted' }
      const row = await tx.kanbanCard.update({
        where: { id: card.id },
        data: { epicCardId: locked.id },
        select: CARD_ROW_SELECT
      })
      await tx.kanbanCard.update({ where: { id: locked.id }, data: { epicCardsCreated: { increment: 1 } } })
      return { ok: true, changed: true, card: toCardRow(row) }
    })
  }

  // The epic card's row lock is the B2 mutex: N commits at the budget boundary serialize and only the remaining room wins.
  private async lockEpic(
    tx: Prisma.TransactionClient,
    boardId: string,
    issueNumber: number
  ): Promise<EpicRow | 'not_found'> {
    const [row] = await tx.$queryRaw<EpicRow[]>(Prisma.sql`
      SELECT c."id", c."epicCardsCreated", b."epicMaxCards"
      FROM "kanban_card" c JOIN "kanban_board" b ON b."id" = c."boardId"
      WHERE c."boardId" = ${boardId}::uuid AND c."issueNumber" = ${issueNumber}
      FOR UPDATE OF c
    `)
    if (!row) return 'not_found'
    return row
  }
}

function toCardRow(row: {
  id: string
  boardId: string
  issueId: bigint
  issueNumber: number
  issueNodeId: string | null
  idempotencyKey: string | null
  status: string
  assigneeAgentId: string | null
  priority: number
  mode: 'read' | 'write' | null
  stateRevision: bigint
  dispatchRevision: bigint
  createdAt: Date
}): KanbanCardRow {
  if (!isKanbanStatus(row.status)) throw new Error(`kanban card ${row.id} has unknown status ${row.status}`)
  return { ...row, status: row.status }
}

/** The B2 maxCards ceiling: a lifetime counter that archiving a child never refunds. */
function exhausted(epic: EpicRow): boolean {
  return epic.epicCardsCreated >= epic.epicMaxCards
}

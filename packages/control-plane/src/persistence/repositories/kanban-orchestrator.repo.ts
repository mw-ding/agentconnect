// Kanban orchestrator repo (issue #2 M3, Lane 2b): B2 epic budgets, checked under the epic card's row lock so a
// concurrent create at the budget boundary admits exactly the remaining room, and the create/upsert composes in one tx.
import { Prisma } from '../../generated/prisma/client.js'
import { OrgId } from '../../domain/ids.js'
import { withAmbientTx, type PrismaLike } from '../prisma.js'
import { isKanbanStatus } from '../../kanban/card-state.js'
import type { KanbanBlockKind } from '../../kanban/run-accounting.js'
import { PgKanbanCardRepo } from './kanban.repo.js'
import type {
  KanbanAdoptEpicInput,
  KanbanAdoptEpicResult,
  KanbanCardRow,
  KanbanEpicChildInput,
  KanbanEpicChildResult,
  KanbanOrchestratorBoard,
  KanbanOrchestratorBoardView,
  KanbanOrchestratorCard,
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
        epic = locked
      }
      // The budget gates only an actual create: a replay (existing key or issue) returns its card even on a full epic.
      await tx.$executeRaw`SAVEPOINT kanban_epic_child`
      let result: Awaited<ReturnType<PgKanbanCardRepo['upsertCard']>>
      try {
        // Composes under this tx: the outer transaction's boundary wins.
        result = await new PgKanbanCardRepo(tx).upsertCard(input.upsert)
      } catch (err) {
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT kanban_epic_child`
        throw err
      }
      if (result.created && epic && exhausted(epic)) {
        // Undo the insert and its created-audit row; nothing else in this tx has written yet.
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT kanban_epic_child`
        return { ok: false, reason: 'epic_budget_exhausted' }
      }
      await tx.$executeRaw`RELEASE SAVEPOINT kanban_epic_child`
      if (result.created && epic) {
        await tx.kanbanCard.update({ where: { id: result.card.id }, data: { epicCardId: epic.id } })
        await tx.kanbanCard.update({ where: { id: epic.id }, data: { epicCardsCreated: { increment: 1 } } })
      }
      return { ok: true, card: result.card, created: result.created, matchedBy: result.matchedBy }
    })
  }

  adoptEpic(input: KanbanAdoptEpicInput): Promise<KanbanAdoptEpicResult> {
    return withAmbientTx(this.db, async (tx) => {
      const [board] = await tx.$queryRaw<Array<{ boardId: string }>>(Prisma.sql`
        SELECT c."boardId" FROM "kanban_card" c WHERE c."id" = ${input.cardId}::uuid
      `)
      if (!board) return { ok: false, reason: 'card_not_found' }
      // One epic re-link at a time per board: disjoint row locks alone would let two links close a long cycle.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${'kanban-epic-link:' + board.boardId}))::text`
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
      // Re-parenting is refused: GitHub keeps one parent per issue, and B2 counts never refund a moved child.
      if (card.epicCardId !== null) return { ok: false, reason: 'invalid_link' }
      if (locked.id === card.id || (await this.reachesCard(tx, locked.id, card.id))) {
        return { ok: false, reason: 'invalid_link' }
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

  /** Walks the epic chain up from `fromId`; true when it reaches `targetId` (a cycle) or runs past the depth bound. */
  private async reachesCard(tx: Prisma.TransactionClient, fromId: string, targetId: string): Promise<boolean> {
    let at: string | null = fromId
    for (let depth = 0; depth < EPIC_CHAIN_MAX_DEPTH && at !== null; depth++) {
      if (at === targetId) return true
      const [row]: Array<{ epicCardId: string | null }> = await tx.$queryRaw<Array<{ epicCardId: string | null }>>(
        Prisma.sql`SELECT "epicCardId" FROM "kanban_card" WHERE "id" = ${at}::uuid`
      )
      at = row?.epicCardId ?? null
    }
    // A chain deeper than the bound is refused as if it cycled; no real decomposition nests that far.
    return at !== null
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

  async boardForOrchestrator(
    agentId: string,
    orgId: string,
    boardId: string
  ): Promise<
    | { ok: true; board: KanbanOrchestratorBoard }
    | { ok: false; reason: 'board_not_found' | 'board_disabled' | 'not_orchestrator' }
  > {
    const row = await this.db.kanbanBoard.findFirst({
      where: { id: boardId, orgId },
      select: {
        id: true,
        orgId: true,
        repoId: true,
        repoFullName: true,
        epicMaxCards: true,
        enabled: true,
        orchestratorAgentId: true
      }
    })
    if (!row) return { ok: false, reason: 'board_not_found' }
    if (!row.enabled) return { ok: false, reason: 'board_disabled' }
    if (row.orchestratorAgentId !== agentId) return { ok: false, reason: 'not_orchestrator' }
    const board: KanbanOrchestratorBoard = {
      id: row.id,
      orgId: OrgId(row.orgId),
      repoId: row.repoId,
      repoFullName: row.repoFullName,
      epicMaxCards: row.epicMaxCards
    }
    return { ok: true, board }
  }

  async orchestratorBoards(
    agentId: string,
    boardId: string | undefined,
    status: string | undefined,
    limit: number
  ): Promise<{ truncated: boolean; boards: KanbanOrchestratorBoardView[] }> {
    const boards = await this.db.kanbanBoard.findMany({
      where: { orchestratorAgentId: agentId, enabled: true, ...(boardId ? { id: boardId } : {}) },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, repoFullName: true }
    })
    const views: KanbanOrchestratorBoardView[] = []
    let total = 0
    let truncated = false
    for (const board of boards) {
      const cards = await this.cardsView(board.id, status)
      total += cards.length
      if (total > limit) {
        truncated = true
        views.push({
          boardId: board.id,
          repoFullName: board.repoFullName,
          cards: cards.slice(0, limit - (total - cards.length))
        })
        break
      }
      views.push({ boardId: board.id, repoFullName: board.repoFullName, cards })
    }
    return { truncated, boards: views }
  }

  async cardByIssueNumber(boardId: string, issueNumber: number): Promise<KanbanOrchestratorCard | null> {
    const [row] = await this.db.$queryRaw<
      Array<{
        cardId: string
        issueId: bigint
        issueNumber: number
        status: string
        assigneeAgentId: string | null
        assigneeSlug: string | null
        priority: number
        blockKind: string | null
        epicCardId: string | null
        epicIssueNumber: number | null
        leased: boolean
        stateRevision: bigint
      }>
    >(Prisma.sql`
      SELECT c."id" AS "cardId", c."issueId", c."issueNumber", c."status"::text AS "status", c."assigneeAgentId",
             a."name" AS "assigneeSlug", c."priority", c."blockKind"::text AS "blockKind", c."epicCardId",
             ep."issueNumber" AS "epicIssueNumber", EXISTS (SELECT 1 FROM "kanban_run" r WHERE r."cardId" = c."id" AND r."endedAt" IS NULL) AS "leased",
             c."stateRevision"
      FROM "kanban_card" c
      LEFT JOIN "agent" a ON a."id" = c."assigneeAgentId"
      LEFT JOIN "kanban_card" ep ON ep."id" = c."epicCardId"
      WHERE c."boardId" = ${boardId}::uuid AND c."issueNumber" = ${issueNumber}
    `)
    if (!row) return null
    if (!isKanbanStatus(row.status)) return null
    return {
      cardId: row.cardId,
      issueId: row.issueId,
      issueNumber: row.issueNumber,
      status: row.status,
      assigneeAgentId: row.assigneeAgentId,
      assigneeSlug: row.assigneeSlug,
      priority: row.priority,
      blockKind: row.blockKind as KanbanBlockKind | null,
      epicCardId: row.epicCardId,
      epicIssueNumber: row.epicIssueNumber,
      leased: row.leased,
      stateRevision: row.stateRevision
    }
  }

  async unassignableReason(orgId: string, slug: string): Promise<'unknown_agent' | 'agent_not_assignable'> {
    const agent = await this.db.agent.findUnique({
      where: { orgId_name: { orgId, name: slug.toLowerCase() } },
      select: { id: true }
    })
    return agent ? 'agent_not_assignable' : 'unknown_agent'
  }

  async epicBudget(
    boardId: string,
    epicIssueNumber: number
  ): Promise<'ok' | 'epic_not_found' | 'epic_budget_exhausted'> {
    const [row] = await this.db.$queryRaw<Array<{ epicCardsCreated: number; epicMaxCards: number }>>(Prisma.sql`
      SELECT c."epicCardsCreated", b."epicMaxCards"
      FROM "kanban_card" c JOIN "kanban_board" b ON b."id" = c."boardId"
      WHERE c."boardId" = ${boardId}::uuid AND c."issueNumber" = ${epicIssueNumber}
    `)
    if (!row) return 'epic_not_found'
    return row.epicCardsCreated >= row.epicMaxCards ? 'epic_budget_exhausted' : 'ok'
  }

  async orchestratorRepoId(agentId: string, orgId: string, repoFullName: string): Promise<bigint | null> {
    // GitHub names are case-insensitive; the board must be the agent's own org's, never a same-named repo elsewhere.
    const board = await this.db.kanbanBoard.findFirst({
      where: {
        orchestratorAgentId: agentId,
        orgId,
        enabled: true,
        repoFullName: { equals: repoFullName, mode: 'insensitive' }
      },
      orderBy: { createdAt: 'asc' },
      select: { repoId: true }
    })
    return board?.repoId ?? null
  }

  private async cardsView(boardId: string, status: string | undefined): Promise<KanbanOrchestratorBoardView['cards']> {
    const rows = await this.db.$queryRaw<
      Array<{
        issueNumber: number
        status: string
        assigneeAgentId: string | null
        assigneeSlug: string | null
        priority: number
        blockKind: string | null
        epicIssueNumber: number | null
        leased: boolean
      }>
    >(Prisma.sql`
      SELECT c."issueNumber", c."status"::text AS "status", c."assigneeAgentId",
             a."name" AS "assigneeSlug", c."priority", c."blockKind"::text AS "blockKind",
             ep."issueNumber" AS "epicIssueNumber",
             EXISTS (SELECT 1 FROM "kanban_run" r WHERE r."cardId" = c."id" AND r."endedAt" IS NULL) AS "leased"
      FROM "kanban_card" c
      LEFT JOIN "agent" a ON a."id" = c."assigneeAgentId"
      LEFT JOIN "kanban_card" ep ON ep."id" = c."epicCardId"
      WHERE c."boardId" = ${boardId}::uuid
        ${status ? Prisma.sql`AND c."status" = ${status}::"KanbanCardStatus"` : Prisma.empty}
      ORDER BY c."priority" DESC, c."issueNumber" ASC
    `)
    return rows.flatMap((r) =>
      isKanbanStatus(r.status) ? [{ ...r, status: r.status, blockKind: r.blockKind as KanbanBlockKind | null }] : []
    )
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

const EPIC_CHAIN_MAX_DEPTH = 32

/** The B2 maxCards ceiling: a lifetime counter that archiving a child never refunds. */
function exhausted(epic: EpicRow): boolean {
  return epic.epicCardsCreated >= epic.epicMaxCards
}

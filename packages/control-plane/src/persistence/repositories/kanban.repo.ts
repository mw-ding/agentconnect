// Kanban repos (issue #2 M1): PgKanbanBoardRepo serves the doorbell and redelivery sweep; PgKanbanCardRepo the graph reconciler.
import { OrgId } from '../../domain/ids.js'
import { withAmbientTx, type PrismaLike } from '../prisma.js'
import { isKanbanStatus, type KanbanStatus } from '../../kanban/card-state.js'
import type {
  KanbanBoardRecord,
  KanbanBoardRepo,
  KanbanCardRecord,
  KanbanCardRepo,
  KanbanModeAdminRepo
} from '../ports.js'

const BOARD_SELECT = { id: true, orgId: true, name: true, repoId: true, repoFullName: true } as const

/** No promotion in flight and no human flag: what every settled status move writes. */
export const PROMOTION_CLEARED = {
  promotionPending: false,
  promotionEventCursor: null,
  promotionPostAccepted: false,
  promotionStartedAt: null,
  promotionChecks: 0,
  needsAttention: false,
  attentionReason: null
} as const

export class PgKanbanBoardRepo implements KanbanBoardRepo, KanbanModeAdminRepo {
  constructor(private readonly db: PrismaLike) {}

  // Only the human-authenticated owner route calls this, with the caller's user id; never expose it on worker RPCs.
  async setDefaultMode(orgId: string, boardId: string, userId: string, mode: 'read' | 'write'): Promise<boolean> {
    return withAmbientTx(this.db, async (tx) => {
      // Serialize mode changes so the audit records the value this update actually replaces.
      await tx.$queryRaw`
        SELECT "id" FROM "kanban_board" WHERE "id" = ${boardId}::uuid AND "orgId" = ${orgId} FOR UPDATE
      `
      const where = { id: boardId, orgId, org: { members: { some: { userId, role: 'owner' as const } } } }
      const current = await tx.kanbanBoard.findFirst({ where, select: { defaultMode: true } })
      if (!current) return false
      const result = await tx.kanbanBoard.updateMany({
        where,
        data: {
          defaultMode: mode,
          configRevision: { increment: 1 },
          lastModifiedByUserId: userId,
          lastModifiedAt: new Date()
        }
      })
      if (result.count !== 1) return false
      await tx.auditEvent.create({
        data: {
          kind: 'kanban_mode_change',
          orgId,
          actorUserId: userId,
          message: `kanban board ${boardId} default mode changed`,
          details: { boardId, oldMode: current.defaultMode, newMode: mode }
        }
      })
      return true
    })
  }

  // A null card override restores the board default for the next claim; active runs retain their recorded mode.
  async setCardMode(
    orgId: string,
    boardId: string,
    cardId: string,
    userId: string,
    mode: 'read' | 'write' | null
  ): Promise<boolean> {
    return withAmbientTx(this.db, async (tx) => {
      // Lock before reading the old override, including null (inherit the board default).
      await tx.$queryRaw`
        SELECT "id" FROM "kanban_card" WHERE "id" = ${cardId}::uuid AND "boardId" = ${boardId}::uuid FOR UPDATE
      `
      const where = {
        id: cardId,
        boardId,
        board: { orgId, org: { members: { some: { userId, role: 'owner' as const } } } }
      }
      const current = await tx.kanbanCard.findFirst({ where, select: { mode: true } })
      if (!current) return false
      const result = await tx.kanbanCard.updateMany({ where, data: { mode, modeRevision: { increment: 1 } } })
      if (result.count !== 1) return false
      await tx.auditEvent.create({
        data: {
          kind: 'kanban_mode_change',
          orgId,
          actorUserId: userId,
          message: `kanban card ${cardId} mode override changed`,
          details: { boardId, cardId, oldMode: current.mode, newMode: mode }
        }
      })
      return true
    })
  }

  async listEnabledByRepoId(repoId: bigint): Promise<KanbanBoardRecord[]> {
    const rows = await this.db.kanbanBoard.findMany({ where: { repoId, enabled: true }, select: BOARD_SELECT })
    return rows.map((r) => ({ ...r, orgId: OrgId(r.orgId) }))
  }

  async listEnabledRepoIds(): Promise<bigint[]> {
    const rows = await this.db.kanbanBoard.findMany({
      where: { enabled: true },
      select: { repoId: true },
      distinct: ['repoId']
    })
    return rows.map((r) => r.repoId)
  }
}

export class PgKanbanCardRepo implements KanbanCardRepo {
  constructor(private readonly db: PrismaLike) {}

  async findByIssueNumber(boardId: string, issueNumber: number): Promise<KanbanCardRecord | null> {
    const row = await this.db.kanbanCard.findUnique({
      where: { boardId_issueNumber: { boardId, issueNumber } },
      select: {
        id: true,
        boardId: true,
        issueId: true,
        issueNumber: true,
        status: true,
        stateRevision: true,
        promotionPending: true,
        needsAttention: true,
        runs: { where: { endedAt: null }, select: { id: true }, take: 1 }
      }
    })
    if (!row || !isKanbanStatus(row.status)) return null
    const { runs, ...card } = row
    return { ...card, status: row.status, leased: runs.length > 0 }
  }

  async casStatus(cardId: string, expectedStateRevision: bigint, to: KanbanStatus): Promise<boolean> {
    const { count } = await this.db.kanbanCard.updateMany({
      where: { id: cardId, stateRevision: expectedStateRevision },
      data: { status: to, stateRevision: { increment: 1 }, githubSyncedAt: new Date(), ...PROMOTION_CLEARED }
    })
    return count === 1
  }

  async beginPromotion(
    cardId: string,
    expectedStateRevision: bigint,
    eventCursor: bigint,
    startedAt: Date
  ): Promise<boolean> {
    // One write for the ready CAS and the intent; an open intent keeps its caps, and a flagged card is a human's.
    const { count } = await this.db.kanbanCard.updateMany({
      where: {
        id: cardId,
        stateRevision: expectedStateRevision,
        status: 'todo',
        promotionPending: false,
        needsAttention: false
      },
      data: {
        status: 'ready',
        stateRevision: { increment: 1 },
        githubSyncedAt: new Date(),
        ...PROMOTION_CLEARED,
        promotionPending: true,
        promotionEventCursor: eventCursor,
        promotionStartedAt: startedAt,
        // A minute out, so a tick cannot settle the card while this write is still in flight.
        recoveryCheckAt: new Date(startedAt.getTime() + 60_000),
        recoveryChecks: 0
      }
    })
    return count === 1
  }

  async notePromotionPosted(cardId: string): Promise<void> {
    await this.db.kanbanCard.updateMany({
      where: { id: cardId, promotionPending: true },
      data: { promotionPostAccepted: true }
    })
  }

  async clearPromotionIntent(cardId: string): Promise<boolean> {
    const { count } = await this.db.kanbanCard.updateMany({
      where: { id: cardId, status: 'ready', promotionPending: true },
      data: PROMOTION_CLEARED
    })
    return count === 1
  }

  async revertPromotion(cardId: string, expectedStateRevision: bigint): Promise<boolean> {
    const { count } = await this.db.kanbanCard.updateMany({
      where: { id: cardId, stateRevision: expectedStateRevision, status: 'ready', promotionPending: true },
      data: { status: 'todo', stateRevision: { increment: 1 }, recoveryCheckAt: null, recoveryChecks: 0 }
    })
    return count === 1
  }
}

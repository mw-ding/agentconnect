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
      data: {
        status: to,
        stateRevision: { increment: 1 },
        githubSyncedAt: new Date(),
        promotionPending: false,
        promotionReadyEventId: null,
        promotionWriteStartedAt: null,
        promotionReadyNotAfter: null
      }
    })
    return count === 1
  }

  async beginPromotion(
    cardId: string,
    expectedStateRevision: bigint,
    notBefore: Date,
    notAfter: Date
  ): Promise<boolean> {
    // The ready CAS and the intent are one write, so no claim or crash can see ready without the intent.
    const { count } = await this.db.kanbanCard.updateMany({
      where: { id: cardId, stateRevision: expectedStateRevision, status: 'todo' },
      data: {
        status: 'ready',
        stateRevision: { increment: 1 },
        githubSyncedAt: new Date(),
        promotionPending: true,
        promotionReadyEventId: null,
        promotionWriteStartedAt: notBefore,
        promotionReadyNotAfter: notAfter,
        // A minute out, so a tick cannot settle the card while this write is still in flight.
        recoveryCheckAt: new Date(notBefore.getTime() + 60_000),
        recoveryChecks: 0
      }
    })
    return count === 1
  }

  async notePromotionEvent(
    cardId: string,
    eventId: bigint | null,
    bounds?: { notBefore: Date; notAfter: Date }
  ): Promise<void> {
    await this.db.kanbanCard.updateMany({
      where: { id: cardId, promotionPending: true },
      data: {
        ...(eventId != null ? { promotionReadyEventId: eventId } : {}),
        ...(bounds ? { promotionWriteStartedAt: bounds.notBefore, promotionReadyNotAfter: bounds.notAfter } : {})
      }
    })
  }

  async clearPromotionIntent(cardId: string): Promise<boolean> {
    const { count } = await this.db.kanbanCard.updateMany({
      where: { id: cardId, status: 'ready', promotionPending: true },
      data: {
        promotionPending: false,
        promotionReadyEventId: null,
        promotionWriteStartedAt: null,
        promotionReadyNotAfter: null
      }
    })
    return count === 1
  }

  async revertPromotion(
    cardId: string,
    expectedStateRevision: bigint,
    readyEventId: bigint | null,
    notBefore: Date | null,
    notAfter: Date | null
  ): Promise<boolean> {
    const { count } = await this.db.kanbanCard.updateMany({
      where: { id: cardId, stateRevision: expectedStateRevision, status: 'ready' },
      data: {
        status: 'todo',
        stateRevision: { increment: 1 },
        promotionPending: true,
        promotionReadyEventId: readyEventId,
        promotionWriteStartedAt: notBefore,
        promotionReadyNotAfter: notAfter,
        recoveryCheckAt: null,
        recoveryChecks: 0
      }
    })
    return count === 1
  }
}

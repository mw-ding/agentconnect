// Kanban repos (issue #2 M1): PgKanbanBoardRepo serves the doorbell and redelivery sweep; PgKanbanCardRepo the graph reconciler.
import { OrgId } from '../../domain/ids.js'
import type { PrismaLike } from '../prisma.js'
import { isKanbanStatus, type KanbanStatus } from '../../kanban/card-state.js'
import type { KanbanBoardRecord, KanbanBoardRepo, KanbanCardRecord, KanbanCardRepo } from '../ports.js'

const BOARD_SELECT = { id: true, orgId: true, name: true, repoId: true, repoFullName: true } as const

export class PgKanbanBoardRepo implements KanbanBoardRepo {
  constructor(private readonly db: PrismaLike) {}

  // Control-plane admin callers must supply the authenticated human's user id; never expose this on worker RPCs.
  async setDefaultMode(orgId: string, boardId: string, userId: string, mode: 'read' | 'write'): Promise<boolean> {
    const result = await this.db.kanbanBoard.updateMany({
      where: { id: boardId, orgId, org: { members: { some: { userId, role: 'owner' } } } },
      data: {
        defaultMode: mode,
        configRevision: { increment: 1 },
        lastModifiedByUserId: userId,
        lastModifiedAt: new Date()
      }
    })
    return result.count === 1
  }

  // A null card override restores the board default for the next claim; active runs retain their recorded mode.
  async setCardMode(
    orgId: string,
    boardId: string,
    cardId: string,
    userId: string,
    mode: 'read' | 'write' | null
  ): Promise<boolean> {
    const result = await this.db.kanbanCard.updateMany({
      where: { id: cardId, boardId, board: { orgId, org: { members: { some: { userId, role: 'owner' } } } } },
      data: { mode, stateRevision: { increment: 1 } }
    })
    return result.count === 1
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
      data: { status: to, stateRevision: { increment: 1 }, githubSyncedAt: new Date() }
    })
    return count === 1
  }
}

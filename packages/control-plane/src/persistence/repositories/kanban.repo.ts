// PgKanbanBoardRepo — the Kanban board reads the graph doorbell and redelivery sweep need (issue #2 M1).
import { OrgId } from '../../domain/ids.js'
import type { PrismaLike } from '../prisma.js'
import type { KanbanBoardRecord, KanbanBoardRepo } from '../ports.js'

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

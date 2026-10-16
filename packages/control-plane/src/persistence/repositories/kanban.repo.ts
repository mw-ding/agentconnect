// PgKanbanBoardRepo — the Kanban board reads the graph doorbell and redelivery sweep need (issue #2 M1).
import { OrgId } from '../../domain/ids.js'
import type { PrismaLike } from '../prisma.js'
import type { KanbanBoardRecord, KanbanBoardRepo } from '../ports.js'

const BOARD_SELECT = { id: true, orgId: true, name: true, repoId: true, repoFullName: true } as const

export class PgKanbanBoardRepo implements KanbanBoardRepo {
  constructor(private readonly db: PrismaLike) {}

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

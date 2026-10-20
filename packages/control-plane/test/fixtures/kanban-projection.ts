import { prisma } from '../setup.db.js'
import { PgKanbanSyncRepo } from '../../src/persistence/repositories/kanban-sync.repo.js'

// Repo-only tests have no GitHub service; explicitly acknowledge the projection before expecting another claim.
export async function acknowledgeKanbanProjection(cardId: string): Promise<void> {
  const row = await prisma.kanbanCard.findUniqueOrThrow({ where: { id: cardId } })
  const repo = new PgKanbanSyncRepo(prisma)
  const snapshot = await repo.get(row.boardId, row.issueNumber)
  if (!snapshot) throw new Error('missing projection snapshot')
  if (!(await repo.ack(snapshot, snapshot.syncEventCursor, snapshot.syncAgentCursor)))
    throw new Error('projection superseded')
}

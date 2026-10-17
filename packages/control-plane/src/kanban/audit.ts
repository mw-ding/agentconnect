// Status audit rows contain only stable identifiers, state names, and a source code.
import type { Prisma } from '../generated/prisma/client.js'
import type { KanbanStatus } from './card-state.js'
import { withAmbientTx, type PrismaLike } from '../persistence/prisma.js'

export async function auditCardTransition(
  tx: Prisma.TransactionClient,
  input: { cardId: string; from: KanbanStatus; to: KanbanStatus; source: string; leaseId?: string }
): Promise<void> {
  if (input.from === input.to) return
  const card = await tx.kanbanCard.findUniqueOrThrow({
    where: { id: input.cardId },
    select: { boardId: true, issueNumber: true, stateRevision: true, board: { select: { orgId: true } } }
  })
  await tx.auditEvent.create({
    data: {
      orgId: card.board.orgId,
      kind: 'kanban_card_change',
      message: `kanban card ${input.cardId} status changed`,
      details: {
        boardId: card.boardId,
        cardId: input.cardId,
        issueNumber: card.issueNumber,
        change: 'status',
        from: input.from,
        to: input.to,
        source: input.source,
        stateRevision: card.stateRevision.toString(),
        ...(input.leaseId ? { leaseId: input.leaseId } : {})
      }
    }
  })
}

// Conditional status writes and their audit rows commit together, including promotion rollback and recovery.
export async function applyCardTransition(
  db: PrismaLike,
  where: Prisma.KanbanCardWhereInput,
  data: Prisma.KanbanCardUpdateManyMutationInput,
  source: string
): Promise<boolean> {
  return withAmbientTx(db, async (tx) => {
    const card = await tx.kanbanCard.findFirst({ where, select: { id: true, status: true, stateRevision: true } })
    if (!card) return false
    const { count } = await tx.kanbanCard.updateMany({
      where: { ...where, id: card.id, stateRevision: card.stateRevision },
      data: { ...data, labelWritePending: true }
    })
    if (count !== 1) return false
    const updated = await tx.kanbanCard.findUniqueOrThrow({ where: { id: card.id }, select: { status: true } })
    await auditCardTransition(tx, { cardId: card.id, from: card.status, to: updated.status, source })
    return true
  })
}

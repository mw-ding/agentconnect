// Sync commits behind the same card lock and revisions as claims, run ends, and reassignment.
import { Prisma } from '../../generated/prisma/client.js'
import { withAmbientTx, type PrismaLike } from '../prisma.js'
import type { KanbanLeaseRef } from '../ports.js'
import type { GitHubActor, KanbanSyncRepo, SyncCard } from '../../kanban/sync.js'
import { isKanbanStatus, type KanbanStatus, type LabelPlan } from '../../kanban/card-state.js'
import { auditCardTransition } from '../../kanban/audit.js'
import { PROMOTION_CLEARED } from './kanban.repo.js'

export class PgKanbanSyncRepo implements KanbanSyncRepo {
  constructor(private readonly db: PrismaLike) {}

  async get(boardId: string, issueNumber: number): Promise<SyncCard | null> {
    const row = await this.db.kanbanCard.findUnique({
      where: { boardId_issueNumber: { boardId, issueNumber } },
      select: {
        id: true,
        boardId: true,
        issueNumber: true,
        status: true,
        stateRevision: true,
        dispatchRevision: true,
        assigneeAgentId: true,
        promotionPending: true,
        labelWritePending: true,
        syncEventCursor: true,
        syncAgentCursor: true,
        syncDeferredAt: true,
        syncDeferralCount: true,
        needsAttention: true,
        assigneeAgent: { select: { name: true } },
        board: { select: { orgId: true, enabled: true } },
        runs: {
          where: { endedAt: null },
          take: 1,
          select: { id: true, leaseId: true, agentId: true, daemonId: true, dispatchRevision: true }
        }
      }
    })
    if (!row || !row.board.enabled || !isKanbanStatus(row.status)) return null
    const { board, runs, assigneeAgent, ...card } = row
    const run = runs[0]
    return {
      ...card,
      status: row.status,
      orgId: board.orgId,
      assigneeName: assigneeAgent?.name ?? null,
      lease: run ? { ...run, runId: run.id } : null
    }
  }

  list(boardId: string, limit: number): Promise<number[]> {
    return withAmbientTx(this.db, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; issueNumber: number }>>(Prisma.sql`
        SELECT "id", "issueNumber" FROM "kanban_card"
        WHERE "boardId" = ${boardId}::uuid AND NOT "promotionPending" AND (NOT "needsAttention" OR "labelWritePending")
        ORDER BY "syncCheckedAt" ASC NULLS FIRST, "issueNumber" ASC
        LIMIT ${limit} FOR UPDATE SKIP LOCKED
      `)
      await tx.kanbanCard.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { syncCheckedAt: new Date() }
      })
      return rows.map((r) => r.issueNumber)
    })
  }

  apply(card: SyncCard, plan: LabelPlan, cursor: bigint, human: boolean, agentCursor: bigint, actor?: GitHubActor) {
    return withAmbientTx(this.db, async (tx) => {
      const [locked] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "kanban_card" WHERE "id" = ${card.id}::uuid FOR UPDATE
      `)
      if (!locked) return null
      const current = await tx.kanbanCard.findUniqueOrThrow({ where: { id: card.id } })
      if (
        current.stateRevision !== card.stateRevision ||
        current.dispatchRevision !== card.dispatchRevision ||
        current.promotionPending ||
        current.syncEventCursor > card.syncEventCursor ||
        current.syncAgentCursor > card.syncAgentCursor
      )
        return null
      const run = await tx.kanbanRun.findFirst({ where: { cardId: card.id, endedAt: null } })
      if ((run?.leaseId ?? null) !== (card.lease?.leaseId ?? null)) return null
      let revoked: KanbanLeaseRef | null = null
      if (plan.releaseLease && run) {
        await tx.kanbanRun.update({
          where: { id: run.id },
          data: { endedAt: new Date(), outcome: 'reclaimed', reasonCode: 'human_status' }
        })
        revoked = {
          runId: run.id,
          leaseId: run.leaseId,
          agentId: run.agentId,
          daemonId: run.daemonId,
          dispatchRevision: run.dispatchRevision
        }
      }
      const changed = card.status !== plan.status
      const repair = plan.addLabels.length > 0 || plan.removeLabels.length > 0 || !!plan.issueState
      await tx.kanbanCard.update({
        where: { id: card.id },
        data: {
          status: plan.status,
          ...(changed ? { stateRevision: { increment: 1 }, cooldownUntil: null, blockKind: null } : {}),
          ...(human ? PROMOTION_CLEARED : {}),
          ...(revoked ? { dispatchRevision: { increment: 1 } } : {}),
          labelWritePending: repair || current.labelWritePending,
          syncEventCursor: cursor > current.syncEventCursor ? cursor : current.syncEventCursor,
          syncAgentCursor: agentCursor > current.syncAgentCursor ? agentCursor : current.syncAgentCursor,
          syncDeferredAt: null,
          syncDeferralCount: 0
        }
      })
      await auditCardTransition(tx, {
        cardId: card.id,
        from: card.status,
        to: plan.status,
        source: 'human_label',
        ...(revoked ? { leaseId: revoked.leaseId } : {}),
        ...(actor ? { actor } : {})
      })
      return { changed, revoked }
    })
  }

  async ack(card: SyncCard, cursor: bigint, agentCursor = 0n): Promise<boolean> {
    const { count } = await this.db.kanbanCard.updateMany({
      where: {
        id: card.id,
        stateRevision: card.stateRevision,
        dispatchRevision: card.dispatchRevision,
        syncEventCursor: card.syncEventCursor,
        syncAgentCursor: card.syncAgentCursor
      },
      data: {
        labelWritePending: false,
        githubSyncedAt: new Date(),
        syncEventCursor: cursor > card.syncEventCursor ? cursor : card.syncEventCursor,
        syncAgentCursor: agentCursor > card.syncAgentCursor ? agentCursor : card.syncAgentCursor,
        syncDeferredAt: null,
        syncDeferralCount: 0
      }
    })
    return count === 1
  }

  async defer(card: SyncCard, now: Date): Promise<SyncCard | null> {
    const { count } = await this.db.kanbanCard.updateMany({
      where: { id: card.id },
      data: { syncDeferralCount: { increment: 1 }, syncDeferredAt: card.syncDeferredAt ?? now }
    })
    if (count !== 1) return null
    return this.get(card.boardId, card.issueNumber)
  }

  failClosed(card: SyncCard): Promise<{ status: KanbanStatus; revoked: KanbanLeaseRef | null } | null> {
    return withAmbientTx(this.db, async (tx) => {
      const [locked] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "kanban_card" WHERE "id" = ${card.id}::uuid FOR UPDATE
      `)
      if (!locked) return null
      const current = await tx.kanbanCard.findUniqueOrThrow({ where: { id: card.id } })
      if (
        current.stateRevision !== card.stateRevision ||
        current.dispatchRevision !== card.dispatchRevision ||
        current.promotionPending ||
        !isKanbanStatus(current.status)
      )
        return null
      // Only a dispatchable card moves: triage is never claimed, and every other status already needs a human to run.
      const from = current.status
      const to: KanbanStatus = from === 'ready' || from === 'running' ? 'triage' : from
      const run = to !== from ? await tx.kanbanRun.findFirst({ where: { cardId: card.id, endedAt: null } }) : null
      let revoked: KanbanLeaseRef | null = null
      if (run) {
        await tx.kanbanRun.update({
          where: { id: run.id },
          data: { endedAt: new Date(), outcome: 'reclaimed', reasonCode: 'label_attribution_timeout' }
        })
        revoked = {
          runId: run.id,
          leaseId: run.leaseId,
          agentId: run.agentId,
          daemonId: run.daemonId,
          dispatchRevision: run.dispatchRevision
        }
      }
      await tx.kanbanCard.update({
        where: { id: card.id },
        data: {
          ...(to !== from
            ? {
                status: to,
                stateRevision: { increment: 1 },
                cooldownUntil: null,
                blockKind: null
              }
            : {}),
          ...(revoked ? { dispatchRevision: { increment: 1 } } : {}),
          labelWritePending: true,
          needsAttention: true,
          attentionReason: 'label_attribution_timeout',
          syncDeferredAt: null,
          syncDeferralCount: 0
        }
      })
      await auditCardTransition(tx, {
        cardId: card.id,
        from,
        to,
        source: 'label_attribution_timeout',
        ...(revoked ? { leaseId: revoked.leaseId } : {})
      })
      return { status: to, revoked }
    })
  }
}

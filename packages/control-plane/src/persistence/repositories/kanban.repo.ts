// Kanban repos (issue #2 M1): PgKanbanBoardRepo serves the doorbell and redelivery sweep; PgKanbanCardRepo the graph reconciler.
import { randomUUID } from 'node:crypto'
import { OrgId } from '../../domain/ids.js'
import { Prisma } from '../../generated/prisma/client.js'
import { withAmbientTx, type PrismaLike } from '../prisma.js'
import { isKanbanStatus, type KanbanStatus } from '../../kanban/card-state.js'
import {
  KanbanCardUpsertError,
  type KanbanBoardRecord,
  type KanbanBoardRepo,
  type KanbanCardRecord,
  type KanbanCardRepo,
  type KanbanCardRow,
  type KanbanCardUpsertInput,
  type KanbanCardUpsertResult,
  type KanbanLeaseRef,
  type KanbanModeAdminRepo,
  type KanbanSetAssigneeInput,
  type KanbanSetAssigneeResult
} from '../ports.js'

const BOARD_SELECT = { id: true, orgId: true, name: true, repoId: true, repoFullName: true } as const

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

/** A concurrent delete between the conflicting insert and the re-read is retried this many times. */
const UPSERT_ATTEMPTS = 3

/** How long after its POST (or its rollback) an unacknowledged ready write is still watched for a late landing. */
export const PROMOTION_WATCH_MS = 10 * 60_000

/** No promotion in flight and no human flag: what every settled status move writes. */
export const PROMOTION_CLEARED = {
  promotionPending: false,
  promotionEventCursor: null,
  promotionPostAccepted: false,
  promotionWatchUntil: null,
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
        promotionWatchUntil: new Date(startedAt.getTime() + PROMOTION_WATCH_MS),
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

  async revertPromotion(cardId: string, expectedStateRevision: bigint, revertedAt: Date): Promise<boolean> {
    // The timed-out POST can still land after this rollback, so the watch restarts from now.
    const { count } = await this.db.kanbanCard.updateMany({
      where: { id: cardId, stateRevision: expectedStateRevision, status: 'ready', promotionPending: true },
      data: {
        status: 'todo',
        stateRevision: { increment: 1 },
        promotionWatchUntil: new Date(revertedAt.getTime() + PROMOTION_WATCH_MS),
        recoveryCheckAt: null,
        recoveryChecks: 0
      }
    })
    return count === 1
  }

  async upsertCard(input: KanbanCardUpsertInput): Promise<KanbanCardUpsertResult> {
    const status = input.status ?? 'triage'
    if (!isKanbanStatus(status) || (status as KanbanStatus) === 'running') {
      throw new KanbanCardUpsertError('invalid_status')
    }
    const board = await this.db.kanbanBoard.findUnique({ where: { id: input.boardId }, select: { orgId: true } })
    if (!board) throw new KanbanCardUpsertError('board_not_found')
    if (input.assigneeAgentId && !(await this.agentInOrg(board.orgId, input.assigneeAgentId))) {
      throw new KanbanCardUpsertError('agent_not_in_org')
    }
    const key = input.idempotencyKey ?? null
    for (let attempt = 0; attempt < UPSERT_ATTEMPTS; attempt++) {
      // ON CONFLICT DO NOTHING covers all three uniques (issue id, number, key) without aborting an ambient transaction.
      const created = await withAmbientTx(this.db, async (tx) => {
        const [row] = await tx.kanbanCard.createManyAndReturn({
          data: [
            {
              id: randomUUID(),
              boardId: input.boardId,
              issueId: input.issueId,
              issueNumber: input.issueNumber,
              issueNodeId: input.issueNodeId ?? null,
              idempotencyKey: key,
              status,
              assigneeAgentId: input.assigneeAgentId ?? null,
              priority: input.priority ?? 0,
              mode: input.mode ?? null
            }
          ],
          skipDuplicates: true,
          select: CARD_ROW_SELECT
        })
        if (!row) return null
        await tx.auditEvent.create({
          data: {
            kind: 'kanban_card_change',
            orgId: board.orgId,
            actorUserId: input.actorUserId ?? null,
            agentId: input.actorAgentId ?? null,
            message: `kanban card ${row.id} created`,
            details: {
              boardId: row.boardId,
              cardId: row.id,
              issueNumber: row.issueNumber,
              change: 'created',
              to: row.status,
              assigneeAgentId: row.assigneeAgentId,
              keyed: key !== null,
              source: input.source
            }
          }
        })
        return toCardRow(row)
      })
      if (created) return { card: created, created: true, matchedBy: 'created' }

      // The key outranks the issue: a re-plan that already filed this spec gets that card back, whatever issue it names.
      if (key !== null) {
        const byKey = await this.findByIdempotencyKey(input.boardId, key)
        if (byKey) return { card: byKey, created: false, matchedBy: 'idempotency_key' }
      }
      const byIssue = await this.db.kanbanCard.findFirst({
        where: {
          boardId: input.boardId,
          OR: [{ issueId: input.issueId }, { issueNumber: input.issueNumber }]
        },
        orderBy: { createdAt: 'asc' },
        select: CARD_ROW_SELECT
      })
      if (!byIssue) continue
      if (key === null || byIssue.idempotencyKey === key) {
        return { card: toCardRow(byIssue), created: false, matchedBy: 'issue' }
      }
      if (byIssue.idempotencyKey !== null) throw new KanbanCardUpsertError('key_conflict')
      // An imported card adopts the orchestrator's key, so the next re-plan finds it by key alone.
      try {
        const { count } = await this.db.kanbanCard.updateMany({
          where: { id: byIssue.id, idempotencyKey: null },
          data: { idempotencyKey: key }
        })
        if (count === 1) {
          return { card: toCardRow({ ...byIssue, idempotencyKey: key }), created: false, matchedBy: 'issue' }
        }
      } catch (err) {
        // A concurrent upsert attached the same key to another card first; that card is the answer.
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err
      }
    }
    throw new Error('kanban card upsert: the conflicting card vanished on every attempt')
  }

  async findByIdempotencyKey(boardId: string, idempotencyKey: string): Promise<KanbanCardRow | null> {
    const row = await this.db.kanbanCard.findUnique({
      where: { boardId_idempotencyKey: { boardId, idempotencyKey } },
      select: CARD_ROW_SELECT
    })
    return row ? toCardRow(row) : null
  }

  async getCard(cardId: string): Promise<KanbanCardRow | null> {
    const row = await this.db.kanbanCard.findUnique({ where: { id: cardId }, select: CARD_ROW_SELECT })
    return row ? toCardRow(row) : null
  }

  async resolveAgentSlug(orgId: string, slug: string): Promise<string | null> {
    const agent = await this.db.agent.findUnique({
      where: { orgId_name: { orgId, name: slug.toLowerCase() } },
      select: { id: true }
    })
    return agent?.id ?? null
  }

  setAssignee(input: KanbanSetAssigneeInput): Promise<KanbanSetAssigneeResult> {
    return withAmbientTx(this.db, async (tx) => {
      // The row lock orders this write against a claim (which skips locked cards) and against run ends.
      const [card] = await tx.$queryRaw<Array<{ id: string; orgId: string }>>(Prisma.sql`
        SELECT c."id", b."orgId" FROM "kanban_card" c JOIN "kanban_board" b ON b."id" = c."boardId"
        WHERE c."id" = ${input.cardId}::uuid
        FOR UPDATE OF c
      `)
      if (!card) return { ok: false, reason: 'not_found' }
      const current = await tx.kanbanCard.findUniqueOrThrow({ where: { id: card.id }, select: CARD_ROW_SELECT })
      if (input.expectedDispatchRevision !== undefined && current.dispatchRevision !== input.expectedDispatchRevision) {
        return { ok: false, reason: 'stale' }
      }
      if (current.assigneeAgentId === input.agentId) {
        return {
          ok: true,
          changed: false,
          card: toCardRow(current),
          previousAgentId: current.assigneeAgentId,
          revokedLease: null
        }
      }
      if (input.agentId !== null && !(await this.agentInOrg(card.orgId, input.agentId, tx))) {
        return { ok: false, reason: 'agent_not_in_org' }
      }
      const [open] = await tx.$queryRaw<KanbanLeaseRef[]>(Prisma.sql`
        SELECT "leaseId", "id" AS "runId", "agentId", "daemonId", "dispatchRevision" FROM "kanban_run"
        WHERE "cardId" = ${card.id}::uuid AND "endedAt" IS NULL
        FOR UPDATE
      `)
      if (open && input.onLease !== 'revoke') return { ok: false, reason: 'leased', lease: open }

      if (open) {
        // Reassignment never transfers: the old run ends as reclaimed, which never counts as a failure.
        await tx.kanbanRun.update({
          where: { id: open.runId },
          data: { endedAt: input.now, outcome: 'reclaimed', reasonCode: 'reassigned' }
        })
      }
      const restart = open !== undefined && current.status === 'running'
      const updated = await tx.kanbanCard.update({
        where: { id: card.id },
        data: {
          assigneeAgentId: input.agentId,
          // A new generation fences every late write of the superseded holder, as a claim or run end does.
          dispatchRevision: { increment: 1 },
          ...(restart ? { status: 'ready', stateRevision: { increment: 1 }, ...PROMOTION_CLEARED } : {})
        },
        select: CARD_ROW_SELECT
      })
      await tx.auditEvent.create({
        data: {
          kind: 'kanban_card_change',
          orgId: card.orgId,
          actorUserId: input.actorUserId ?? null,
          agentId: input.actorAgentId ?? null,
          message: `kanban card ${card.id} assignee changed`,
          details: {
            boardId: updated.boardId,
            cardId: updated.id,
            issueNumber: updated.issueNumber,
            change: 'assignee',
            fromAgentId: current.assigneeAgentId,
            toAgentId: input.agentId,
            revokedLeaseId: open?.leaseId ?? null,
            from: current.status,
            to: updated.status,
            source: input.source
          }
        }
      })
      return {
        ok: true,
        changed: true,
        card: toCardRow(updated),
        previousAgentId: current.assigneeAgentId,
        revokedLease: open ?? null
      }
    })
  }

  private async agentInOrg(orgId: string, agentId: string, db: PrismaLike = this.db): Promise<boolean> {
    const agent = await db.agent.findFirst({ where: { id: agentId, orgId }, select: { id: true } })
    return agent !== null
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

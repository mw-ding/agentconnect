// Kanban repos (issue #2 M1): PgKanbanBoardRepo serves the doorbell and redelivery sweep; PgKanbanCardRepo the graph reconciler.
import { randomUUID } from 'node:crypto'
import { OrgId } from '../../domain/ids.js'
import { Prisma } from '../../generated/prisma/client.js'
import { withAmbientTx, type PrismaLike } from '../prisma.js'
import { lockResourceWriteMemberships } from '../resource-membership-lock.js'
import { isKanbanStatus, type KanbanStatus } from '../../kanban/card-state.js'
import { isAttestedHumanAuthority } from '../../kanban/human-authority.js'
import { hasWriteAccess } from '../../github/repo-permission.js'
import {
  KanbanCardUpsertError,
  type KanbanBoardAdminRepo,
  type KanbanBoardConfigInput,
  type KanbanBoardCreateInput,
  type KanbanBoardRecord,
  type KanbanBoardRepo,
  type KanbanBoardView,
  type KanbanBoardWriteResult,
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

const BOARD_VIEW_SELECT = {
  id: true,
  orgId: true,
  name: true,
  repoId: true,
  repoFullName: true,
  orchestratorAgentId: true,
  verifierAgentId: true,
  maxInProgress: true,
  maxInProgressPerAgent: true,
  epicMaxCards: true,
  epicMaxActive: true,
  staleLeaseSec: true,
  failureLimit: true,
  protocolRetryLimit: true,
  blockRecurrenceLimit: true,
  defaultMode: true,
  completionContract: true,
  enabled: true,
  configRevision: true,
  visibility: true,
  sharedWith: true,
  createdByUserId: true,
  lastModifiedByUserId: true,
  lastModifiedAt: true,
  createdAt: true
} as const

const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'

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

export class PgKanbanBoardRepo implements KanbanBoardRepo, KanbanModeAdminRepo, KanbanBoardAdminRepo {
  constructor(private readonly db: PrismaLike) {}

  async listForOrg(orgId: string): Promise<KanbanBoardView[]> {
    const rows = await this.db.kanbanBoard.findMany({
      where: { orgId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: BOARD_VIEW_SELECT
    })
    return rows.map(toBoardView)
  }

  async getForOrg(orgId: string, boardId: string): Promise<KanbanBoardView | null> {
    const row = await this.db.kanbanBoard.findFirst({ where: { id: boardId, orgId }, select: BOARD_VIEW_SELECT })
    return row ? toBoardView(row) : null
  }

  async createBoard(
    orgId: string,
    userId: string,
    input: KanbanBoardCreateInput
  ): Promise<KanbanBoardWriteResult<KanbanBoardView>> {
    try {
      return await withAmbientTx(this.db, async (tx) => {
        await lockResourceWriteMemberships(tx, {
          orgId,
          actorUserId: userId,
          visibility: 'org',
          sharedWith: input.sharedWith
        })
        if (!(await isOwner(tx, orgId, userId))) return { ok: false, reason: 'not_found' }
        const config = await normalizeConfig(tx, orgId, input)
        if (!config.ok) return config
        if (await tx.kanbanBoard.findFirst({ where: { orgId, repoId: input.repoId }, select: { id: true } })) {
          return { ok: false, reason: 'repo_taken' }
        }
        const row = await tx.kanbanBoard.create({
          data: {
            ...config.value,
            name: input.name,
            repoId: input.repoId,
            repoFullName: input.repoFullName,
            orgId,
            createdByUserId: userId,
            lastModifiedByUserId: userId
          },
          select: BOARD_VIEW_SELECT
        })
        await auditBoard(tx, orgId, userId, row.id, 'created', Object.keys(config.value), row.repoId)
        return { ok: true, value: toBoardView(row) }
      })
    } catch (err) {
      // Two owners racing to the same repository: the (orgId, repoId) unique decides.
      if (isUniqueViolation(err)) return { ok: false, reason: 'repo_taken' }
      throw err
    }
  }

  async updateBoard(
    orgId: string,
    boardId: string,
    userId: string,
    patch: KanbanBoardConfigInput
  ): Promise<KanbanBoardWriteResult<KanbanBoardView>> {
    try {
      return await withAmbientTx(this.db, async (tx) => {
        await lockResourceWriteMemberships(tx, {
          orgId,
          actorUserId: userId,
          visibility: 'org',
          sharedWith: patch.sharedWith
        })
        await tx.$queryRaw`
          SELECT "id" FROM "kanban_board" WHERE "id" = ${boardId}::uuid AND "orgId" = ${orgId} FOR UPDATE
        `
        if (!(await isOwner(tx, orgId, userId))) return { ok: false, reason: 'not_found' }
        const current = await tx.kanbanBoard.findFirst({ where: { id: boardId, orgId }, select: BOARD_VIEW_SELECT })
        if (!current) return { ok: false, reason: 'not_found' }
        if (
          patch.repoId !== undefined &&
          patch.repoId !== current.repoId &&
          (await tx.kanbanCard.count({ where: { boardId } })) > 0
        ) {
          return { ok: false, reason: 'repo_has_cards' }
        }
        // Restricting a board keeps its current audience unless the patch names a new one.
        const config = await normalizeConfig(tx, orgId, {
          ...patch,
          visibility: patch.visibility ?? current.visibility,
          sharedWith: patch.sharedWith ?? current.sharedWith
        })
        if (!config.ok) return config
        const changed = Object.keys(config.value).filter(
          (k) => !sameValue(current[k as keyof typeof current], config.value[k as keyof typeof config.value])
        )
        if (changed.length === 0) return { ok: true, value: toBoardView(current) }
        const row = await tx.kanbanBoard.update({
          where: { id: boardId },
          data: {
            ...config.value,
            configRevision: { increment: 1 },
            lastModifiedByUserId: userId,
            lastModifiedAt: new Date()
          },
          select: BOARD_VIEW_SELECT
        })
        await auditBoard(tx, orgId, userId, boardId, 'updated', changed, row.repoId)
        return { ok: true, value: toBoardView(row) }
      })
    } catch (err) {
      if (isUniqueViolation(err)) return { ok: false, reason: 'repo_taken' }
      throw err
    }
  }

  async deleteBoard(orgId: string, boardId: string, userId: string): Promise<KanbanBoardWriteResult<null>> {
    return withAmbientTx(this.db, async (tx) => {
      // The board lock is the claim mutex, so no lease can be minted between this check and the delete.
      const [board] = await tx.$queryRaw<Array<{ id: string; repoId: bigint }>>`
        SELECT "id", "repoId" FROM "kanban_board" WHERE "id" = ${boardId}::uuid AND "orgId" = ${orgId} FOR UPDATE
      `
      if (!board || !(await isOwner(tx, orgId, userId))) return { ok: false, reason: 'not_found' }
      const open = await tx.kanbanRun.count({ where: { endedAt: null, card: { boardId } } })
      if (open > 0) return { ok: false, reason: 'active_runs' }
      await tx.kanbanBoard.delete({ where: { id: boardId } })
      await auditBoard(tx, orgId, userId, boardId, 'deleted', [], board.repoId)
      return { ok: true, value: null }
    })
  }

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
    // Agents file into triage/todo; anything further needs a live-verified human writer via import, never an agent.
    if (!UNATTENDED_STATUSES.has(status) && !humanAuthorized(input)) {
      throw new KanbanCardUpsertError('status_not_allowed')
    }
    const key = input.idempotencyKey ?? null
    const authority = humanAuthorized(input) ? input.humanAuthority! : null
    return withAmbientTx(this.db, async (tx) => {
      // FOR SHARE serializes against updateBoard's FOR UPDATE, so a retarget cannot slip between this check and the insert.
      const [board] = await tx.$queryRaw<Array<{ orgId: string; repoId: bigint }>>(Prisma.sql`
        SELECT "orgId", "repoId" FROM "kanban_board" WHERE "id" = ${input.boardId}::uuid FOR SHARE
      `)
      if (!board) throw new KanbanCardUpsertError('board_not_found')
      if (board.repoId !== input.expectedRepoId) throw new KanbanCardUpsertError('repo_mismatch')
      if (input.assigneeAgentId) {
        const refusal = await assigneeRefusal(tx, board.orgId, input.assigneeAgentId)
        if (refusal) throw new KanbanCardUpsertError(refusal)
      }
      const audit = (cardId: string, issueNumber: number, message: string, details: Record<string, unknown>) =>
        tx.auditEvent.create({
          data: {
            kind: 'kanban_card_change',
            orgId: board.orgId,
            actorUserId: input.actorUserId ?? null,
            agentId: input.actorAgentId ?? null,
            message: `kanban card ${cardId} ${message}`,
            details: { boardId: input.boardId, cardId, issueNumber, ...details, source: input.source }
          }
        })
      for (let attempt = 0; attempt < UPSERT_ATTEMPTS; attempt++) {
        // ON CONFLICT DO NOTHING covers all three uniques (issue id, number, key) without aborting an ambient transaction.
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
              // Never from the input, even a cast one: only setCardMode (audited, revisioned) sets an override.
              mode: null
            }
          ],
          skipDuplicates: true,
          select: CARD_ROW_SELECT
        })
        if (row) {
          await audit(row.id, row.issueNumber, 'created', {
            change: 'created',
            to: row.status,
            assigneeAgentId: row.assigneeAgentId,
            keyed: key !== null,
            humanAuthority: authority ? { login: authority.login, permission: authority.permission } : null
          })
          return { card: toCardRow(row), created: true, matchedBy: 'created' }
        }

        // The key outranks the issue: a re-plan that already filed this spec gets that card back, whatever issue it names.
        if (key !== null) {
          const byKey = await tx.kanbanCard.findUnique({
            where: { boardId_idempotencyKey: { boardId: input.boardId, idempotencyKey: key } },
            select: CARD_ROW_SELECT
          })
          if (byKey) return { card: toCardRow(byKey), created: false, matchedBy: 'idempotency_key' }
        }
        const byIssue = await tx.kanbanCard.findFirst({
          where: {
            boardId: input.boardId,
            OR: [{ issueId: input.issueId }, { issueNumber: input.issueNumber }]
          },
          orderBy: { createdAt: 'asc' },
          select: CARD_ROW_SELECT
        })
        if (!byIssue) continue
        // The number now names another issue (e.g. one transferred in after this card's issue left).
        if (byIssue.issueId !== input.issueId) throw new KanbanCardUpsertError('issue_mismatch')
        if (key === null || byIssue.idempotencyKey === key) {
          return { card: toCardRow(byIssue), created: false, matchedBy: 'issue' }
        }
        if (byIssue.idempotencyKey !== null) throw new KanbanCardUpsertError('key_conflict')
        // An imported card adopts the orchestrator's key; the savepoint keeps a racing P2002 from aborting the transaction.
        await tx.$executeRaw`SAVEPOINT kanban_key_adopt`
        let count = 0
        try {
          ;({ count } = await tx.kanbanCard.updateMany({
            where: { id: byIssue.id, idempotencyKey: null },
            data: { idempotencyKey: key }
          }))
          await tx.$executeRaw`RELEASE SAVEPOINT kanban_key_adopt`
        } catch (err) {
          await tx.$executeRaw`ROLLBACK TO SAVEPOINT kanban_key_adopt`
          // A concurrent upsert attached the same key to another card first; that card is the answer.
          if (!isUniqueViolation(err)) throw err
        }
        if (count === 1) {
          await audit(byIssue.id, byIssue.issueNumber, 'key attached', { change: 'key_attached' })
          return { card: toCardRow({ ...byIssue, idempotencyKey: key }), created: false, matchedBy: 'issue' }
        }
      }
      throw new Error('kanban card upsert: the conflicting card vanished on every attempt')
    })
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
      select: { id: true, visibility: true }
    })
    // Restricted agents serve a named audience, never a board-wide label; a paused agent resolves and claim skips it.
    return agent && agent.visibility !== 'restricted' ? agent.id : null
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
      const refusal = input.agentId !== null ? await assigneeRefusal(tx, card.orgId, input.agentId) : null
      if (refusal) return { ok: false, reason: refusal }
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

/** Statuses any caller may file a card in; nothing in them is claimable without a later human-gated move. */
const UNATTENDED_STATUSES: ReadonlySet<string> = new Set(['triage', 'todo'])

function humanAuthorized(input: KanbanCardUpsertInput): boolean {
  const authority = input.humanAuthority
  return (
    input.source === 'import' &&
    !input.actorAgentId &&
    isAttestedHumanAuthority(authority) &&
    !!authority.login &&
    hasWriteAccess(authority.permission)
  )
}

/** The same assignee policy for upsert and setAssignee: an agent of the org that is not restricted to an audience. */
async function assigneeRefusal(
  db: PrismaLike,
  orgId: string,
  agentId: string
): Promise<'agent_not_in_org' | 'agent_not_assignable' | null> {
  const agent = await db.agent.findFirst({ where: { id: agentId, orgId }, select: { visibility: true } })
  if (!agent) return 'agent_not_in_org'
  return agent.visibility === 'restricted' ? 'agent_not_assignable' : null
}

async function isOwner(tx: Prisma.TransactionClient, orgId: string, userId: string): Promise<boolean> {
  const member = await tx.membership.findFirst({ where: { orgId, userId, role: 'owner' }, select: { userId: true } })
  return member !== null
}

type BoardData = Omit<KanbanBoardConfigInput, 'visibility'> & { visibility?: 'org' | 'restricted' }

/** Same-org agent references and a current-member audience, checked inside the write transaction. */
async function normalizeConfig(
  tx: Prisma.TransactionClient,
  orgId: string,
  input: KanbanBoardConfigInput
): Promise<KanbanBoardWriteResult<BoardData>> {
  const data: BoardData = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) (data as Record<string, unknown>)[key] = value
  }
  const agentIds = [data.orchestratorAgentId, data.verifierAgentId].filter((id): id is string => !!id)
  if (agentIds.length > 0) {
    const found = await tx.agent.count({ where: { orgId, id: { in: [...new Set(agentIds)] } } })
    if (found !== new Set(agentIds).size) return { ok: false, reason: 'agent_not_in_org' }
  }
  if (data.sharedWith !== undefined) {
    const members = await tx.membership.findMany({
      where: { orgId, userId: { in: data.sharedWith } },
      select: { userId: true }
    })
    const current = new Set(members.map((m) => m.userId))
    data.sharedWith = [...new Set(data.sharedWith)].filter((id) => current.has(id))
  }
  if (data.visibility === 'restricted' && (data.sharedWith ?? []).length === 0) {
    return { ok: false, reason: 'empty_audience' }
  }
  return { ok: true, value: data }
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i])
  return a === b
}

// Field names only: the audit row never carries the board's values beyond its repository id.
async function auditBoard(
  tx: Prisma.TransactionClient,
  orgId: string,
  userId: string,
  boardId: string,
  change: 'created' | 'updated' | 'deleted',
  fields: string[],
  repoId: bigint
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      kind: 'kanban_board_change',
      orgId,
      actorUserId: userId,
      message: `kanban board ${boardId} ${change}`,
      details: { boardId, change, fields: [...fields].sort(), repoId: repoId.toString() }
    }
  })
}

function toBoardView(row: Omit<KanbanBoardView, 'orgId'> & { orgId: string }): KanbanBoardView {
  return { ...row, orgId: OrgId(row.orgId) }
}

// Kanban repos (issue #2 M1): PgKanbanBoardRepo serves the doorbell and redelivery sweep; PgKanbanCardRepo the graph reconciler.
import { insertKanbanNotification } from './kanban-notify.repo.js'
import { planNotification } from '../../kanban/notifier.js'
import { applyCardTransition, auditCardTransition } from '../../kanban/audit.js'
import { randomUUID } from 'node:crypto'
import { OrgId } from '../../domain/ids.js'
import { Prisma } from '../../generated/prisma/client.js'
import { withAmbientTx, type PrismaLike } from '../prisma.js'
import { lockResourceWriteMemberships } from '../resource-membership-lock.js'
import {
  canTransition,
  endsEpisode,
  EPISODE_RESET,
  isKanbanStatus,
  type KanbanStatus
} from '../../kanban/card-state.js'
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
  type KanbanCardControlInput,
  type KanbanCardControlPeek,
  type KanbanCardControlRepo,
  type KanbanCardControlResult,
  type KanbanCardRecord,
  type KanbanCardRepo,
  type KanbanCardRow,
  type KanbanRestartInput,
  type KanbanCardUpsertInput,
  type KanbanCardUpsertResult,
  type KanbanCommandInput,
  type KanbanCommandRecord,
  type KanbanCommandRecordResult,
  type KanbanLeaseRef,
  type KanbanModeAdminRepo,
  type KanbanSetAssigneeInput,
  type KanbanSetAssigneeResult
} from '../ports.js'

const BOARD_SELECT = {
  id: true,
  orgId: true,
  name: true,
  repoId: true,
  repoFullName: true,
  synthesizerAgentId: true
} as const

const CARD_ROW_SELECT = {
  id: true,
  boardId: true,
  issueId: true,
  issueNumber: true,
  issueNodeId: true,
  projectItemId: true,
  projectItemProjectId: true,
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
  synthesizerAgentId: true,
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
  projectNodeId: true,
  statusFieldId: true,
  enabled: true,
  paused: true,
  pausedAt: true,
  pausedByUserId: true,
  configRevision: true,
  visibility: true,
  sharedWith: true,
  createdByUserId: true,
  lastModifiedByUserId: true,
  lastModifiedAt: true,
  createdAt: true
} as const

const COMMAND_SELECT = {
  id: true,
  boardId: true,
  cardId: true,
  commentId: true,
  command: true,
  actorLogin: true,
  outcome: true,
  fromStatus: true,
  toStatus: true,
  settledAt: true,
  createdAt: true
} as const

/** Thrown inside the command transaction so a lost CAS also rolls back its ledger row. */
const STALE_COMMAND = new Error('kanban command: card changed since it was read')

function toCommandRecord(row: {
  id: string
  boardId: string
  cardId: string
  commentId: bigint
  command: string
  actorLogin: string
  outcome: string
  fromStatus: string
  toStatus: string | null
  settledAt: Date | null
  createdAt: Date
}): KanbanCommandRecord {
  return { ...row, fromStatus: row.fromStatus as KanbanStatus, toStatus: row.toStatus as KanbanStatus | null }
}

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
    patch: KanbanBoardConfigInput,
    expectedConfigRevision?: bigint
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
        // The route's GitHub guard must still describe the configuration locked here.
        if (expectedConfigRevision !== undefined && current.configRevision !== expectedConfigRevision)
          return { ok: false, reason: 'stale' }
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

  async setPaused(
    orgId: string,
    boardId: string,
    userId: string,
    paused: boolean
  ): Promise<KanbanBoardWriteResult<KanbanBoardView>> {
    return withAmbientTx(this.db, async (tx) => {
      // The board row is the claim mutex, so a pause cannot race a claim reading `paused`.
      await tx.$queryRaw`
        SELECT "id" FROM "kanban_board" WHERE "id" = ${boardId}::uuid AND "orgId" = ${orgId} FOR UPDATE
      `
      if (!(await isOwner(tx, orgId, userId))) return { ok: false, reason: 'not_found' }
      const current = await tx.kanbanBoard.findFirst({ where: { id: boardId, orgId }, select: BOARD_VIEW_SELECT })
      if (!current) return { ok: false, reason: 'not_found' }
      // Idempotent: re-pausing or re-resuming writes nothing and leaves no audit row.
      if (current.paused === paused) return { ok: true, value: toBoardView(current) }
      const row = await tx.kanbanBoard.update({
        where: { id: boardId },
        data: {
          paused,
          pausedAt: paused ? new Date() : null,
          pausedByUserId: paused ? userId : null,
          configRevision: { increment: 1 },
          lastModifiedByUserId: userId,
          lastModifiedAt: new Date()
        },
        select: BOARD_VIEW_SELECT
      })
      await tx.auditEvent.create({
        data: {
          kind: paused ? 'board_paused' : 'board_resumed',
          orgId,
          actorUserId: userId,
          message: `kanban board ${boardId} ${paused ? 'paused' : 'resumed'}`,
          details: { boardId }
        }
      })
      return { ok: true, value: toBoardView(row) }
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

  async refreshRepoFullName(boardId: string, repoId: bigint, repoFullName: string): Promise<boolean> {
    return withAmbientTx(this.db, async (tx) => {
      const current = await tx.kanbanBoard.findFirst({
        where: { id: boardId, repoId },
        select: { orgId: true, repoFullName: true }
      })
      if (!current) return false
      if (current.repoFullName === repoFullName) return true
      // Compare-and-set on the name read above, so two replicas observing one rename audit it once.
      const { count } = await tx.kanbanBoard.updateMany({
        where: { id: boardId, repoId, repoFullName: current.repoFullName },
        data: { repoFullName }
      })
      if (count === 1) await auditBoard(tx, current.orgId, null, boardId, 'repo_renamed', ['repoFullName'], repoId)
      return count === 1
    })
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

export class PgKanbanCardRepo implements KanbanCardRepo, KanbanCardControlRepo {
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
    // A flagged card is a human's: only a human status move (label sync, /kanban restart or skip) lifts the hold.
    return applyCardTransition(
      this.db,
      { id: cardId, stateRevision: expectedStateRevision, needsAttention: false },
      { status: to, stateRevision: { increment: 1 }, githubSyncedAt: new Date(), ...PROMOTION_CLEARED },
      'cas_status'
    )
  }

  async beginPromotion(
    cardId: string,
    expectedStateRevision: bigint,
    eventCursor: bigint,
    startedAt: Date
  ): Promise<boolean> {
    // One write for the ready CAS and the intent; an open intent keeps its caps, and a flagged card is a human's.
    return applyCardTransition(
      this.db,
      {
        id: cardId,
        stateRevision: expectedStateRevision,
        status: 'todo',
        promotionPending: false,
        needsAttention: false
      },
      {
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
      },
      'graph_promotion'
    )
  }

  async notePromotionPosted(cardId: string): Promise<void> {
    await this.db.kanbanCard.updateMany({
      where: { id: cardId, promotionPending: true },
      data: { promotionPostAccepted: true }
    })
  }

  async beginSynthesis(
    cardId: string,
    expectedStateRevision: bigint,
    eventCursor: bigint,
    startedAt: Date,
    assigneeAgentId: string
  ): Promise<boolean> {
    return withAmbientTx(this.db, async (tx) => {
      const [row] = await tx.$queryRaw<
        Array<{ boardId: string; issueNumber: number; targetChannel: string | null }>
      >(Prisma.sql`
        SELECT c."boardId", c."issueNumber", b."targetChannel"
        FROM "kanban_card" c JOIN "kanban_board" b ON b."id" = c."boardId"
        WHERE c."id" = ${cardId}::uuid AND c."stateRevision" = ${expectedStateRevision}
          AND c."status" = 'todo' AND NOT c."promotionPending" AND NOT c."needsAttention"
        FOR UPDATE OF c
      `)
      if (!row) return false
      const { count } = await tx.kanbanCard.updateMany({
        where: {
          id: cardId,
          stateRevision: expectedStateRevision,
          status: 'todo',
          promotionPending: false,
          needsAttention: false
        },
        data: {
          status: 'ready',
          assigneeAgentId,
          stateRevision: { increment: 1 },
          githubSyncedAt: new Date(),
          ...PROMOTION_CLEARED,
          promotionPending: true,
          promotionEventCursor: eventCursor,
          promotionStartedAt: startedAt,
          promotionWatchUntil: new Date(startedAt.getTime() + PROMOTION_WATCH_MS),
          recoveryCheckAt: new Date(startedAt.getTime() + 60_000),
          recoveryChecks: 0
        }
      })
      if (count !== 1) return false
      const transition = {
        cardId,
        boardId: row.boardId,
        issueNumber: row.issueNumber,
        from: 'todo',
        to: 'ready',
        reasonCode: 'synthesis'
      } as const
      const decision = planNotification(transition, row)
      if (decision.notify)
        await insertKanbanNotification(tx, {
          ...transition,
          stateRevision: expectedStateRevision + 1n,
          mention: decision.mention
        })
      return true
    })
  }

  async clearPromotionIntent(cardId: string): Promise<boolean> {
    const { count } = await this.db.kanbanCard.updateMany({
      where: { id: cardId, status: 'ready', promotionPending: true },
      data: { ...PROMOTION_CLEARED, labelWritePending: false }
    })
    return count === 1
  }

  async revertPromotion(cardId: string, expectedStateRevision: bigint, revertedAt: Date): Promise<boolean> {
    // The timed-out POST can still land after this rollback, so the watch restarts from now.
    return applyCardTransition(
      this.db,
      { id: cardId, stateRevision: expectedStateRevision, status: 'ready', promotionPending: true },
      {
        status: 'todo',
        stateRevision: { increment: 1 },
        promotionWatchUntil: new Date(revertedAt.getTime() + PROMOTION_WATCH_MS),
        recoveryCheckAt: null,
        recoveryChecks: 0
      },
      'graph_rollback'
    )
  }

  async getCommand(boardId: string, commentId: bigint): Promise<KanbanCommandRecord | null> {
    const row = await this.db.kanbanCommand.findUnique({
      where: { boardId_commentId: { boardId, commentId } },
      select: COMMAND_SELECT
    })
    return row ? toCommandRecord(row) : null
  }

  async recordCommand(input: KanbanCommandInput): Promise<KanbanCommandRecordResult> {
    const applied = input.to !== undefined
    // A move needs the live-attested writer, never a login string; a refusal records who asked and why.
    if (
      applied &&
      !(isAttestedHumanAuthority(input.humanAuthority) && hasWriteAccess(input.humanAuthority.permission))
    ) {
      throw new Error('kanban command: an applied move requires an attested human writer')
    }
    try {
      return await withAmbientTx(this.db, async (tx) => {
        const [row] = await tx.kanbanCommand.createManyAndReturn({
          data: [
            {
              id: randomUUID(),
              boardId: input.boardId,
              cardId: input.cardId,
              commentId: input.commentId,
              command: input.command,
              actorLogin: input.actorLogin,
              outcome: applied ? 'applied' : (input.refusal ?? 'refused'),
              fromStatus: input.from,
              toStatus: input.to ?? null
            }
          ],
          skipDuplicates: true,
          select: COMMAND_SELECT
        })
        if (!row) {
          const existing = await tx.kanbanCommand.findUniqueOrThrow({
            where: { boardId_commentId: { boardId: input.boardId, commentId: input.commentId } },
            select: COMMAND_SELECT
          })
          return { kind: 'duplicate', record: toCommandRecord(existing) } as const
        }
        if (!applied) return { kind: 'recorded', record: toCommandRecord(row) } as const
        // The CAS refuses a card that moved or was leased since the read; the throw rolls the ledger row back too.
        const { count } = await tx.kanbanCard.updateMany({
          where: {
            id: input.cardId,
            boardId: input.boardId,
            stateRevision: input.expectedStateRevision,
            status: input.from,
            runs: { none: { endedAt: null } }
          },
          data: {
            status: input.to!,
            stateRevision: { increment: 1 },
            cooldownUntil: null,
            blockKind: null,
            recoveryCheckAt: null,
            recoveryChecks: 0,
            recoveryObserved: null,
            ...PROMOTION_CLEARED,
            ...(endsEpisode(input.from, input.to!) ? EPISODE_RESET : {})
          }
        })
        if (count !== 1) throw STALE_COMMAND
        const board = await tx.kanbanBoard.findUniqueOrThrow({
          where: { id: input.boardId },
          select: { orgId: true, targetChannel: true }
        })
        const card = await tx.kanbanCard.findUniqueOrThrow({
          where: { id: input.cardId },
          select: { issueNumber: true }
        })
        await tx.auditEvent.create({
          data: {
            kind: 'kanban_card_change',
            orgId: board.orgId,
            message: `kanban card ${input.cardId} status changed by comment command`,
            details: {
              boardId: input.boardId,
              cardId: input.cardId,
              issueNumber: card.issueNumber,
              change: 'status',
              from: input.from,
              to: input.to!,
              command: input.command,
              commentId: input.commentId.toString(),
              humanAuthority: { login: input.humanAuthority!.login, permission: input.humanAuthority!.permission },
              source: 'comment_command'
            }
          }
        })
        // The note commits or rolls back with the move; the CAS pinned stateRevision, so the new one is +1.
        const transition = {
          cardId: input.cardId,
          boardId: input.boardId,
          issueNumber: card.issueNumber,
          from: input.from,
          to: input.to!,
          reasonCode: 'comment_command'
        }
        const decision = planNotification(transition, board)
        if (decision.notify)
          await insertKanbanNotification(tx, {
            ...transition,
            stateRevision: input.expectedStateRevision + 1n,
            mention: decision.mention
          })
        return { kind: 'recorded', record: toCommandRecord(row) } as const
      })
    } catch (err) {
      if (err === STALE_COMMAND) return { kind: 'stale' }
      throw err
    }
  }

  async settleCommand(id: string): Promise<void> {
    await this.db.kanbanCommand.updateMany({ where: { id, settledAt: null }, data: { settledAt: new Date() } })
  }

  async claimCommandEffect(id: string, ttlMs: number): Promise<Date | null> {
    const ttlSec = ttlMs / 1000
    // Millisecond precision, so the holder's JS Date matches the row exactly when it releases.
    const [row] = await this.db.$queryRaw<Array<{ effectClaimedAt: Date }>>(Prisma.sql`
      UPDATE "kanban_command" SET "effectClaimedAt" = date_trunc('milliseconds', now())
      WHERE "id" = ${id}::uuid AND "settledAt" IS NULL
        AND ("effectClaimedAt" IS NULL OR "effectClaimedAt" <= now() - make_interval(secs => ${ttlSec}::float8))
      RETURNING "effectClaimedAt"
    `)
    return row?.effectClaimedAt ?? null
  }

  async releaseCommandEffect(id: string, claimedAt: Date): Promise<void> {
    await this.db.kanbanCommand.updateMany({
      where: { id, settledAt: null, effectClaimedAt: claimedAt },
      data: { effectClaimedAt: null }
    })
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
              syncEventCursor: input.syncEventCursor ?? 0n,
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
          ...(restart
            ? { status: 'ready', stateRevision: { increment: 1 }, labelWritePending: true, ...PROMOTION_CLEARED }
            : {})
        },
        select: CARD_ROW_SELECT
      })
      await auditCardTransition(tx, {
        cardId: card.id,
        from: current.status,
        to: updated.status,
        source: input.source,
        ...(open ? { leaseId: open.leaseId } : {})
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
            source: input.source,
            ...(input.actorLogin ? { actorLogin: input.actorLogin, actorGitHubId: input.actorGitHubId ?? null } : {})
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

  skipCard(input: KanbanCardControlInput): Promise<KanbanCardControlResult> {
    return this.controlCard(input, 'archived', 'card_skipped', 'skipped', 'skip')
  }

  restartCard(input: KanbanRestartInput): Promise<KanbanCardControlResult> {
    return this.controlCard(input, 'ready', 'card_restarted', 'restarted', 'restart')
  }

  async peekControl(orgId: string, boardId: string, cardId: string): Promise<KanbanCardControlPeek | null> {
    const row = await this.db.kanbanCard.findFirst({
      where: { id: cardId, boardId, board: { orgId } },
      select: { issueNumber: true, linkedPrNumber: true, board: { select: { repoId: true, repoFullName: true } } }
    })
    if (!row) return null
    return {
      issueNumber: row.issueNumber,
      linkedPrNumber: row.linkedPrNumber,
      orgId: OrgId(orgId),
      repoId: row.board.repoId,
      repoFullName: row.board.repoFullName
    }
  }

  async isLatestControl(cardId: string, version: bigint): Promise<boolean> {
    return (await this.db.kanbanCard.count({ where: { id: cardId, controlVersion: version } })) === 1
  }

  async markControlWritten(cardId: string, version: bigint, stateRevision: bigint): Promise<boolean> {
    // The control's write only settles its own move: a later move keeps the label write it still owes.
    const count = await this.db.$executeRaw(Prisma.sql`
      UPDATE "kanban_card" SET "controlWrittenVersion" = ${version},
        "labelWritePending" = CASE WHEN "stateRevision" = ${stateRevision} THEN false ELSE "labelWritePending" END
      WHERE "id" = ${cardId}::uuid AND "controlVersion" = ${version} AND "controlWrittenVersion" < ${version}
    `)
    return count === 1
  }

  /** The shared B5 control write: revoke any open lease (bumping the fence), move the card, and audit — all in one transaction. */
  private controlCard(
    input: KanbanRestartInput,
    to: KanbanStatus,
    auditKind: 'card_skipped' | 'card_restarted',
    reasonCode: string,
    source: 'skip' | 'restart'
  ): Promise<KanbanCardControlResult> {
    return withAmbientTx(this.db, async (tx) => {
      // The card lock orders this write against a claim (which skips locked cards) and against run ends.
      const [row] = await tx.$queryRaw<
        Array<{
          id: string
          status: string
          stateRevision: bigint
          issueNumber: number
          orgId: string
          repoId: bigint
          repoFullName: string
          targetChannel: string | null
          linkedPrNumber: number | null
          controlVersion: bigint
        }>
      >(
        Prisma.sql`
          SELECT c."id", c."status", c."stateRevision", c."issueNumber", c."linkedPrNumber", c."controlVersion", b."orgId", b."repoId", b."repoFullName", b."targetChannel"
          FROM "kanban_card" c JOIN "kanban_board" b ON b."id" = c."boardId"
          WHERE c."id" = ${input.cardId}::uuid AND c."boardId" = ${input.boardId}::uuid AND b."orgId" = ${input.orgId}
          FOR UPDATE OF c
        `
      )
      if (!row) return { ok: false, reason: 'not_found' }
      if (!isKanbanStatus(row.status)) return { ok: false, reason: 'illegal_transition' }
      const outcome = {
        cardId: row.id,
        issueNumber: row.issueNumber,
        from: row.status,
        status: to,
        orgId: OrgId(row.orgId),
        repoId: row.repoId,
        repoFullName: row.repoFullName,
        supersededPrNumber: null,
        controlVersion: row.controlVersion,
        stateRevision: row.stateRevision,
        controlAt: new Date()
      }
      // A repeated skip is idempotent: an archived card holds no lease, so there is nothing to revoke, move, audit or write.
      if (to === 'archived' && row.status === 'archived')
        return { ok: true, value: { ...outcome, changed: false, revokedLease: null } }
      // Restart routes archived→triage→ready (the table's two-hop path) in one write and never lifts a todo card past its blockers.
      const legal =
        to === 'ready'
          ? row.status !== 'todo' &&
            (canTransition(row.status, to) || row.status === 'archived' || row.status === 'ready')
          : canTransition(row.status, to)
      if (!legal) return { ok: false, reason: 'illegal_transition' }
      const [open] = await tx.$queryRaw<KanbanLeaseRef[]>(Prisma.sql`
        SELECT "leaseId", "id" AS "runId", "agentId", "daemonId", "dispatchRevision" FROM "kanban_run"
        WHERE "cardId" = ${row.id}::uuid AND "endedAt" IS NULL
        FOR UPDATE
      `)
      if (open) {
        // Reassignment never transfers: the ended run is reclaimed so its late writes fail the fence, counting no failure.
        await tx.kanbanRun.update({
          where: { id: open.runId },
          data: { endedAt: new Date(), outcome: 'reclaimed', reasonCode }
        })
      }
      const reset = {
        consecutiveFailures: 0,
        protocolViolations: 0,
        blockRecurrence: 0,
        cooldownUntil: null,
        blockKind: null,
        verifiedAt: null,
        reviewRounds: 0,
        // A restart starts a new work episode, so a PR bound to the old one can never complete the card.
        ...EPISODE_RESET,
        ...PROMOTION_CLEARED
      }
      // The row lock makes concurrent retries of an already-reset ready card no-ops without suppressing a new reset.
      if (
        to === 'ready' &&
        row.status === 'ready' &&
        !open &&
        (await tx.kanbanCard.findFirst({
          // A retry keeps the first restart's close target, so the target is no part of "already reset".
          where: { id: row.id, ...reset, contractFlags: { equals: [] }, supersededPrNumber: undefined },
          select: { id: true }
        }))
      )
        return { ok: true, value: { ...outcome, changed: false, revokedLease: null } }
      // Only a PR validated as this card's open card-branch PR, and still the linked one, becomes the close target.
      const superseded =
        to === 'ready' && input.validatedPrNumber != null && input.validatedPrNumber === row.linkedPrNumber
          ? row.linkedPrNumber
          : null
      const controlVersion = row.controlVersion + 1n
      const controlAt = new Date()
      // CAS under the row lock: the version this move commits is the one its GitHub write must still match.
      const { count } = await tx.kanbanCard.updateMany({
        where: { id: row.id, controlVersion: row.controlVersion },
        data: {
          status: to,
          controlVersion,
          // The comment's facts ride with the version, so a label-sync repair re-posts the same keyed comment.
          controlKind: source,
          controlActorLogin: source === 'skip' ? (input.actorLogin ?? null) : null,
          controlAt,
          stateRevision: { increment: 1 },
          dispatchRevision: { increment: 1 },
          githubSyncedAt: new Date(),
          // The GitHub write runs after commit; a failed one stays pending for the label sync's repair.
          labelWritePending: true,
          // A skip also drops any open promotion intent: recovery and the label sync never revisit an archived card.
          ...(to === 'ready' ? { ...reset, supersededPrNumber: superseded } : PROMOTION_CLEARED)
        }
      })
      if (count !== 1) throw new Error('kanban control version moved under the card lock')
      await auditCardTransition(tx, {
        cardId: row.id,
        from: row.status,
        to,
        source,
        ...(open ? { leaseId: open.leaseId } : {})
      })
      const transition = {
        cardId: row.id,
        boardId: input.boardId,
        issueNumber: row.issueNumber,
        from: row.status,
        to,
        reasonCode
      }
      const decision = planNotification(transition, row)
      if (decision.notify)
        await insertKanbanNotification(tx, {
          ...transition,
          stateRevision: row.stateRevision + 1n,
          mention: decision.mention
        })
      await tx.auditEvent.create({
        data: {
          kind: auditKind,
          orgId: row.orgId,
          actorUserId: input.actorUserId,
          message: `kanban card ${row.id} ${to === 'archived' ? 'skipped' : 'restarted'}`,
          details: {
            boardId: input.boardId,
            cardId: row.id,
            issueNumber: row.issueNumber,
            from: row.status,
            to,
            revokedLeaseId: open?.leaseId ?? null,
            source: input.source
          }
        }
      })
      return {
        ok: true,
        value: {
          ...outcome,
          changed: true,
          revokedLease: open ?? null,
          supersededPrNumber: superseded,
          controlVersion,
          stateRevision: row.stateRevision + 1n,
          controlAt
        }
      }
    })
  }

  // Best-effort projection cache: a lost item id only costs one more idempotent add, never a missed Status write.
  async setProjectItemId(cardId: string, projectNodeId: string, projectItemId: string): Promise<void> {
    await this.db.kanbanCard.updateMany({
      where: { id: cardId },
      data: { projectItemId, projectItemProjectId: projectNodeId }
    })
  }
}

function toCardRow(row: {
  id: string
  boardId: string
  issueId: bigint
  issueNumber: number
  issueNodeId: string | null
  projectItemId: string | null
  projectItemProjectId: string | null
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
  const agentIds = [data.orchestratorAgentId, data.verifierAgentId, data.synthesizerAgentId].filter(
    (id): id is string => !!id
  )
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
  userId: string | null,
  boardId: string,
  change: 'created' | 'updated' | 'deleted' | 'repo_renamed',
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

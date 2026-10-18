// PgKanbanDispatchRepo (issue #2 D2): the board row is the claim mutex (SKIP LOCKED), card rows are skipped while another writer holds them.
import { randomUUID } from 'node:crypto'
import { KANBAN_CARD_SHOW_MAX_RUNS, type KanbanReport } from '@agentconnect.md/protocol'
import { Prisma } from '../../generated/prisma/client.js'
import { OrgId } from '../../domain/ids.js'
import type { KanbanStatus } from '../../kanban/card-state.js'
import { leaseAcceptsWrite } from '../../kanban/reassign.js'
import { planNotification } from '../../kanban/notifier.js'
import { PROMOTION_CLEARED } from './kanban.repo.js'
import { insertKanbanNotification } from './kanban-notify.repo.js'
import { PROVIDER_TRANSIENT_LIMIT, type KanbanBlockKind } from '../../kanban/run-accounting.js'
import type { PrismaLike } from '../prisma.js'
import type {
  KanbanCardView,
  KanbanCardViewReq,
  KanbanClaimOpts,
  KanbanClaimResult,
  KanbanClaimedLease,
  KanbanContractCard,
  KanbanContractRepo,
  KanbanContractSettleInput,
  KanbanDispatchRepo,
  KanbanGrantScope,
  KanbanIngestResult,
  KanbanLeaseBeatInput,
  KanbanOpenLease,
  KanbanRecoveryDue,
  KanbanRunEndInput,
  KanbanRunEndResult,
  KanbanSelfVerifyFlag
} from '../ports.js'

/** Ready cards examined per claim; caps or offline daemons can skip some, so scan past the free room. */
const CLAIM_SCAN = 50
/** Mismatch recovery backoff: 1 min doubling to a 1 h ceiling, so a parked card costs at most ~1 read an hour. */
const RECOVERY_BASE_SEC = 60
const RECOVERY_MAX_SEC = 3600
/** Every status change settles recovery: the backoff, the last-read fingerprint, any unconfirmed promotion, and the flag. */
const RECOVERY_RESET = {
  recoveryCheckAt: null,
  recoveryChecks: 0,
  recoveryObserved: null,
  ...PROMOTION_CLEARED
} as const
/** Held for a human: the latest run ended as a pre-dispatch mismatch, or recovery gave up and flagged the card. */
const PARKED = Prisma.sql`(c."needsAttention" OR (latest."reasonCode" = 'github_state_mismatch' AND latest."endedAt" IS NOT NULL))`
const PENDING_UNLEASED = (id: string): Prisma.KanbanCardWhereInput => ({
  id,
  promotionPending: true,
  status: { in: ['todo', 'ready'] },
  runs: { none: { endedAt: null } }
})
const PROMOTION_COLUMNS = Prisma.sql`c."promotionEventCursor", c."promotionPostAccepted", c."promotionStartedAt",
  c."promotionWatchUntil", c."promotionChecks", c."recoveryCheckAt"`

/** An unleased review card with a linked PR on an enabled board under a PR completion contract. */
const CONTRACT_DUE = Prisma.sql`b."enabled" AND c."status" = 'review' AND c."linkedPrNumber" IS NOT NULL
  AND b."completionContract" <> 'close'
  AND NOT EXISTS (SELECT 1 FROM "kanban_run" r WHERE r."cardId" = c."id" AND r."endedAt" IS NULL)`
const CONTRACT_COLUMNS = Prisma.sql`c."id" AS "cardId", c."boardId", c."issueNumber", c."status", c."stateRevision",
  c."linkedPrNumber", c."verifiedAt", b."completionContract", b."verifierAgentId"`

interface BoardRow {
  id: string
  orgId: string
  repoId: bigint
  repoFullName: string
  defaultMode: 'read' | 'write'
  maxInProgress: number
  maxInProgressPerAgent: number
  verifierAgentId: string | null
}

interface CandidateRow {
  mode: 'read' | 'write' | null
  role: 'work' | 'verify'
  priority: number
  createdAt: Date
  id: string
  issueNumber: number
  agentId: string
  daemonId: string
  sessionEpoch: bigint
  assigneeAgentId: string | null
  /** The board's verifier wrote some work attempt on this card (B8 compares every attempt, not only the latest). */
  verifierDidWork: boolean
}

interface RunEndRow {
  dispatchedAt: Date
  ackedAt: Date | null
  heartbeatAt: Date | null
  daemonEpoch: bigint
  currentDaemonEpoch: bigint | null
  agentRowId: string | null
  agentDaemonId: string | null
  assigneeAgentId: string | null
  staleLeaseSec: number
  runId: string
  cardId: string
  attempt: number
  agentId: string
  daemonId: string
  role: 'work' | 'verify'
  runRevision: bigint
  endedAt: Date | null
  status: KanbanStatus
  cardRevision: bigint
  stateRevision: bigint
  consecutiveFailures: number
  protocolViolations: number
  blockRecurrence: number
  reviewRounds: number
  verifiedAt: Date | null
  cooldownUntil: Date | null
  blockKind: KanbanBlockKind | null
  boardId: string
  issueNumber: number
  orgId: string
  repoId: bigint
  repoFullName: string
  targetChannel: string | null
  failureLimit: number
  protocolRetryLimit: number
  blockRecurrenceLimit: number
  completionContract: 'close' | 'pr_merged' | 'pr_checks_green'
  verifierAgentId: string | null
}

export class PgKanbanDispatchRepo implements KanbanDispatchRepo, KanbanContractRepo {
  constructor(private readonly db: PrismaLike) {}

  private inTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    if ('$transaction' in this.db) return this.db.$transaction(fn)
    return fn(this.db as Prisma.TransactionClient)
  }

  async listEnabledBoardIds(): Promise<string[]> {
    const rows = await this.db.kanbanBoard.findMany({ where: { enabled: true }, select: { id: true } })
    return rows.map((r) => r.id)
  }

  claim(boardId: string, opts: KanbanClaimOpts): Promise<KanbanClaimResult> {
    return this.inTransaction(async (tx) => {
      // A concurrent claimer already holds this board: skip it rather than queue behind it.
      const [board] = await tx.$queryRaw<BoardRow[]>(Prisma.sql`
        SELECT "id", "orgId", "repoId", "repoFullName", "maxInProgress", "maxInProgressPerAgent", "defaultMode", "verifierAgentId"
        FROM "kanban_board"
        WHERE "id" = ${boardId}::uuid AND "enabled"
        FOR UPDATE SKIP LOCKED
      `)
      if (!board) return { leases: [], flaggedSelfVerify: [] }

      // In progress = an open lease, so an unacked dispatch already occupies its slot.
      const open = await tx.$queryRaw<{ agentId: string; n: number }[]>(Prisma.sql`
        SELECT r."agentId", count(*)::int AS "n"
        FROM "kanban_run" r JOIN "kanban_card" c ON c."id" = r."cardId"
        WHERE c."boardId" = ${boardId}::uuid AND r."endedAt" IS NULL
        GROUP BY r."agentId"
      `)
      const perAgent = new Map(open.map((r) => [r.agentId, r.n]))
      let inProgress = open.reduce((sum, r) => sum + r.n, 0)
      const room = Math.min(board.maxInProgress - inProgress, opts.limit ?? Number.POSITIVE_INFINITY)
      if (room <= 0) return { leases: [], flaggedSelfVerify: [] }

      const claimed: KanbanClaimedLease[] = []
      const flaggedSelfVerify: KanbanSelfVerifyFlag[] = []
      let cursor: CandidateRow | undefined
      while (claimed.length < room) {
        const candidates: CandidateRow[] = await tx.$queryRaw<CandidateRow[]>(Prisma.sql`
        SELECT c."id", c."issueNumber", c."mode", c."priority", c."createdAt",
               CASE WHEN c."status" = 'review' THEN ${board.verifierAgentId}::uuid ELSE c."assigneeAgentId" END AS "agentId",
               a."daemonId", d."sessionEpoch", c."assigneeAgentId",
               CASE WHEN c."status" = 'review' THEN 'verify'::"KanbanRunRole" ELSE 'work'::"KanbanRunRole" END AS "role",
               EXISTS (SELECT 1 FROM "kanban_run" w
                 WHERE w."cardId" = c."id" AND w."role" = 'work' AND w."agentId" = ${board.verifierAgentId}::uuid
               ) AS "verifierDidWork"
        FROM "kanban_card" c
        JOIN "agent" a ON a."id" = CASE WHEN c."status" = 'review' THEN ${board.verifierAgentId}::uuid ELSE c."assigneeAgentId" END
          AND a."orgId" = ${board.orgId} AND a."status" <> 'paused'
        JOIN "daemon" d ON d."id" = a."daemonId"
        WHERE c."boardId" = ${boardId}::uuid
          AND (c."status" = 'ready' OR (c."status" = 'review' AND ${board.verifierAgentId}::uuid IS NOT NULL
            -- An approval under a PR contract leaves the card in review; it waits for the PR, not another verify.
            AND c."verifiedAt" IS NULL))
          -- A flagged card is a human's until a human status move clears the flag; a board edit alone never lifts it.
          AND NOT c."needsAttention"
          ${
            cursor
              ? Prisma.sql`AND (c."priority" < ${cursor.priority} OR
            (c."priority" = ${cursor.priority} AND (c."createdAt", c."id") > (${cursor.createdAt}, ${cursor.id}::uuid)))`
              : Prisma.empty
          }
          AND NOT c."promotionPending"
          AND (c."cooldownUntil" IS NULL OR c."cooldownUntil" <= ${opts.now})
          AND (c."notBefore" IS NULL OR c."notBefore" <= ${opts.now})
          AND NOT EXISTS (SELECT 1 FROM "kanban_run" r WHERE r."cardId" = c."id" AND r."endedAt" IS NULL)
        ORDER BY c."priority" DESC, c."createdAt" ASC, c."id" ASC
        LIMIT ${CLAIM_SCAN}
        FOR UPDATE OF c SKIP LOCKED
      `)

        if (candidates.length === 0) break
        cursor = candidates.at(-1)
        for (const card of candidates) {
          if (claimed.length >= room || inProgress >= board.maxInProgress) break
          if ((perAgent.get(card.agentId) ?? 0) >= board.maxInProgressPerAgent) continue
          if (!opts.isDaemonLive(card.daemonId)) continue

          // B8 self-approval guard: a review card whose verifier is the worker is never dispatched; flag it once.
          if (card.role === 'verify' && (board.verifierAgentId === card.assigneeAgentId || card.verifierDidWork)) {
            // Flagged cards leave the candidate set, so this flags (and comments) once until a human moves the card.
            const flagged = await tx.kanbanCard.updateMany({
              where: { id: card.id, needsAttention: false },
              data: { needsAttention: true, attentionReason: 'verifier_is_worker', stateRevision: { increment: 1 } }
            })
            if (flagged.count === 1)
              flaggedSelfVerify.push({
                boardId: board.id,
                orgId: OrgId(board.orgId),
                repoId: board.repoId,
                repoFullName: board.repoFullName,
                cardId: card.id,
                issueNumber: card.issueNumber
              })
            continue
          }

          const [next] = await tx.$queryRaw<{ attempt: number }[]>(Prisma.sql`
          SELECT COALESCE(MAX("attempt"), 0)::int + 1 AS "attempt" FROM "kanban_run" WHERE "cardId" = ${card.id}::uuid
        `)
          const attempt = next?.attempt ?? 1
          // Every claim is a new dispatch generation, so any earlier holder's late write fails the fence.
          const updated = await tx.kanbanCard.update({
            where: { id: card.id },
            data: {
              // A verify run keeps the card in `review`; a work run moves it to `running` and starts a fresh review round.
              status: card.role === 'verify' ? 'review' : 'running',
              ...(card.role === 'work' ? { verifiedAt: null } : {}),
              dispatchRevision: { increment: 1 },
              stateRevision: { increment: 1 },
              ...RECOVERY_RESET
            },
            select: { dispatchRevision: true }
          })
          const run = await tx.kanbanRun.create({
            data: {
              mode: card.role === 'verify' ? 'read' : (card.mode ?? board.defaultMode),
              role: card.role,
              cardId: card.id,
              attempt,
              agentId: card.agentId,
              daemonId: card.daemonId,
              daemonEpoch: card.sessionEpoch,
              leaseId: randomUUID(),
              dispatchRevision: updated.dispatchRevision,
              dispatchedAt: opts.now
            },
            select: { id: true, leaseId: true }
          })
          const hook = await tx.hookDef.findFirst({
            where: { agentId: card.agentId, kind: 'github', repoId: board.repoId, githubSessionKey: { not: null } },
            orderBy: { createdAt: 'asc' },
            select: { githubSessionKey: true }
          })
          claimed.push({
            mode: card.role === 'verify' ? 'read' : (card.mode ?? board.defaultMode),
            role: card.role,
            runId: run.id,
            leaseId: run.leaseId,
            cardId: card.id,
            issueNumber: card.issueNumber,
            agentId: card.agentId,
            daemonId: card.daemonId,
            daemonEpoch: card.sessionEpoch,
            attempt,
            dispatchRevision: updated.dispatchRevision,
            boardId: board.id,
            orgId: OrgId(board.orgId),
            repoId: board.repoId,
            repoFullName: board.repoFullName,
            sessionKeyPrefix: hook?.githubSessionKey ?? `github:${board.repoId}`
          })
          perAgent.set(card.agentId, (perAgent.get(card.agentId) ?? 0) + 1)
          inProgress += 1
        }
      }
      return { leases: claimed, flaggedSelfVerify }
    })
  }

  async now(): Promise<Date> {
    const [row] = await this.db.$queryRaw<{ now: Date }[]>`SELECT now() AS now`
    return row!.now
  }

  async getBoardRef(boardId: string) {
    const board = await this.db.kanbanBoard.findFirst({
      where: { id: boardId, enabled: true },
      select: { id: true, orgId: true, repoId: true, repoFullName: true }
    })
    return board
      ? { boardId: board.id, orgId: OrgId(board.orgId), repoId: board.repoId, repoFullName: board.repoFullName }
      : null
  }

  async listRecoveryDue(boardId: string, now: Date, limit: number): Promise<KanbanRecoveryDue[]> {
    return this.db.$queryRaw<KanbanRecoveryDue[]>(Prisma.sql`
      SELECT c."id" AS "cardId", c."issueNumber",
        (c."promotionPending" AND c."status" IN ('todo', 'ready')) AS "promotion", ${PROMOTION_COLUMNS}
      FROM "kanban_card" c
      LEFT JOIN LATERAL (
        SELECT "reasonCode", "endedAt" FROM "kanban_run"
        WHERE "cardId" = c."id" ORDER BY "attempt" DESC LIMIT 1
      ) latest ON true
      WHERE c."boardId" = ${boardId}::uuid
        AND (c."recoveryCheckAt" IS NULL OR c."recoveryCheckAt" <= ${now})
        AND (
          (c."promotionPending" AND c."status" IN ('todo', 'ready'))
          OR (${PARKED} AND c."status" NOT IN ('ready', 'running', 'done', 'archived'))
        )
      ORDER BY c."recoveryCheckAt" ASC NULLS FIRST, c."issueNumber" ASC
      LIMIT ${limit}
    `)
  }

  async getParkedStatus(boardId: string, issueNumber: number): Promise<KanbanStatus | null> {
    const [card] = await this.db.$queryRaw<Array<{ status: KanbanStatus }>>(Prisma.sql`
      SELECT c."status" FROM "kanban_card" c
      LEFT JOIN LATERAL (
        SELECT "reasonCode", "endedAt" FROM "kanban_run"
        WHERE "cardId" = c."id" ORDER BY "attempt" DESC LIMIT 1
      ) latest ON true
      WHERE c."boardId" = ${boardId}::uuid AND c."issueNumber" = ${issueNumber} AND ${PARKED}
    `)
    return card?.status ?? null
  }

  async ingestStatus(
    boardId: string,
    issueNumber: number,
    from: KanbanStatus,
    to: KanbanStatus
  ): Promise<KanbanIngestResult> {
    return this.inTransaction(async (tx) => {
      const [card] = await tx.$queryRaw<
        Array<{ id: string; status: KanbanStatus; stateRevision: bigint; targetChannel: string | null }>
      >(Prisma.sql`
        SELECT c."id", c."status", c."stateRevision", b."targetChannel" FROM "kanban_card" c
        JOIN "kanban_board" b ON b."id" = c."boardId"
        LEFT JOIN LATERAL (
          SELECT "reasonCode", "endedAt" FROM "kanban_run"
          WHERE "cardId" = c."id" ORDER BY "attempt" DESC LIMIT 1
        ) latest ON true
        WHERE c."boardId" = ${boardId}::uuid AND c."issueNumber" = ${issueNumber} AND ${PARKED}
        FOR UPDATE OF c
      `)
      if (!card || card.status !== from) return { moved: false }
      await tx.kanbanCard.update({
        where: { id: card.id },
        data: {
          status: to,
          stateRevision: { increment: 1 },
          cooldownUntil: null,
          blockKind: null,
          // A human status move starts over, so an old approval never suppresses the next review.
          verifiedAt: null,
          ...RECOVERY_RESET
        }
      })
      // The notification commits or rolls back with the move, as a run end's does; (cardId, stateRevision) dedupes replays.
      const stateRevision = card.stateRevision + 1n
      const decision = planNotification(
        { cardId: card.id, boardId, issueNumber, from, to },
        { targetChannel: card.targetChannel }
      )
      if (decision.notify)
        await insertKanbanNotification(tx, {
          boardId,
          cardId: card.id,
          issueNumber,
          stateRevision,
          from,
          to,
          mention: decision.mention
        })
      return { moved: true, cardId: card.id, stateRevision }
    })
  }

  async deferRecovery(cardId: string, now: Date, observed?: string): Promise<void> {
    // A fingerprint that differs from the last read means GitHub changed, so the backoff starts over at one step.
    const seen = observed ?? null
    const changed = Prisma.sql`(${seen}::text IS NOT NULL AND ${seen}::text IS DISTINCT FROM "recoveryObserved")`
    await this.db.$executeRaw(Prisma.sql`
      UPDATE "kanban_card"
      SET "recoveryCheckAt" = ${now}::timestamptz + CASE WHEN ${changed}
            THEN make_interval(secs => ${RECOVERY_BASE_SEC})
            ELSE LEAST(
              make_interval(secs => ${RECOVERY_BASE_SEC} * power(2, LEAST("recoveryChecks", 20))),
              make_interval(secs => ${RECOVERY_MAX_SEC}))
          END,
          "recoveryChecks" = CASE WHEN ${changed} THEN 1 ELSE "recoveryChecks" + 1 END,
          "recoveryObserved" = COALESCE(${seen}::text, "recoveryObserved"),
          "promotionChecks" = "promotionChecks" + CASE WHEN "promotionPending" THEN 1 ELSE 0 END
      WHERE "id" = ${cardId}::uuid
    `)
  }

  async resetRecovery(boardId: string, issueNumber: number): Promise<void> {
    await this.db.kanbanCard.updateMany({
      where: { boardId, issueNumber },
      data: { recoveryCheckAt: null, recoveryChecks: 0, recoveryObserved: null }
    })
  }

  async getPendingPromotion(boardId: string, issueNumber: number): Promise<KanbanRecoveryDue | null> {
    const [card] = await this.db.$queryRaw<KanbanRecoveryDue[]>(Prisma.sql`
      SELECT c."id" AS "cardId", c."issueNumber", true AS "promotion", ${PROMOTION_COLUMNS}
      FROM "kanban_card" c
      WHERE c."boardId" = ${boardId}::uuid AND c."issueNumber" = ${issueNumber}
        AND c."promotionPending" AND c."status" IN ('todo', 'ready')
    `)
    return card ?? null
  }

  async settlePromotion(cardId: string, repaired: boolean): Promise<boolean> {
    // Repair adopts the promotion that already landed; a refusal clears the intent and returns a ready card to todo.
    const { count } = await this.db.kanbanCard.updateMany({
      where: PENDING_UNLEASED(cardId),
      data: repaired
        ? { status: 'ready', stateRevision: { increment: 1 }, githubSyncedAt: new Date(), ...RECOVERY_RESET }
        : { status: 'todo', ...PROMOTION_CLEARED }
    })
    return count === 1
  }

  async escalatePromotion(cardId: string, reason: string): Promise<boolean> {
    // The revision bump fences any in-flight graph CAS; only a human status edit un-parks the flagged card.
    const { count } = await this.db.kanbanCard.updateMany({
      where: PENDING_UNLEASED(cardId),
      data: {
        status: 'todo',
        stateRevision: { increment: 1 },
        ...RECOVERY_RESET,
        needsAttention: true,
        attentionReason: reason
      }
    })
    return count === 1
  }

  async listContractCards(
    boardId: string,
    opts: { prNumbers?: readonly number[]; afterIssueNumber?: number; limit?: number }
  ): Promise<KanbanContractCard[]> {
    const prs = opts.prNumbers ? Prisma.sql`AND c."linkedPrNumber" = ANY(${[...opts.prNumbers]}::int[])` : Prisma.empty
    return this.db.$queryRaw<KanbanContractCard[]>(Prisma.sql`
      SELECT ${CONTRACT_COLUMNS}
      FROM "kanban_card" c JOIN "kanban_board" b ON b."id" = c."boardId"
      WHERE c."boardId" = ${boardId}::uuid AND ${CONTRACT_DUE} ${prs}
        AND c."issueNumber" > ${opts.afterIssueNumber ?? 0}
      ORDER BY c."issueNumber" ASC
      LIMIT ${opts.limit ?? 100}
    `)
  }

  async getContractCard(cardId: string): Promise<KanbanContractCard | null> {
    const [card] = await this.db.$queryRaw<KanbanContractCard[]>(Prisma.sql`
      SELECT ${CONTRACT_COLUMNS}
      FROM "kanban_card" c JOIN "kanban_board" b ON b."id" = c."boardId"
      WHERE c."id" = ${cardId}::uuid AND ${CONTRACT_DUE}
    `)
    return card ?? null
  }

  settleContract(input: KanbanContractSettleInput): Promise<boolean> {
    return this.inTransaction(async (tx) => {
      // Only an unleased review card at the judged revision moves; a verify run still open re-judges on its own end.
      const { count } = await tx.kanbanCard.updateMany({
        where: {
          id: input.cardId,
          stateRevision: input.expectedStateRevision,
          status: 'review',
          runs: { none: { endedAt: null } }
        },
        data: {
          status: input.to,
          stateRevision: { increment: 1 },
          cooldownUntil: null,
          blockKind: null,
          ...RECOVERY_RESET,
          ...(input.to === 'triage'
            ? { needsAttention: true, attentionReason: input.reason }
            : { reviewRounds: 0, verifiedAt: null })
        }
      })
      if (count !== 1) return false
      const card = await tx.kanbanCard.findUniqueOrThrow({
        where: { id: input.cardId },
        select: { boardId: true, issueNumber: true, board: { select: { orgId: true } } }
      })
      await tx.auditEvent.create({
        data: {
          kind: 'kanban_card_change',
          orgId: card.board.orgId,
          message: `kanban card ${input.cardId} status changed by PR contract`,
          details: {
            boardId: card.boardId,
            cardId: input.cardId,
            issueNumber: card.issueNumber,
            change: 'status',
            from: 'review',
            to: input.to,
            reason: input.reason,
            prNumber: input.prNumber,
            source: 'pr_contract'
          }
        }
      })
      return true
    })
  }

  async isCurrentLease(leaseId: string, mode: 'read' | 'write', epoch: bigint): Promise<boolean> {
    const rows = await this.db.$queryRaw<Array<{ leaseId: string }>>(Prisma.sql`
      SELECT r."leaseId" FROM "kanban_run" r
      JOIN "kanban_card" c ON c."id" = r."cardId"
      JOIN "kanban_board" b ON b."id" = c."boardId"
      JOIN "daemon" d ON d."id" = r."daemonId"
      JOIN "agent" a ON a."id" = r."agentId" AND a."daemonId" = r."daemonId"
      WHERE r."leaseId" = ${leaseId}::uuid AND r."endedAt" IS NULL AND r."mode" = ${mode}::"KanbanRunMode"
        AND c."dispatchRevision" = r."dispatchRevision"
        AND r."agentId" = CASE WHEN r."role" = 'verify' THEN b."verifierAgentId" ELSE c."assigneeAgentId" END
        AND d."sessionEpoch" = ${epoch} AND r."daemonEpoch" = ${epoch}
    `)
    return rows.length === 1
  }

  async markAcked(leaseId: string, mode: 'read' | 'write', now: Date, epoch: bigint): Promise<boolean> {
    const rows = await this.db.$queryRaw<{ leaseId: string }[]>(Prisma.sql`
      UPDATE "kanban_run" r
      SET "ackedAt" = COALESCE(r."ackedAt", ${now}), "heartbeatAt" = COALESCE(r."heartbeatAt", ${now})
      FROM "kanban_card" c, "kanban_board" b, "daemon" d
      WHERE r."leaseId" = ${leaseId}::uuid AND r."endedAt" IS NULL AND r."mode" = ${mode}::"KanbanRunMode"
        AND c."id" = r."cardId" AND b."id" = c."boardId" AND c."dispatchRevision" = r."dispatchRevision"
        AND r."agentId" = CASE WHEN r."role" = 'verify' THEN b."verifierAgentId" ELSE c."assigneeAgentId" END
        AND d."id" = r."daemonId" AND d."sessionEpoch" = ${epoch} AND r."daemonEpoch" = ${epoch}
        AND EXISTS (SELECT 1 FROM "agent" a WHERE a."id" = r."agentId" AND a."daemonId" = r."daemonId")
      RETURNING r."leaseId"
    `)
    return rows.length === 1
  }

  endRun(input: KanbanRunEndInput): Promise<KanbanRunEndResult> {
    return this.inTransaction(async (tx) => {
      const [row] = await tx.$queryRaw<RunEndRow[]>(Prisma.sql`
        SELECT r."id" AS "runId", r."cardId", r."attempt", r."agentId", r."daemonId", r."role",
               r."dispatchRevision" AS "runRevision", r."endedAt",
               c."status", c."dispatchRevision" AS "cardRevision", c."stateRevision", c."consecutiveFailures", c."protocolViolations",
               c."blockRecurrence", c."reviewRounds", c."verifiedAt", c."cooldownUntil", c."blockKind", c."boardId",
               c."issueNumber", c."assigneeAgentId",
               r."dispatchedAt", r."ackedAt", r."heartbeatAt", r."daemonEpoch",
               d."sessionEpoch" AS "currentDaemonEpoch", a."id" AS "agentRowId", a."daemonId" AS "agentDaemonId", b."staleLeaseSec",
               b."orgId", b."repoId", b."repoFullName", b."targetChannel", b."failureLimit", b."protocolRetryLimit",
               b."blockRecurrenceLimit", b."completionContract", b."verifierAgentId"
        FROM "kanban_run" r
        JOIN "kanban_card" c ON c."id" = r."cardId"
        JOIN "kanban_board" b ON b."id" = c."boardId"
        LEFT JOIN "daemon" d ON d."id" = r."daemonId"
        LEFT JOIN "agent" a ON a."id" = r."agentId"
        WHERE r."leaseId" = ${input.leaseId}::uuid
        FOR UPDATE OF r, c
      `)
      if (!row) return { accepted: false }
      if (
        input.reclaimIf &&
        !input.reclaimIf({ ...row, agentDaemonId: row.agentRowId === null ? undefined : row.agentDaemonId })
      ) {
        return { accepted: false }
      }
      const lease =
        row.endedAt === null
          ? {
              leaseId: input.leaseId,
              agentId: row.agentId,
              daemonId: row.daemonId,
              dispatchRevision: row.runRevision
            }
          : null
      const fence = input.fence
      // The run's holder is the assignee for work, the verifier for verify; the agent must still be placed on the run's daemon.
      const holderAgentId = row.role === 'verify' ? row.verifierAgentId : row.assigneeAgentId
      const fenced =
        leaseAcceptsWrite(
          { dispatchRevision: row.cardRevision, lease },
          { leaseId: input.leaseId, dispatchRevision: fence?.dispatchRevision ?? row.runRevision }
        ) &&
        (!fence ||
          (fence.daemonId === row.daemonId &&
            fence.daemonEpoch === row.currentDaemonEpoch &&
            fence.cardId === row.cardId &&
            fence.attempt === row.attempt &&
            (fence.boardId === undefined || fence.boardId === row.boardId) &&
            (fence.agentId === undefined || fence.agentId === row.agentId) &&
            holderAgentId === row.agentId &&
            row.agentDaemonId === row.daemonId))
      if (!fenced) return { accepted: false }

      // Backoff is derived from the ended runs themselves, so it needs no card column.
      const trailingProviderTransients =
        input.outcome === 'transient' ? await this.trailingProviderTransients(tx, row.cardId) : 0
      const plan = input.plan(
        {
          status: row.status,
          consecutiveFailures: row.consecutiveFailures,
          protocolViolations: row.protocolViolations,
          blockRecurrence: row.blockRecurrence,
          reviewRounds: row.reviewRounds,
          verifiedAt: row.verifiedAt,
          cooldownUntil: row.cooldownUntil,
          blockKind: row.blockKind
        },
        {
          failureLimit: row.failureLimit,
          protocolRetryLimit: row.protocolRetryLimit,
          blockRecurrenceLimit: row.blockRecurrenceLimit,
          completionContract: row.completionContract,
          verifierAgentId: row.verifierAgentId
        },
        { trailingProviderTransients, role: row.role }
      )
      await tx.kanbanRun.update({
        where: { id: row.runId },
        data: {
          endedAt: input.now,
          outcome: input.outcome,
          reasonCode: input.reasonCode,
          blockKind: input.reportedBlockKind ?? null,
          ...(input.sessionId ? { sessionId: input.sessionId } : {})
        }
      })
      // Ending a lease always advances the generation, so the ended holder can never write again.
      await tx.kanbanCard.update({
        where: { id: row.cardId },
        data: {
          status: plan.status,
          ...(input.prNumber !== undefined ? { linkedPrNumber: input.prNumber } : {}),
          consecutiveFailures: plan.consecutiveFailures,
          protocolViolations: plan.protocolViolations,
          blockRecurrence: plan.blockRecurrence,
          reviewRounds: plan.reviewRounds,
          verifiedAt: plan.verifiedAt,
          cooldownUntil: plan.cooldownUntil,
          blockKind: plan.blockKind,
          ...PROMOTION_CLEARED,
          dispatchRevision: { increment: 1 },
          stateRevision: { increment: 1 }
        }
      })
      // A transition notification rides the same write; the (cardId, stateRevision) key makes a replay a no-op.
      const decision = planNotification(
        {
          cardId: row.cardId,
          boardId: row.boardId,
          issueNumber: row.issueNumber,
          from: row.status,
          to: plan.status,
          blockKind: plan.blockKind ?? undefined,
          reasonCode: input.reasonCode ?? undefined,
          tripped: plan.tripped,
          role: row.role
        },
        { targetChannel: row.targetChannel }
      )
      if (decision.notify)
        await insertKanbanNotification(tx, {
          boardId: row.boardId,
          cardId: row.cardId,
          issueNumber: row.issueNumber,
          stateRevision: row.stateRevision + 1n,
          from: row.status,
          to: plan.status,
          blockKind: plan.blockKind,
          reasonCode: input.reasonCode,
          tripped: plan.tripped,
          mention: decision.mention
        })
      return {
        accepted: true,
        plan,
        card: {
          boardId: row.boardId,
          orgId: OrgId(row.orgId),
          repoId: row.repoId,
          repoFullName: row.repoFullName,
          cardId: row.cardId,
          issueNumber: row.issueNumber,
          from: row.status,
          to: plan.status
        }
      }
    })
  }

  // Admission deferrals carry no provider evidence; exclude them before limiting the outage history.
  private async trailingProviderTransients(tx: PrismaLike, cardId: string): Promise<number> {
    const ended = await tx.kanbanRun.findMany({
      where: {
        cardId,
        endedAt: { not: null },
        OR: [
          { outcome: null },
          { outcome: { not: 'transient' } },
          { reasonCode: null },
          {
            AND: [
              { reasonCode: { not: 'nudge_deferred' } },
              // Prisma uses LIKE here, so the underscore must match literally.
              { NOT: { reasonCode: { startsWith: 'dispatch\\_refused:' } } }
            ]
          }
        ]
      },
      orderBy: { attempt: 'desc' },
      take: PROVIDER_TRANSIENT_LIMIT,
      select: { outcome: true, reasonCode: true }
    })
    let n = 0
    for (const run of ended) {
      if (run.outcome !== 'transient' || !run.reasonCode?.startsWith('provider_')) break
      n += 1
    }
    return n
  }

  heartbeat(daemonId: string, epoch: bigint, beats: KanbanLeaseBeatInput[], now: Date): Promise<string[]> {
    if (beats.length === 0) return Promise.resolve([])
    return this.inTransaction(async (tx) => {
      const superseded: string[] = []
      for (const beat of beats) {
        // Re-stamping daemonEpoch is how a reconnected daemon keeps a lease whose turn survived the reconnect.
        const rows = await tx.$queryRaw<{ leaseId: string }[]>(Prisma.sql`
          UPDATE "kanban_run" r
          SET "heartbeatAt" = ${now}, "ackedAt" = COALESCE(r."ackedAt", ${now}), "daemonEpoch" = ${epoch},
              "sessionId" = COALESCE(${beat.sessionId ?? null}, r."sessionId")
          FROM "kanban_card" c, "kanban_board" b
          WHERE r."leaseId" = ${beat.leaseId}::uuid
            AND r."cardId" = ${beat.cardId}::uuid
            AND c."id" = r."cardId"
            AND b."id" = c."boardId"
            AND r."endedAt" IS NULL
            AND r."daemonId" = ${daemonId}::uuid
            AND EXISTS (SELECT 1 FROM "daemon" d WHERE d."id" = r."daemonId" AND d."sessionEpoch" = ${epoch})
            AND EXISTS (SELECT 1 FROM "agent" a WHERE a."id" = r."agentId" AND a."daemonId" = r."daemonId"
              AND a."id" = CASE WHEN r."role" = 'verify' THEN b."verifierAgentId" ELSE c."assigneeAgentId" END)
            AND r."dispatchRevision" = ${beat.dispatchRevision}
            AND c."dispatchRevision" = ${beat.dispatchRevision}
          RETURNING r."leaseId"
        `)
        if (rows.length === 0) superseded.push(beat.leaseId)
      }
      return superseded
    })
  }

  async listOpenLeases(limit: number, afterLeaseId?: string): Promise<KanbanOpenLease[]> {
    const rows = await this.db.$queryRaw<
      Array<{
        leaseId: string
        dispatchedAt: Date
        ackedAt: Date | null
        heartbeatAt: Date | null
        daemonId: string
        daemonEpoch: bigint
        currentDaemonEpoch: bigint | null
        agentRowId: string | null
        agentDaemonId: string | null
        staleLeaseSec: number
      }>
    >(Prisma.sql`
      SELECT r."leaseId", r."dispatchedAt", r."ackedAt", r."heartbeatAt", r."daemonId", r."daemonEpoch",
             d."sessionEpoch" AS "currentDaemonEpoch", a."id" AS "agentRowId", a."daemonId" AS "agentDaemonId",
             b."staleLeaseSec"
      FROM "kanban_run" r
      JOIN "kanban_card" c ON c."id" = r."cardId"
      JOIN "kanban_board" b ON b."id" = c."boardId"
      LEFT JOIN "daemon" d ON d."id" = r."daemonId"
      LEFT JOIN "agent" a ON a."id" = r."agentId"
      WHERE r."endedAt" IS NULL
      ${afterLeaseId ? Prisma.sql`AND r."leaseId" > ${afterLeaseId}::uuid` : Prisma.empty}
      ORDER BY r."leaseId" ASC
      LIMIT ${limit}
    `)
    return rows.map(({ agentRowId, agentDaemonId, ...r }) => ({
      ...r,
      agentDaemonId: agentRowId === null ? undefined : agentDaemonId
    }))
  }

  async openGrantScopes(agentId: string, daemonId: string): Promise<KanbanGrantScope[]> {
    return this.db.$queryRaw<KanbanGrantScope[]>(Prisma.sql`
      SELECT b."repoId", b."repoFullName", r."mode"
      FROM "kanban_run" r
      JOIN "kanban_card" c ON c."id" = r."cardId"
      JOIN "kanban_board" b ON b."id" = c."boardId"
      WHERE r."endedAt" IS NULL
        AND r."agentId" = ${agentId}::uuid
        AND r."daemonId" = ${daemonId}::uuid
    `)
  }

  async isIdempotentReport(daemonId: string, report: KanbanReport): Promise<boolean> {
    // Same fence, outcome, reason, and the kind this run reported. A later card kind change is still this report.
    const rows = await this.db.$queryRaw<Array<{ leaseId: string }>>(Prisma.sql`
      SELECT r."leaseId" FROM "kanban_run" r
      WHERE r."leaseId" = ${report.leaseId}::uuid
        AND r."daemonId" = ${daemonId}::uuid
        AND r."agentId" = ${report.agentId}::uuid
        AND r."cardId" = ${report.cardId}::uuid
        AND r."attempt" = ${report.attempt}
        AND r."dispatchRevision" = ${BigInt(report.dispatchRevision)}
        AND r."outcome" = ${report.outcome}::"KanbanRunOutcome"
        AND r."endedAt" IS NOT NULL
        AND r."reasonCode" IS NOT DISTINCT FROM ${report.reasonCode ?? null}
        AND r."blockKind" IS NOT DISTINCT FROM ${report.blockKind ?? null}::"KanbanBlockKind"
    `)
    return rows.length === 1
  }

  /** The open run behind `leaseId`, only when the full lease fence holds: revision, holder daemon and agent, live epoch, card and board. */
  private async fencedOpenLease(
    daemonId: string,
    epoch: bigint,
    req: { leaseId: string; agentId?: string; cardId?: string; boardId?: string; dispatchRevision?: bigint }
  ) {
    const [row] = await this.db.$queryRaw<
      Array<{
        cardId: string
        boardId: string
        agentId: string
        daemonId: string
        attempt: number
        mode: 'read' | 'write'
        role: 'work' | 'verify'
        runRevision: bigint
        cardRevision: bigint
        assigneeAgentId: string | null
        verifierAgentId: string | null
        currentDaemonEpoch: bigint | null
        repoId: bigint
        repoFullName: string
        status: string
        priority: number
        blockKind: KanbanBlockKind | null
        consecutiveFailures: number
        protocolViolations: number
        blockRecurrence: number
        linkedPrNumber: number | null
      }>
    >(Prisma.sql`
      SELECT r."cardId", c."boardId", r."agentId", r."daemonId", r."attempt", r."mode", r."role",
             r."dispatchRevision" AS "runRevision", c."dispatchRevision" AS "cardRevision", c."assigneeAgentId",
             b."verifierAgentId",
             d."sessionEpoch" AS "currentDaemonEpoch", b."repoId", b."repoFullName", c."status"::text AS "status",
             c."priority", c."blockKind", c."consecutiveFailures", c."protocolViolations", c."blockRecurrence",
             c."linkedPrNumber"
      FROM "kanban_run" r
      JOIN "kanban_card" c ON c."id" = r."cardId"
      JOIN "kanban_board" b ON b."id" = c."boardId"
      JOIN "agent" a ON a."id" = r."agentId" AND a."daemonId" = r."daemonId"
      LEFT JOIN "daemon" d ON d."id" = r."daemonId"
      WHERE r."leaseId" = ${req.leaseId}::uuid AND r."endedAt" IS NULL
    `)
    if (!row) return null
    const holderAgentId = row.role === 'verify' ? row.verifierAgentId : row.assigneeAgentId
    const fenced =
      leaseAcceptsWrite(
        {
          dispatchRevision: row.cardRevision,
          lease: {
            leaseId: req.leaseId,
            agentId: row.agentId,
            daemonId: row.daemonId,
            dispatchRevision: row.runRevision
          }
        },
        { leaseId: req.leaseId, dispatchRevision: req.dispatchRevision ?? row.runRevision }
      ) &&
      row.daemonId === daemonId &&
      row.currentDaemonEpoch === epoch &&
      holderAgentId === row.agentId &&
      (req.agentId === undefined || req.agentId === row.agentId) &&
      (req.cardId === undefined || req.cardId === row.cardId) &&
      (req.boardId === undefined || req.boardId === row.boardId)
    return fenced ? row : null
  }

  async kanbanLiveCommentGrant(
    daemonId: string,
    epoch: bigint,
    agentId: string,
    leaseId: string,
    repoFullName: string
  ): Promise<{ repoId: bigint } | null> {
    const row = await this.fencedOpenLease(daemonId, epoch, { leaseId, agentId })
    return row && row.repoFullName === repoFullName ? { repoId: row.repoId } : null
  }

  async kanbanCardView(daemonId: string, epoch: bigint, req: KanbanCardViewReq): Promise<KanbanCardView | null> {
    const row = await this.fencedOpenLease(daemonId, epoch, req)
    if (!row) return null
    // Prior runs only: the open one is this run, whose outcome the agent is about to write.
    const prior = await this.db.kanbanRun.findMany({
      where: { cardId: row.cardId, endedAt: { not: null } },
      orderBy: { attempt: 'desc' },
      take: KANBAN_CARD_SHOW_MAX_RUNS,
      select: { attempt: true, outcome: true, reasonCode: true, dispatchedAt: true, endedAt: true }
    })
    return {
      status: row.status,
      priority: row.priority,
      attempt: row.attempt,
      mode: row.mode,
      blockKind: row.blockKind,
      consecutiveFailures: row.consecutiveFailures,
      protocolViolations: row.protocolViolations,
      blockRecurrence: row.blockRecurrence,
      linkedPrNumber: row.linkedPrNumber,
      runs: prior.map((r) => ({
        attempt: r.attempt,
        outcome: r.outcome,
        reasonCode: r.reasonCode,
        dispatchedAt: r.dispatchedAt.toISOString(),
        endedAt: r.endedAt?.toISOString() ?? null
      }))
    }
  }

  async kanbanCommentGrant(
    daemonId: string,
    agentId: string,
    leaseId: string,
    repoFullName: string
  ): Promise<{ repoId: bigint } | null> {
    // The accepting write already fenced the epoch. A restarted daemon keeps the same id and a new epoch, and still owes the comment.
    const rows = await this.db.$queryRaw<Array<{ repoId: bigint }>>(Prisma.sql`
      SELECT b."repoId" FROM "kanban_run" r
      JOIN "kanban_card" c ON c."id" = r."cardId"
      JOIN "kanban_board" b ON b."id" = c."boardId"
      WHERE r."leaseId" = ${leaseId}::uuid
        AND r."daemonId" = ${daemonId}::uuid
        AND r."agentId" = ${agentId}::uuid
        AND r."endedAt" IS NOT NULL
        AND r."outcome" IN (
          'completed'::"KanbanRunOutcome",
          'review_requested'::"KanbanRunOutcome",
          'changes_requested'::"KanbanRunOutcome",
          'blocked'::"KanbanRunOutcome",
          'failed'::"KanbanRunOutcome"
        )
        AND b."repoFullName" = ${repoFullName}
    `)
    const row = rows[0]
    return row ? { repoId: row.repoId } : null
  }
}

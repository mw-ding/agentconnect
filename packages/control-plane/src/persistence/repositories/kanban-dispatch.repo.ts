// PgKanbanDispatchRepo (issue #2 D2): the board row is the claim mutex (SKIP LOCKED), card rows are skipped while another writer holds them.
import { randomUUID } from 'node:crypto'
import { Prisma } from '../../generated/prisma/client.js'
import { OrgId } from '../../domain/ids.js'
import type { KanbanStatus } from '../../kanban/card-state.js'
import { leaseAcceptsWrite } from '../../kanban/reassign.js'
import type { KanbanBlockKind } from '../../kanban/run-accounting.js'
import type { PrismaLike } from '../prisma.js'
import type {
  KanbanClaimOpts,
  KanbanClaimedLease,
  KanbanDispatchRepo,
  KanbanLeaseBeatInput,
  KanbanOpenLease,
  KanbanRunEndInput,
  KanbanRunEndResult
} from '../ports.js'

/** Ready cards examined per claim; caps or offline daemons can skip some, so scan past the free room. */
const CLAIM_SCAN = 50

interface BoardRow {
  id: string
  orgId: string
  repoId: bigint
  repoFullName: string
  maxInProgress: number
  maxInProgressPerAgent: number
}

interface CandidateRow {
  id: string
  issueNumber: number
  agentId: string
  daemonId: string
  sessionEpoch: bigint
}

interface RunEndRow {
  runId: string
  cardId: string
  attempt: number
  agentId: string
  daemonId: string
  runRevision: bigint
  endedAt: Date | null
  status: KanbanStatus
  cardRevision: bigint
  consecutiveFailures: number
  protocolViolations: number
  blockRecurrence: number
  cooldownUntil: Date | null
  blockKind: KanbanBlockKind | null
  boardId: string
  issueNumber: number
  orgId: string
  repoId: bigint
  repoFullName: string
  failureLimit: number
  protocolRetryLimit: number
  blockRecurrenceLimit: number
  completionContract: 'close' | 'pr_merged' | 'pr_checks_green'
  verifierAgentId: string | null
}

export class PgKanbanDispatchRepo implements KanbanDispatchRepo {
  constructor(private readonly db: PrismaLike) {}

  private inTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    if ('$transaction' in this.db) return this.db.$transaction(fn)
    return fn(this.db as Prisma.TransactionClient)
  }

  async listEnabledBoardIds(): Promise<string[]> {
    const rows = await this.db.kanbanBoard.findMany({ where: { enabled: true }, select: { id: true } })
    return rows.map((r) => r.id)
  }

  claim(boardId: string, opts: KanbanClaimOpts): Promise<KanbanClaimedLease[]> {
    return this.inTransaction(async (tx) => {
      // A concurrent claimer already holds this board: skip it rather than queue behind it.
      const [board] = await tx.$queryRaw<BoardRow[]>(Prisma.sql`
        SELECT "id", "orgId", "repoId", "repoFullName", "maxInProgress", "maxInProgressPerAgent"
        FROM "kanban_board"
        WHERE "id" = ${boardId}::uuid AND "enabled"
        FOR UPDATE SKIP LOCKED
      `)
      if (!board) return []

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
      if (room <= 0) return []

      const candidates = await tx.$queryRaw<CandidateRow[]>(Prisma.sql`
        SELECT c."id", c."issueNumber", c."assigneeAgentId" AS "agentId", a."daemonId", d."sessionEpoch"
        FROM "kanban_card" c
        JOIN "agent" a ON a."id" = c."assigneeAgentId" AND a."orgId" = ${board.orgId} AND a."status" <> 'paused'
        JOIN "daemon" d ON d."id" = a."daemonId"
        WHERE c."boardId" = ${boardId}::uuid
          AND c."status" = 'ready'
          AND (c."cooldownUntil" IS NULL OR c."cooldownUntil" <= ${opts.now})
          AND (c."notBefore" IS NULL OR c."notBefore" <= ${opts.now})
        ORDER BY c."priority" DESC, c."createdAt" ASC, c."id" ASC
        LIMIT ${CLAIM_SCAN}
        FOR UPDATE OF c SKIP LOCKED
      `)

      const claimed: KanbanClaimedLease[] = []
      for (const card of candidates) {
        if (claimed.length >= room || inProgress >= board.maxInProgress) break
        if ((perAgent.get(card.agentId) ?? 0) >= board.maxInProgressPerAgent) continue
        if (!opts.isDaemonLive(card.daemonId)) continue

        const [next] = await tx.$queryRaw<{ attempt: number }[]>(Prisma.sql`
          SELECT COALESCE(MAX("attempt"), 0)::int + 1 AS "attempt" FROM "kanban_run" WHERE "cardId" = ${card.id}::uuid
        `)
        const attempt = next?.attempt ?? 1
        // Every claim is a new dispatch generation, so any earlier holder's late write fails the fence.
        const updated = await tx.kanbanCard.update({
          where: { id: card.id },
          data: { status: 'running', dispatchRevision: { increment: 1 }, stateRevision: { increment: 1 } },
          select: { dispatchRevision: true }
        })
        const run = await tx.kanbanRun.create({
          data: {
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
      return claimed
    })
  }

  async markAcked(leaseId: string, mode: 'read' | 'write', now: Date): Promise<boolean> {
    const { count } = await this.db.kanbanRun.updateMany({
      where: { leaseId, endedAt: null, ackedAt: null },
      data: { ackedAt: now, heartbeatAt: now, mode }
    })
    return count === 1
  }

  endRun(input: KanbanRunEndInput): Promise<KanbanRunEndResult> {
    return this.inTransaction(async (tx) => {
      const [row] = await tx.$queryRaw<RunEndRow[]>(Prisma.sql`
        SELECT r."id" AS "runId", r."cardId", r."attempt", r."agentId", r."daemonId",
               r."dispatchRevision" AS "runRevision", r."endedAt",
               c."status", c."dispatchRevision" AS "cardRevision", c."consecutiveFailures", c."protocolViolations",
               c."blockRecurrence", c."cooldownUntil", c."blockKind", c."boardId", c."issueNumber",
               b."orgId", b."repoId", b."repoFullName", b."failureLimit", b."protocolRetryLimit",
               b."blockRecurrenceLimit", b."completionContract", b."verifierAgentId"
        FROM "kanban_run" r
        JOIN "kanban_card" c ON c."id" = r."cardId"
        JOIN "kanban_board" b ON b."id" = c."boardId"
        WHERE r."leaseId" = ${input.leaseId}::uuid
        FOR UPDATE OF r, c
      `)
      if (!row) return { accepted: false }
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
      const fenced =
        leaseAcceptsWrite(
          { dispatchRevision: row.cardRevision, lease },
          { leaseId: input.leaseId, dispatchRevision: fence?.dispatchRevision ?? row.runRevision }
        ) &&
        (!fence || (fence.daemonId === row.daemonId && fence.cardId === row.cardId && fence.attempt === row.attempt))
      if (!fenced) return { accepted: false }

      const plan = input.plan(
        {
          status: row.status,
          consecutiveFailures: row.consecutiveFailures,
          protocolViolations: row.protocolViolations,
          blockRecurrence: row.blockRecurrence,
          cooldownUntil: row.cooldownUntil,
          blockKind: row.blockKind
        },
        {
          failureLimit: row.failureLimit,
          protocolRetryLimit: row.protocolRetryLimit,
          blockRecurrenceLimit: row.blockRecurrenceLimit,
          completionContract: row.completionContract,
          verifierAgentId: row.verifierAgentId
        }
      )
      await tx.kanbanRun.update({
        where: { id: row.runId },
        data: {
          endedAt: input.now,
          outcome: input.outcome,
          reasonCode: input.reasonCode,
          ...(input.sessionId ? { sessionId: input.sessionId } : {})
        }
      })
      // Ending a lease always advances the generation, so the ended holder can never write again.
      await tx.kanbanCard.update({
        where: { id: row.cardId },
        data: {
          status: plan.status,
          consecutiveFailures: plan.consecutiveFailures,
          protocolViolations: plan.protocolViolations,
          blockRecurrence: plan.blockRecurrence,
          cooldownUntil: plan.cooldownUntil,
          blockKind: plan.blockKind,
          dispatchRevision: { increment: 1 },
          stateRevision: { increment: 1 }
        }
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

  heartbeat(daemonId: string, epoch: bigint, beats: KanbanLeaseBeatInput[], now: Date): Promise<string[]> {
    if (beats.length === 0) return Promise.resolve([])
    return this.inTransaction(async (tx) => {
      const superseded: string[] = []
      for (const beat of beats) {
        // Re-stamping daemonEpoch is how a reconnected daemon keeps a lease whose turn survived the reconnect.
        const rows = await tx.$queryRaw<{ leaseId: string }[]>(Prisma.sql`
          UPDATE "kanban_run" r
          SET "heartbeatAt" = ${now}, "daemonEpoch" = ${epoch},
              "sessionId" = COALESCE(${beat.sessionId ?? null}, r."sessionId")
          FROM "kanban_card" c
          WHERE r."leaseId" = ${beat.leaseId}::uuid
            AND r."cardId" = ${beat.cardId}::uuid
            AND c."id" = r."cardId"
            AND r."endedAt" IS NULL
            AND r."daemonId" = ${daemonId}::uuid
            AND r."dispatchRevision" = ${beat.dispatchRevision}
            AND c."dispatchRevision" = ${beat.dispatchRevision}
          RETURNING r."leaseId"
        `)
        if (rows.length === 0) superseded.push(beat.leaseId)
      }
      return superseded
    })
  }

  async listOpenLeases(limit: number): Promise<KanbanOpenLease[]> {
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
      ORDER BY COALESCE(r."heartbeatAt", r."ackedAt", r."dispatchedAt") ASC
      LIMIT ${limit}
    `)
    return rows.map(({ agentRowId, agentDaemonId, ...r }) => ({
      ...r,
      agentDaemonId: agentRowId === null ? undefined : agentDaemonId
    }))
  }
}

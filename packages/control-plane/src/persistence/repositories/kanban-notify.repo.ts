// Kanban notification outbox (issue #2 M4): insert replay-safe rows, claim due ones under a lease, and settle them under that claim.
import { Prisma } from '../../generated/prisma/client.js'
import { OrgId } from '../../domain/ids.js'
import type { PrismaLike } from '../prisma.js'
import type {
  KanbanNotificationClaim,
  KanbanNotificationInsert,
  KanbanNotificationRow,
  KanbanNotifyRepo,
  KanbanNotifyTarget
} from '../ports.js'

/** Shared raw insert: the (cardId, stateRevision) unique key makes a replay a no-op, never a duplicate. */
export async function insertKanbanNotification(db: PrismaLike, row: KanbanNotificationInsert): Promise<void> {
  await db.$executeRaw(Prisma.sql`
    INSERT INTO "kanban_notification"
      ("boardId", "cardId", "issueNumber", "stateRevision", "fromStatus", "toStatus",
       "blockKind", "reasonCode", "tripped", "mention")
    VALUES (${row.boardId}::uuid, ${row.cardId}::uuid, ${row.issueNumber}, ${row.stateRevision},
            ${row.from}::"KanbanCardStatus", ${row.to}::"KanbanCardStatus",
            ${row.blockKind ?? null}::"KanbanBlockKind", ${row.reasonCode ?? null}, ${row.tripped ?? null}, ${row.mention})
    ON CONFLICT ("cardId", "stateRevision") DO NOTHING
  `)
}

export class PgKanbanNotifyRepo implements KanbanNotifyRepo {
  constructor(private readonly db: PrismaLike) {}

  enqueue(row: KanbanNotificationInsert): Promise<void> {
    return insertKanbanNotification(this.db, row)
  }

  async claim(
    limit: number,
    now: Date,
    leaseUntil: Date,
    exclude: readonly string[] = [],
    liveDaemonIds?: readonly string[]
  ): Promise<KanbanNotificationRow[]> {
    // A row for a placed daemon not live here waits for its holder; one resolving to no daemon stays claimable to settle.
    const elsewhere = liveDaemonIds
      ? Prisma.sql`AND NOT EXISTS (
          SELECT 1 FROM "kanban_board" b
          JOIN "integration" i ON i."id" = b."targetIntegrationId" AND i."status" = 'active'
          JOIN "agent" a ON a."id" = i."agentId" AND a."orgId" = b."orgId"
          WHERE b."id" = q."boardId" AND b."targetChannel" IS NOT NULL AND a."daemonId" IS NOT NULL
            AND NOT (a."daemonId" = ANY(${[...liveDaemonIds]}::uuid[])))`
      : Prisma.empty
    // One statement: SKIP LOCKED keeps a concurrent drain off rows being claimed, and the lease keeps it off them after.
    return this.db.$queryRaw<KanbanNotificationRow[]>(Prisma.sql`
      UPDATE "kanban_notification" n
      SET "claimedUntil" = ${leaseUntil}, "claims" = n."claims" + 1
      WHERE n."id" IN (
        SELECT q."id" FROM "kanban_notification" q
        WHERE q."sentAt" IS NULL AND q."abandonedAt" IS NULL
          AND (q."nextAttemptAt" IS NULL OR q."nextAttemptAt" <= ${now})
          AND (q."claimedUntil" IS NULL OR q."claimedUntil" <= ${now})
          AND NOT (q."id" = ANY(${[...exclude]}::uuid[]))
          ${elsewhere}
        ORDER BY q."createdAt" ASC, q."id" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING n."id", n."boardId", n."cardId", n."issueNumber", n."stateRevision",
                n."fromStatus" AS "from", n."toStatus" AS "to", n."blockKind", n."reasonCode", n."tripped", n."mention",
                n."createdAt", n."attempts", n."claims"
    `)
  }

  async release(row: KanbanNotificationClaim): Promise<void> {
    await this.db.$executeRaw(Prisma.sql`
      UPDATE "kanban_notification" SET "claimedUntil" = NULL
      WHERE "id" = ${row.id}::uuid AND "claims" = ${row.claims} AND "sentAt" IS NULL
    `)
  }

  async markSent(row: KanbanNotificationClaim): Promise<void> {
    await this.db.$executeRaw(Prisma.sql`
      UPDATE "kanban_notification"
      SET "sentAt" = now(), "attempts" = "attempts" + 1, "lastError" = NULL, "claimedUntil" = NULL
      WHERE "id" = ${row.id}::uuid AND "claims" = ${row.claims} AND "sentAt" IS NULL
    `)
  }

  async markFailed(
    row: KanbanNotificationClaim,
    nextAttemptAt: Date,
    attempts: number,
    lastError: string
  ): Promise<void> {
    await this.db.$executeRaw(Prisma.sql`
      UPDATE "kanban_notification"
      SET "attempts" = ${attempts}, "nextAttemptAt" = ${nextAttemptAt}, "lastError" = ${lastError}, "claimedUntil" = NULL
      WHERE "id" = ${row.id}::uuid AND "claims" = ${row.claims} AND "sentAt" IS NULL
    `)
  }

  async giveUp(row: KanbanNotificationClaim, lastError: string): Promise<void> {
    await this.db.$executeRaw(Prisma.sql`
      UPDATE "kanban_notification"
      SET "lastError" = ${lastError}, "nextAttemptAt" = NULL, "abandonedAt" = now(), "claimedUntil" = NULL
      WHERE "id" = ${row.id}::uuid AND "claims" = ${row.claims} AND "sentAt" IS NULL
    `)
  }

  async target(boardId: string): Promise<KanbanNotifyTarget | null> {
    const [row] = await this.db.$queryRaw<KanbanNotifyTarget[]>(Prisma.sql`
      SELECT "orgId", "repoFullName", "targetPlatform", "targetChannel", "targetIntegrationId", "createdByUserId"
      FROM "kanban_board"
      WHERE "id" = ${boardId}::uuid
    `)
    return row ? { ...row, orgId: OrgId(row.orgId) } : null
  }
}

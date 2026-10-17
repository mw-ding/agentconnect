// Kanban notification outbox (issue #2 M4): insert replay-safe rows, drain pending ones to the anchor channel, and mark them.
import { Prisma } from '../../generated/prisma/client.js'
import { OrgId } from '../../domain/ids.js'
import type { PrismaLike } from '../prisma.js'
import type { KanbanNotificationInsert, KanbanNotificationRow, KanbanNotifyRepo, KanbanNotifyTarget } from '../ports.js'

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

  async pending(limit: number, now: Date): Promise<KanbanNotificationRow[]> {
    return this.db.$queryRaw<KanbanNotificationRow[]>(Prisma.sql`
      SELECT "id", "boardId", "cardId", "issueNumber", "stateRevision",
             "fromStatus" AS "from", "toStatus" AS "to", "blockKind", "reasonCode", "tripped", "mention",
             "createdAt", "attempts"
      FROM "kanban_notification"
      WHERE "sentAt" IS NULL AND "abandonedAt" IS NULL AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= ${now})
      ORDER BY "createdAt" ASC, "id" ASC
      LIMIT ${limit}
    `)
  }

  async markSent(id: string): Promise<void> {
    await this.db.$executeRaw(Prisma.sql`
      UPDATE "kanban_notification" SET "sentAt" = now(), "attempts" = "attempts" + 1, "lastError" = NULL
      WHERE "id" = ${id}::uuid
    `)
  }

  async markFailed(id: string, nextAttemptAt: Date, attempts: number, lastError: string): Promise<void> {
    await this.db.$executeRaw(Prisma.sql`
      UPDATE "kanban_notification"
      SET "attempts" = ${attempts}, "nextAttemptAt" = ${nextAttemptAt}, "lastError" = ${lastError}
      WHERE "id" = ${id}::uuid
    `)
  }

  async giveUp(id: string, lastError: string): Promise<void> {
    await this.db.$executeRaw(Prisma.sql`
      UPDATE "kanban_notification" SET "lastError" = ${lastError}, "nextAttemptAt" = NULL, "abandonedAt" = now()
      WHERE "id" = ${id}::uuid
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

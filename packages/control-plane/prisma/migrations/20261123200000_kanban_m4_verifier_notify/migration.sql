-- Verifier routing (M4): each run records its role, a review card counts its rounds and stamps when the verifier approved.

-- CreateEnum
CREATE TYPE "KanbanRunRole" AS ENUM ('work', 'verify');

-- AlterEnum
ALTER TYPE "KanbanRunOutcome" ADD VALUE 'changes_requested';

-- AlterTable
ALTER TABLE "kanban_run" ADD COLUMN "role" "KanbanRunRole" NOT NULL DEFAULT 'work';

-- AlterTable
ALTER TABLE "kanban_card" ADD COLUMN "reviewRounds" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "kanban_card" ADD COLUMN "verifiedAt" TIMESTAMPTZ(6);

-- Transition notifications (M4): a body-free outbox that drains to the board's anchor channel.

-- CreateTable
CREATE TABLE "kanban_notification" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "boardId" UUID NOT NULL,
    "cardId" UUID NOT NULL,
    "issueNumber" INTEGER NOT NULL,
    "stateRevision" BIGINT NOT NULL,
    "fromStatus" "KanbanCardStatus" NOT NULL,
    "toStatus" "KanbanCardStatus" NOT NULL,
    "blockKind" "KanbanBlockKind",
    "reasonCode" TEXT,
    "tripped" TEXT,
    "mention" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMPTZ(6),
    "abandonedAt" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(6),
    "lastError" TEXT,
    "claimedUntil" TIMESTAMPTZ(6),
    "claims" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "kanban_notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "kanban_notification_cardId_stateRevision_key" ON "kanban_notification"("cardId", "stateRevision");

-- CreateIndex
CREATE INDEX "kanban_notification_pending_idx" ON "kanban_notification"("boardId", "createdAt") WHERE "sentAt" IS NULL AND "abandonedAt" IS NULL;

-- AddForeignKey
ALTER TABLE "kanban_notification" ADD CONSTRAINT "kanban_notification_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "kanban_board"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_notification" ADD CONSTRAINT "kanban_notification_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "kanban_card"("id") ON DELETE CASCADE ON UPDATE CASCADE;

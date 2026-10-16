-- Kanban M2 (issue #2): lease bookkeeping for the dispatcher, heartbeat, and stale-lease reaper.

-- CreateEnum
CREATE TYPE "KanbanRunMode" AS ENUM ('read', 'write');

-- AlterTable
ALTER TABLE "kanban_run" ADD COLUMN "daemonEpoch" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN "mode" "KanbanRunMode" NOT NULL DEFAULT 'read',
ADD COLUMN "ackedAt" TIMESTAMPTZ(6);

-- At most one live lease per card: a second concurrent claim fails at the storage layer, not just in the claimer.
CREATE UNIQUE INDEX "kanban_run_open_card_uq" ON "kanban_run"("cardId") WHERE "endedAt" IS NULL;

-- Reaper scan over open runs only.
CREATE INDEX "kanban_run_open_heartbeat_idx" ON "kanban_run"("heartbeatAt") WHERE "endedAt" IS NULL;

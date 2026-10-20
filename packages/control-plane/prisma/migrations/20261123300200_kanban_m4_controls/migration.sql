-- Kanban M4 controls (issue #2 B5): board pause/resume and card skip/restart.
ALTER TABLE "kanban_board" ADD COLUMN "paused" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "kanban_board" ADD COLUMN "pausedAt" TIMESTAMPTZ(6);
ALTER TABLE "kanban_board" ADD COLUMN "pausedByUserId" TEXT;
ALTER TABLE "kanban_board" ADD CONSTRAINT "kanban_board_pausedByUserId_fkey" FOREIGN KEY ("pausedByUserId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- B3: the Synthesizer agent a fully-completed epic is promoted to.
ALTER TABLE "kanban_board" ADD COLUMN "synthesizerAgentId" UUID;
ALTER TABLE "kanban_board" ADD CONSTRAINT "kanban_board_synthesizerAgentId_fkey" FOREIGN KEY ("synthesizerAgentId") REFERENCES "agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TYPE "AuditKind" ADD VALUE 'board_paused';
ALTER TYPE "AuditKind" ADD VALUE 'board_resumed';
ALTER TYPE "AuditKind" ADD VALUE 'card_skipped';
ALTER TYPE "AuditKind" ADD VALUE 'card_restarted';

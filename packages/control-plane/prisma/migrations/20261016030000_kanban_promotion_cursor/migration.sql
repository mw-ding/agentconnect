-- Replace the time-window receipt with a pre-POST events cursor, cap recovery, and flag cards that need a human.
ALTER TABLE "kanban_card" DROP COLUMN "promotionReadyEventId";
ALTER TABLE "kanban_card" DROP COLUMN "promotionReadyNotAfter";
ALTER TABLE "kanban_card" RENAME COLUMN "promotionWriteStartedAt" TO "promotionStartedAt";
ALTER TABLE "kanban_card" ADD COLUMN "promotionEventCursor" BIGINT;
ALTER TABLE "kanban_card" ADD COLUMN "promotionPostAccepted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "kanban_card" ADD COLUMN "promotionChecks" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "kanban_card" ADD COLUMN "needsAttention" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "kanban_card" ADD COLUMN "attentionReason" TEXT;

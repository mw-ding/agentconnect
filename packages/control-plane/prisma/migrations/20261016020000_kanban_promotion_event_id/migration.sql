-- Replace the ready-label Date receipt with our labeled event id and its search window.
ALTER TABLE "kanban_card" DROP COLUMN "promotionReadyAddedAt";
ALTER TABLE "kanban_card" ADD COLUMN "promotionReadyEventId" BIGINT;
ALTER TABLE "kanban_card" ADD COLUMN "promotionWriteStartedAt" TIMESTAMPTZ(6);
ALTER TABLE "kanban_card" ADD COLUMN "promotionReadyNotAfter" TIMESTAMPTZ(6);

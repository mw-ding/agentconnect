-- Replace the ready-label Date receipt with the GitHub event id of our labeled event.
ALTER TABLE "kanban_card" DROP COLUMN "promotionReadyAddedAt";
ALTER TABLE "kanban_card" ADD COLUMN "promotionReadyEventId" BIGINT;
ALTER TABLE "kanban_card" ADD COLUMN "promotionWriteStartedAt" TIMESTAMPTZ(6);

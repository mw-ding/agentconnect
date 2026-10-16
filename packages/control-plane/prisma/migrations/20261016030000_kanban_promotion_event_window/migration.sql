-- Upper bound of the ready-event search window. It is not a timestamp to match.
ALTER TABLE "kanban_card" ADD COLUMN "promotionReadyNotAfter" TIMESTAMPTZ(6);

-- Bind pending promotion repair to the server timestamp of our ready-label POST.
ALTER TABLE "kanban_card" ADD COLUMN "promotionReadyAddedAt" TIMESTAMPTZ(6);

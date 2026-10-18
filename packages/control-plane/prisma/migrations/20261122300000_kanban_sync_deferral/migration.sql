-- Label-sync deferral: a pass that cannot attribute a live label yet (events-API lag) is deferred,
-- and after a bounded number of deferred checks the card is failed closed to needsAttention.
ALTER TABLE "kanban_card"
  ADD COLUMN "syncDeferredAt" TIMESTAMPTZ(6),
  ADD COLUMN "syncDeferralCount" INTEGER NOT NULL DEFAULT 0;

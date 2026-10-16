-- Mismatch recovery re-reads GitHub on an exponential per-card backoff, reset whenever the card changes.
ALTER TABLE "kanban_card" ADD COLUMN "recoveryCheckAt" TIMESTAMPTZ(6);
ALTER TABLE "kanban_card" ADD COLUMN "recoveryChecks" INTEGER NOT NULL DEFAULT 0;

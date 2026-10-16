-- Mismatch recovery restarts its backoff when the GitHub status fingerprint it last read changes.
ALTER TABLE "kanban_card" ADD COLUMN "recoveryObserved" TEXT;
-- A graph promotion whose label write failed may have half-landed on GitHub, so recovery re-reads the card.
ALTER TABLE "kanban_card" ADD COLUMN "promotionPending" BOOLEAN NOT NULL DEFAULT false;

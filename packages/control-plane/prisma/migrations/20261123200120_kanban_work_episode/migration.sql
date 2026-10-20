-- The PR binding's created-after boundary is the card's work episode, kept across rework and cleared when the card leaves done.
ALTER TABLE "kanban_card" ADD COLUMN "workEpisodeStartedAt" TIMESTAMPTZ(6);
ALTER TABLE "kanban_card" ADD COLUMN "contractFlags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- In-flight cards keep a conservative boundary: the reporting run's start, else their latest work claim.
UPDATE "kanban_card" c
SET "workEpisodeStartedAt" = COALESCE(
  c."linkedPrWorkStartedAt",
  (SELECT max(r."dispatchedAt") FROM "kanban_run" r WHERE r."cardId" = c."id" AND r."role" = 'work')
)
WHERE c."status" IN ('running', 'review');

ALTER TABLE "kanban_card" DROP COLUMN "linkedPrWorkStartedAt";

-- The block kind a run reported. A replay matches this column, not the card, whose kind a later move can change.
ALTER TABLE "kanban_run" ADD COLUMN "blockKind" "KanbanBlockKind";

-- Runs that committed before the column existed stored the kind only on the card.
UPDATE "kanban_run" r
SET "blockKind" = c."blockKind"
FROM "kanban_card" c
WHERE r."cardId" = c."id"
  AND r."outcome" = 'blocked'::"KanbanRunOutcome"
  AND r."blockKind" IS NULL
  AND c."blockKind" IS NOT NULL;

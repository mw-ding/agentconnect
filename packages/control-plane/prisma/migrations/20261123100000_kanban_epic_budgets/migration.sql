-- B2 per-epic budgets (issue #2): board-wide child caps and an epic link + lifetime counter on each card.
ALTER TABLE "kanban_board" ADD COLUMN "epicMaxCards" INTEGER NOT NULL DEFAULT 100;
ALTER TABLE "kanban_board" ADD COLUMN "epicMaxActive" INTEGER NOT NULL DEFAULT 16;

ALTER TABLE "kanban_board" ADD CONSTRAINT "kanban_board_epicMaxCards_check" CHECK ("epicMaxCards" > 0);
ALTER TABLE "kanban_board" ADD CONSTRAINT "kanban_board_epicMaxActive_check" CHECK ("epicMaxActive" > 0);

ALTER TABLE "kanban_card" ADD COLUMN "epicCardId" UUID;
ALTER TABLE "kanban_card" ADD COLUMN "epicCardsCreated" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "kanban_card_epicCardId_idx" ON "kanban_card"("epicCardId");

ALTER TABLE "kanban_card" ADD CONSTRAINT "kanban_card_epicCardId_fkey" FOREIGN KEY ("epicCardId") REFERENCES "kanban_card"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "kanban_card"
  ADD COLUMN "labelWritePending" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "syncEventCursor" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "syncAgentCursor" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "syncCheckedAt" TIMESTAMPTZ(6);
CREATE INDEX "kanban_card_boardId_syncCheckedAt_idx" ON "kanban_card"("boardId", "syncCheckedAt");

-- One `/kanban` comment command per GitHub comment id, so a redelivered doorbell applies it at most once (TRD 4.4).
CREATE TABLE "kanban_command" (
    "id" UUID NOT NULL,
    "boardId" UUID NOT NULL,
    "cardId" UUID NOT NULL,
    "commentId" BIGINT NOT NULL,
    "command" TEXT NOT NULL,
    "actorLogin" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "fromStatus" "KanbanCardStatus" NOT NULL,
    "toStatus" "KanbanCardStatus",
    "settledAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kanban_command_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "kanban_command_boardId_commentId_key" ON "kanban_command"("boardId", "commentId");
CREATE INDEX "kanban_command_cardId_idx" ON "kanban_command"("cardId");

ALTER TABLE "kanban_command" ADD CONSTRAINT "kanban_command_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "kanban_board"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "kanban_command" ADD CONSTRAINT "kanban_command_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "kanban_card"("id") ON DELETE CASCADE ON UPDATE CASCADE;

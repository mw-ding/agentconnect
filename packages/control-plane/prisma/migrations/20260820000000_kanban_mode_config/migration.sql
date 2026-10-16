-- Mode authority is control-plane configuration, never GitHub labels or worker reports.
ALTER TABLE "kanban_board" ADD COLUMN "defaultMode" "KanbanRunMode" NOT NULL DEFAULT 'read';
ALTER TABLE "kanban_card" ADD COLUMN "mode" "KanbanRunMode";

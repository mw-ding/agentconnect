-- Kanban M4 controls (issue #2 B5): fence skip/restart GitHub writes by a per-card control version.
ALTER TABLE "kanban_card" ADD COLUMN "controlVersion" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "kanban_card" ADD COLUMN "controlWrittenVersion" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "kanban_card" ADD COLUMN "supersededPrNumber" INTEGER;

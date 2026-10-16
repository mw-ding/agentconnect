-- Mode configuration changes must not invalidate status promotion or rollback CAS tokens.
ALTER TABLE "kanban_card" ADD COLUMN "modeRevision" INTEGER NOT NULL DEFAULT 0;

ALTER TYPE "AuditKind" ADD VALUE 'kanban_mode_change';

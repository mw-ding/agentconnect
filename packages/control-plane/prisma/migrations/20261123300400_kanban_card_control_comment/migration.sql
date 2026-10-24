-- Kanban controls (#598): what a label-sync repair needs to re-post a skip/restart comment under its control key.
ALTER TABLE "kanban_card" ADD COLUMN "controlKind" TEXT;
ALTER TABLE "kanban_card" ADD COLUMN "controlActorLogin" TEXT;
ALTER TABLE "kanban_card" ADD COLUMN "controlAt" TIMESTAMPTZ(6);

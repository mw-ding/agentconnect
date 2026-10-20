-- The project a cached ProjectV2Item id belongs to: a card never reuses an item cached for another project.
ALTER TABLE "kanban_card" ADD COLUMN "projectItemProjectId" TEXT;

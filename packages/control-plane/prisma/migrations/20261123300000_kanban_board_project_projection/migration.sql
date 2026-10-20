-- Kanban Projects v2 Status projection: the project and its Status field are configured together or not at all.
ALTER TABLE "kanban_board" ADD COLUMN "projectNodeId" TEXT, ADD COLUMN "statusFieldId" TEXT;
ALTER TABLE "kanban_board" ADD CONSTRAINT "kanban_board_project_projection_pair_check"
  CHECK (("projectNodeId" IS NULL) = ("statusFieldId" IS NULL));
-- Cache of the card's ProjectV2Item id so later Status writes skip the add.
ALTER TABLE "kanban_card" ADD COLUMN "projectItemId" TEXT;

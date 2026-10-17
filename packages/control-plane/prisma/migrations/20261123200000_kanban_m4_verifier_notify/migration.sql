-- Verifier routing (M4): each run records its role, a review card counts its rounds and stamps when the verifier approved.

-- CreateEnum
CREATE TYPE "KanbanRunRole" AS ENUM ('work', 'verify');

-- AlterEnum
ALTER TYPE "KanbanRunOutcome" ADD VALUE 'changes_requested';

-- AlterTable
ALTER TABLE "kanban_run" ADD COLUMN "role" "KanbanRunRole" NOT NULL DEFAULT 'work';

-- AlterTable
ALTER TABLE "kanban_card" ADD COLUMN "reviewRounds" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "kanban_card" ADD COLUMN "verifiedAt" TIMESTAMPTZ(6);

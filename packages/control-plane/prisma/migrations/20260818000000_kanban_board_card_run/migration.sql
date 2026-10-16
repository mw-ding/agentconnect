-- Kanban M1 (issue #2): body-free board/card/run metadata; GitHub issues stay the system of record.

-- CreateEnum
CREATE TYPE "KanbanCardStatus" AS ENUM ('triage', 'todo', 'ready', 'running', 'blocked', 'review', 'done', 'archived');

-- CreateEnum
CREATE TYPE "KanbanBlockKind" AS ENUM ('dependency', 'needs_input', 'capability', 'transient');

-- CreateEnum
CREATE TYPE "KanbanCompletionContract" AS ENUM ('close', 'pr_merged', 'pr_checks_green');

-- CreateEnum
CREATE TYPE "KanbanRunOutcome" AS ENUM ('completed', 'review_requested', 'blocked', 'failed', 'protocol_violation', 'reclaimed', 'transient');

-- CreateTable
CREATE TABLE "kanban_board" (
    "id" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "repoId" BIGINT NOT NULL,
    "repoFullName" TEXT NOT NULL,
    "orchestratorAgentId" UUID,
    "verifierAgentId" UUID,
    "targetPlatform" TEXT NOT NULL DEFAULT 'slack',
    "targetChannel" TEXT,
    "targetIntegrationId" UUID,
    "maxInProgress" INTEGER NOT NULL DEFAULT 1,
    "maxInProgressPerAgent" INTEGER NOT NULL DEFAULT 1,
    "staleLeaseSec" INTEGER NOT NULL DEFAULT 14400,
    "failureLimit" INTEGER NOT NULL DEFAULT 2,
    "protocolRetryLimit" INTEGER NOT NULL DEFAULT 3,
    "blockRecurrenceLimit" INTEGER NOT NULL DEFAULT 2,
    "completionContract" "KanbanCompletionContract" NOT NULL DEFAULT 'close',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "configRevision" BIGINT NOT NULL DEFAULT 1,
    "visibility" "ResourceVisibility" NOT NULL DEFAULT 'org',
    "sharedWith" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdByUserId" TEXT,
    "lastModifiedByUserId" TEXT,
    "lastModifiedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "kanban_board_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kanban_card" (
    "id" UUID NOT NULL,
    "boardId" UUID NOT NULL,
    "issueId" BIGINT NOT NULL,
    "issueNodeId" TEXT,
    "issueNumber" INTEGER NOT NULL,
    "idempotencyKey" TEXT,
    "status" "KanbanCardStatus" NOT NULL DEFAULT 'triage',
    "assigneeAgentId" UUID,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "notBefore" TIMESTAMPTZ(6),
    "blockKind" "KanbanBlockKind",
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "protocolViolations" INTEGER NOT NULL DEFAULT 0,
    "blockRecurrence" INTEGER NOT NULL DEFAULT 0,
    "cooldownUntil" TIMESTAMPTZ(6),
    "linkedPrNumber" INTEGER,
    "dispatchRevision" BIGINT NOT NULL DEFAULT 1,
    "stateRevision" BIGINT NOT NULL DEFAULT 1,
    "githubSyncedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "kanban_card_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kanban_run" (
    "id" UUID NOT NULL,
    "cardId" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "agentId" UUID NOT NULL,
    "daemonId" UUID NOT NULL,
    "sessionId" TEXT,
    "leaseId" UUID NOT NULL,
    "dispatchRevision" BIGINT NOT NULL,
    "dispatchedAt" TIMESTAMPTZ(6) NOT NULL,
    "heartbeatAt" TIMESTAMPTZ(6),
    "endedAt" TIMESTAMPTZ(6),
    "outcome" "KanbanRunOutcome",
    "reasonCode" TEXT,

    CONSTRAINT "kanban_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "kanban_board_repoId_idx" ON "kanban_board"("repoId");

-- CreateIndex
CREATE UNIQUE INDEX "kanban_board_orgId_repoId_key" ON "kanban_board"("orgId", "repoId");

-- CreateIndex
CREATE INDEX "kanban_card_issueId_idx" ON "kanban_card"("issueId");

-- CreateIndex
CREATE INDEX "kanban_card_boardId_status_idx" ON "kanban_card"("boardId", "status");

-- CreateIndex
CREATE INDEX "kanban_card_assigneeAgentId_idx" ON "kanban_card"("assigneeAgentId");

-- CreateIndex
CREATE UNIQUE INDEX "kanban_card_boardId_issueId_key" ON "kanban_card"("boardId", "issueId");

-- CreateIndex
CREATE UNIQUE INDEX "kanban_card_boardId_issueNumber_key" ON "kanban_card"("boardId", "issueNumber");

-- CreateIndex
CREATE UNIQUE INDEX "kanban_card_boardId_idempotencyKey_key" ON "kanban_card"("boardId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "kanban_run_leaseId_key" ON "kanban_run"("leaseId");

-- CreateIndex
CREATE UNIQUE INDEX "kanban_run_cardId_attempt_key" ON "kanban_run"("cardId", "attempt");

-- AddForeignKey
ALTER TABLE "kanban_board" ADD CONSTRAINT "kanban_board_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_board" ADD CONSTRAINT "kanban_board_orchestratorAgentId_fkey" FOREIGN KEY ("orchestratorAgentId") REFERENCES "agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_board" ADD CONSTRAINT "kanban_board_verifierAgentId_fkey" FOREIGN KEY ("verifierAgentId") REFERENCES "agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_board" ADD CONSTRAINT "kanban_board_targetIntegrationId_fkey" FOREIGN KEY ("targetIntegrationId") REFERENCES "integration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_board" ADD CONSTRAINT "kanban_board_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_board" ADD CONSTRAINT "kanban_board_lastModifiedByUserId_fkey" FOREIGN KEY ("lastModifiedByUserId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_card" ADD CONSTRAINT "kanban_card_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "kanban_board"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_card" ADD CONSTRAINT "kanban_card_assigneeAgentId_fkey" FOREIGN KEY ("assigneeAgentId") REFERENCES "agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_run" ADD CONSTRAINT "kanban_run_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "kanban_card"("id") ON DELETE CASCADE ON UPDATE CASCADE;

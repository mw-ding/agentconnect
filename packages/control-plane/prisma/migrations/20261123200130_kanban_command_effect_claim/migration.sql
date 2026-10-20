-- One delivery at a time runs a comment command's GitHub effect; a claim older than the CP's TTL may be taken over.
ALTER TABLE "kanban_command" ADD COLUMN "effectClaimedAt" TIMESTAMPTZ(6);

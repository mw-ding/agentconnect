-- Watch a rolled-back promotion whose POST was never acknowledged, so a late-landing label escalates instead of stranding the card.
ALTER TABLE "kanban_card" ADD COLUMN "promotionWatchUntil" TIMESTAMPTZ(6);
UPDATE "kanban_card" SET "promotionWatchUntil" = "promotionStartedAt" + interval '10 minutes'
  WHERE "promotionPending" AND NOT "promotionPostAccepted";

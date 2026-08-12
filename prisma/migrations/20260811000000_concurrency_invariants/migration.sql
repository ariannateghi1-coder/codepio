-- Incremental database guards for accounting and watch concurrency invariants.
ALTER TABLE "User"
  ADD CONSTRAINT "User_credits_nonnegative" CHECK ("credits" >= 0) NOT VALID,
  ADD CONSTRAINT "User_points_nonnegative" CHECK ("points" >= 0) NOT VALID,
  ADD CONSTRAINT "User_reputation_range" CHECK ("reputation" BETWEEN 0 AND 1000) NOT VALID;

ALTER TABLE "Campaign"
  ADD CONSTRAINT "Campaign_budget_nonnegative" CHECK ("budgetCredits" >= 0) NOT VALID,
  ADD CONSTRAINT "Campaign_spent_nonnegative" CHECK ("spentCredits" >= 0) NOT VALID,
  ADD CONSTRAINT "Campaign_spent_within_budget" CHECK ("spentCredits" <= "budgetCredits") NOT VALID;

ALTER TABLE "WatchSession"
  ADD CONSTRAINT "WatchSession_counters_nonnegative" CHECK (
    "durationSec" >= 0 AND "requiredSec" >= 0 AND "accumulatedSec" >= 0 AND
    "heartbeats" >= 0 AND "seekCount" >= 0 AND "lastSequence" >= 0 AND
    "lastPosition" >= 0 AND "rejectedBeats" >= 0 AND "hiddenSec" >= 0
  ) NOT VALID;

ALTER TABLE "User" VALIDATE CONSTRAINT "User_credits_nonnegative";
ALTER TABLE "User" VALIDATE CONSTRAINT "User_points_nonnegative";
ALTER TABLE "User" VALIDATE CONSTRAINT "User_reputation_range";
ALTER TABLE "Campaign" VALIDATE CONSTRAINT "Campaign_budget_nonnegative";
ALTER TABLE "Campaign" VALIDATE CONSTRAINT "Campaign_spent_nonnegative";
ALTER TABLE "Campaign" VALIDATE CONSTRAINT "Campaign_spent_within_budget";
ALTER TABLE "WatchSession" VALIDATE CONSTRAINT "WatchSession_counters_nonnegative";

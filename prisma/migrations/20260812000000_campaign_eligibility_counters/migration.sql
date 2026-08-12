-- Incremental counters for scalable campaign eligibility.
ALTER TABLE "Campaign"
  ADD COLUMN "completedSupports" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "dailySupports" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "dailyCounterDay" DATE NOT NULL DEFAULT CURRENT_DATE;

WITH totals AS (
  SELECT "campaignId", COUNT(*)::INTEGER AS count
  FROM "Support"
  WHERE "status" = 'ACTIVE'
  GROUP BY "campaignId"
), daily AS (
  SELECT "campaignId", COUNT(*)::INTEGER AS count
  FROM "Support"
  WHERE "status" = 'ACTIVE' AND "createdAt" >= CURRENT_DATE
  GROUP BY "campaignId"
)
UPDATE "Campaign" AS campaign
SET "completedSupports" = COALESCE(totals.count, 0),
    "dailySupports" = COALESCE(daily.count, 0),
    "dailyCounterDay" = CURRENT_DATE
FROM totals
FULL JOIN daily ON daily."campaignId" = totals."campaignId"
WHERE campaign."id" = COALESCE(totals."campaignId", daily."campaignId");

ALTER TABLE "Campaign"
  ADD CONSTRAINT "Campaign_completed_supports_nonnegative" CHECK ("completedSupports" >= 0) NOT VALID,
  ADD CONSTRAINT "Campaign_daily_supports_nonnegative" CHECK ("dailySupports" >= 0) NOT VALID;

ALTER TABLE "Campaign" VALIDATE CONSTRAINT "Campaign_completed_supports_nonnegative";
ALTER TABLE "Campaign" VALIDATE CONSTRAINT "Campaign_daily_supports_nonnegative";

CREATE INDEX "Campaign_explore_eligibility_idx"
  ON "Campaign" ("status", "dailyCounterDay", "completedSupports", "dailySupports");

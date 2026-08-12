-- Retention support: permanent aggregates, self-contained Support outcome, and the
-- indexes the cleanup queries need.
--
-- ADDITIVE ONLY. This migration creates one table, adds four nullable/defaulted
-- columns and six indexes. It drops nothing and rewrites no existing column, so it
-- is safe to apply to a database already holding production rows.
--
-- Why each piece exists is documented in prisma/schema.prisma and
-- src/lib/services/retention.ts; the short version:
--
--   UserDailyRollup      XpLedger and AbuseSignal become 7-day tables, but the
--                        leaderboard reads 30-day and all-time windows and
--                        recalculateTrustScore() reads a 30-day window. Those
--                        consumers now read this permanent per-day aggregate.
--
--   Support.watchedSec   The Support row becomes a self-contained record of its own
--   .requiredWatchSec    outcome, so WatchSession / SupportVerification /
--   .riskScore           SupportTask can actually be deleted without losing the
--   .verification        ability to audit why a past support was paid.
--
--   indexes              The cleanup scans by age across all users; the existing
--                        composite indexes are user-scoped and cannot serve a bare
--                        createdAt range.

-- ---------------------------------------------------------------------------
-- 1. Permanent per-user, per-day aggregates
-- ---------------------------------------------------------------------------
CREATE TABLE "UserDailyRollup" (
    "userId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "xp" INTEGER NOT NULL DEFAULT 0,
    "abuseSeverity" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "UserDailyRollup_pkey" PRIMARY KEY ("userId","day")
);

-- Leaderboard reads "everyone, since <day>", so day must lead.
CREATE INDEX "UserDailyRollup_day_idx" ON "UserDailyRollup"("day");

ALTER TABLE "UserDailyRollup"
  ADD CONSTRAINT "UserDailyRollup_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 2. Backfill the rollup from the detail tables, BEFORE they start being pruned
-- ---------------------------------------------------------------------------
-- Without this, existing users would appear to have zero lifetime XP on the
-- leaderboard the moment it switched to reading the rollup. Runs once; the
-- ON CONFLICT clauses make a re-run a no-op rather than a double count.
--
-- Both aggregates are grouped on the UTC date of createdAt, matching utcDay() in
-- src/lib/services/ledger.ts. SUM is the NET signed sum, so historical reversals
-- cancel out exactly as they do in User.points.
INSERT INTO "UserDailyRollup" ("userId", "day", "xp", "abuseSeverity")
SELECT "userId", ("createdAt" AT TIME ZONE 'UTC')::date AS day, SUM("amount"), 0
FROM "XpLedger"
GROUP BY "userId", ("createdAt" AT TIME ZONE 'UTC')::date
ON CONFLICT ("userId", "day") DO NOTHING;

INSERT INTO "UserDailyRollup" ("userId", "day", "xp", "abuseSeverity")
SELECT "userId", ("createdAt" AT TIME ZONE 'UTC')::date AS day, 0, SUM("severity")
FROM "AbuseSignal"
GROUP BY "userId", ("createdAt" AT TIME ZONE 'UTC')::date
ON CONFLICT ("userId", "day") DO UPDATE
  SET "abuseSeverity" = "UserDailyRollup"."abuseSeverity" + EXCLUDED."abuseSeverity";

-- ---------------------------------------------------------------------------
-- 3. Support becomes a self-contained outcome record
-- ---------------------------------------------------------------------------
-- Defaults of 0 / NULL, so existing rows remain valid. Historical supports keep
-- zeros: their evidence was never copied because it did not exist yet, and
-- inventing values from WatchSession here would be a guess about which session
-- belonged to which support for rows predating the link.
ALTER TABLE "Support" ADD COLUMN "watchedSec" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Support" ADD COLUMN "requiredWatchSec" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Support" ADD COLUMN "riskScore" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Support" ADD COLUMN "verification" JSONB;

-- ---------------------------------------------------------------------------
-- 4. Indexes for the retention scans
-- ---------------------------------------------------------------------------
-- Each one serves a query in src/lib/services/retention.ts and nothing else, which
-- is why there is no index here for tables the cleanup does not touch.
--
-- CREATE INDEX (not CONCURRENTLY): Prisma wraps a migration in a transaction and
-- CONCURRENTLY cannot run inside one. On the current data volume the resulting
-- brief write lock is not a concern; if these tables are large by the time this
-- runs, apply the CONCURRENTLY variants by hand first and this becomes a no-op via
-- IF NOT EXISTS.
CREATE INDEX IF NOT EXISTS "Notification_createdAt_idx" ON "Notification"("createdAt");
CREATE INDEX IF NOT EXISTS "Activity_createdAt_idx" ON "Activity"("createdAt");
CREATE INDEX IF NOT EXISTS "AbuseSignal_createdAt_idx" ON "AbuseSignal"("createdAt");
CREATE INDEX IF NOT EXISTS "SupportVerification_createdAt_idx" ON "SupportVerification"("createdAt");

-- Finds terminal sessions old enough for their execution state to be purged.
CREATE INDEX IF NOT EXISTS "SupportSession_state_updatedAt_idx" ON "SupportSession"("state", "updatedAt");

-- AuditLog and XpLedger already have a createdAt index from the initial migration:
-- "XpLedger_createdAt_idx" is ASC and "AuditLog_createdAt_idx" is DESC. Neither
-- needs a duplicate — PostgreSQL can scan a btree in either direction, so a DESC
-- index serves the ascending oldest-first range scan the cleanup performs.

-- Subscription compliance.
--
-- ADDITIVE ONLY. This migration creates one enum, one table, its indexes and its
-- foreign keys. It does not drop, rename, retype or backfill anything, so every
-- existing row in User, Support, CreditLedger, XpLedger and SupportSession is
-- untouched and no historical support changes meaning.
--
-- Why a new table rather than columns on Support:
--   Support is the permanent financial record. Compliance is mutable state that
--   flips between ACTIVE / VIOLATED / RESTORED over the life of that support, and
--   writing it onto Support would mean the accounting row is rewritten every time
--   a background check runs. SupportStatus was the other candidate and was
--   rejected outright: its only non-ACTIVE value is REVERSED, and reversing a
--   support claws back credits and XP — which is exactly what must NOT happen
--   when someone unsubscribes.
--
-- Supports that predate this migration simply have no compliance row, which reads
-- as "no subscription obligation on record" — the correct interpretation, since
-- nothing verified and stored one at the time.

CREATE TYPE "ComplianceStatus" AS ENUM ('ACTIVE', 'VIOLATED', 'RESTORED');

CREATE TABLE "SubscriptionCompliance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "supportId" TEXT NOT NULL,
    "targetChannelId" TEXT NOT NULL,
    "subscriptionRequired" BOOLEAN NOT NULL DEFAULT true,
    "subscriptionVerified" BOOLEAN NOT NULL DEFAULT false,
    "lastKnownSubscribed" BOOLEAN NOT NULL DEFAULT false,
    "lastSubscriptionCheckAt" TIMESTAMP(3),
    "status" "ComplianceStatus" NOT NULL DEFAULT 'ACTIVE',
    "checkFailureCount" INTEGER NOT NULL DEFAULT 0,
    "nextCheckAfter" TIMESTAMP(3),
    "violationDetectedAt" TIMESTAMP(3),
    "restoredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionCompliance_pkey" PRIMARY KEY ("id")
);

-- One obligation per support: the support names exactly one campaign, which names
-- exactly one creator channel. This is also what makes creation idempotent — a
-- replayed settlement upserts the same row instead of stacking duplicates.
CREATE UNIQUE INDEX "SubscriptionCompliance_supportId_key" ON "SubscriptionCompliance"("supportId");

-- The gate's hot path: "does this user have any VIOLATED row?" on every sensitive
-- operation. Must be an index lookup, never a scan of the user's history.
CREATE INDEX "SubscriptionCompliance_userId_status_idx" ON "SubscriptionCompliance"("userId", "status");

-- The periodic sweep's selection: rows of a given status whose verification has
-- gone stale, oldest first.
CREATE INDEX "SubscriptionCompliance_status_lastSubscriptionCheckAt_idx" ON "SubscriptionCompliance"("status", "lastSubscriptionCheckAt");

-- Backoff filter, so a sweep skips rows parked after a temporary API failure
-- without reading them.
CREATE INDEX "SubscriptionCompliance_nextCheckAfter_idx" ON "SubscriptionCompliance"("nextCheckAfter");

CREATE INDEX "SubscriptionCompliance_targetChannelId_idx" ON "SubscriptionCompliance"("targetChannelId");

ALTER TABLE "SubscriptionCompliance" ADD CONSTRAINT "SubscriptionCompliance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SubscriptionCompliance" ADD CONSTRAINT "SubscriptionCompliance_supportId_fkey" FOREIGN KEY ("supportId") REFERENCES "Support"("id") ON DELETE CASCADE ON UPDATE CASCADE;

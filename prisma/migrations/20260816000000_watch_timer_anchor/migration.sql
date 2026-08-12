-- Watch timer anchor.
--
-- The watch flow no longer embeds a player: the supporter opens the video on
-- youtube.com and completion is decided by elapsed SERVER time since the open.
-- "openedAt" is that anchor. It is written once per session with a conditional
-- UPDATE, so refreshes and replayed requests cannot restart or duplicate a timer.
--
-- ADDITIVE ONLY: one nullable column plus one index, and a default change on an
-- existing column. No DROP, no rewrite, no data loss. Safe on a populated
-- database, and safe to re-run.

ALTER TABLE "WatchSession" ADD COLUMN IF NOT EXISTS "openedAt" TIMESTAMP(3);

-- Backfill for sessions created under the old heartbeat model, so their history
-- keeps a sensible anchor instead of reading as "never opened". startedAt is the
-- closest truth available: it is when the player was mounted.
--
-- Deliberately limited to rows that actually recorded playback (accumulatedSec > 0):
-- a row with no progress was never really watched, and inventing an anchor for it
-- would make an abandoned session look completable.
UPDATE "WatchSession"
SET "openedAt" = "startedAt"
WHERE "openedAt" IS NULL AND "accumulatedSec" > 0;

-- Supports the timer lookup by session, which is the only query on this column.
CREATE INDEX IF NOT EXISTS "WatchSession_openedAt_idx" ON "WatchSession"("openedAt");

-- The uniform requirement is now 99%. This changes the DEFAULT for future rows
-- only; existing campaigns keep the percentage they were created with, which is
-- what makes their history readable.
ALTER TABLE "Campaign" ALTER COLUMN "requiredWatchPercent" SET DEFAULT 99;

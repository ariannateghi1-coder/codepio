-- The Google account each OAuth grant belongs to.
--
-- Additive and nullable: existing grants keep working and are backfilled from
-- Google's userinfo endpoint on their next refresh.
--
-- Why it exists: "you did not subscribe" is unfalsifiable for a user who really
-- did subscribe on a different Google account. Naming the inspected identity is
-- the only way they can discover the mismatch themselves.
ALTER TABLE "YoutubeAccount" ADD COLUMN IF NOT EXISTS "googleEmail" TEXT;

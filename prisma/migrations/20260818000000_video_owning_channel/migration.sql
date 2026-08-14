-- Subscribe target: the channel that OWNS the campaign video.
--
-- WHY
-- The subscribe task was verified against the CREATOR'S LINKED CHANNEL
-- (YoutubeConnection). That row only exists once a creator completes the YouTube
-- OAuth flow, which is optional. For a campaign whose uploader had not connected
-- their account, the target resolved to NULL, the subscribe branch was skipped,
-- and the task was recorded as FAILED — so a supporter who really had subscribed
-- was told they had not, and re-checking could never clear it, because nothing
-- about re-checking makes the creator connect an account.
--
-- Video ownership, unlike an OAuth link, is PUBLIC: videos.list names the
-- uploading channel. Storing it on the video makes the subscribe target knowable
-- for every campaign video, and pins it so it cannot drift mid-session.
--
-- ADDITIVE ONLY: two nullable columns and one index. No DROP, no rewrite, no data
-- loss, and safe to re-run.

ALTER TABLE "Video" ADD COLUMN IF NOT EXISTS "channelId" TEXT;
ALTER TABLE "Video" ADD COLUMN IF NOT EXISTS "channelTitle" TEXT;

-- Existing rows are backfilled from the creator's linked channel where one is
-- known. That is the best value available offline and it matches the behaviour
-- those campaigns already had; rows left NULL are resolved lazily from
-- videos.list on the next verification and persisted then, costing one unit per
-- video, once.
UPDATE "Video" AS v
SET "channelId" = c."channelId",
    "channelTitle" = COALESCE(v."channelTitle", c."channelTitle")
FROM "YoutubeConnection" AS c
WHERE v."userId" = c."userId"
  AND v."channelId" IS NULL
  AND c."verified" = true;

CREATE INDEX IF NOT EXISTS "Video_channelId_idx" ON "Video"("channelId");

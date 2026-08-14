-- Creator-declared kids content on a campaign.
--
-- WHY A DECLARATION AND NOT A DETECTION
-- We already store Video.madeForKids from videos.list, and it correctly identifies
-- videos whose LIKE cannot be verified: on that content YouTube keeps the like out
-- of the viewer's own "Liked videos" playlist, the only like surface a read-only
-- grant can read.
--
-- Subscriptions are the open question. Creators report that a real subscribe to a
-- kids channel is also not reported back, and the API cannot settle it: a
-- subscription that is absent from subscriptions.list is indistinguishable from one
-- that was never made. Rather than guess, the creator declares it and accepts the
-- consequence.
--
-- The previous behaviour — telling the creator to un-flag the video in YouTube
-- Studio — was the wrong remedy: it asked them to misdeclare kids content to YouTube
-- so that our checker would be satisfied.
--
-- Effect: subscribe and like are WAIVED for the campaign, never FAILED. The cost
-- falls on the creator, who pays the same budget for supports carrying weaker
-- evidence, so this cannot be used against supporters.
--
-- Additive with a safe default; existing campaigns keep verifying exactly as before.
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "kidsContent" BOOLEAN NOT NULL DEFAULT false;

-- Campaigns whose video YouTube itself reports as kids content are opted in, since
-- their like task is provably unverifiable today and would otherwise keep failing
-- honest supporters until the creator noticed the new switch.
UPDATE "Campaign" AS c
SET "kidsContent" = true
FROM "Video" AS v
WHERE c."videoId" = v."id"
  AND v."madeForKids" = true
  AND c."kidsContent" = false;

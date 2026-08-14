-- Corrective backfill for Video.channelId.
--
-- The previous migration seeded the subscribe target from the CREATOR'S LINKED
-- CHANNEL for rows that had none. That is wrong whenever a creator registers a
-- video they did not upload: the row then points at the creator's own channel
-- instead of the uploader's, and supporters are asked to subscribe to one channel
-- while the check looks at another. One production row was already wrong this way
-- (a Tech With Tim video stored as if it belonged to the registering user).
--
-- Ownership is public, so the authoritative value is videos.list. Clearing the
-- guessed rows makes the lazy resolver fetch and persist the real uploader on the
-- next verification, at a cost of one quota unit per video, once.
--
-- Rows whose stored channel genuinely equals the creator's channel are cleared too
-- and simply re-resolved to the same value. Additive and reversible: no data other
-- than a derived cache is touched.
UPDATE "Video" AS v
SET "channelId" = NULL,
    "channelTitle" = NULL
FROM "YoutubeConnection" AS c
WHERE v."userId" = c."userId"
  AND v."channelId" IS NOT NULL
  AND v."channelId" = c."channelId";

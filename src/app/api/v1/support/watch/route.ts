import { parseBody } from "@/lib/api";
import { active } from "@/lib/handler";
import { supportWatchSchema } from "@/lib/validators";
import { openWatchTarget, watchTimerStatus } from "@/lib/services/support";

/**
 * Watch timer.
 *
 *   POST — "I am opening the video now": stamps the server-side anchor and
 *          returns the YouTube URL to open plus the remaining time.
 *   PATCH — "how long is left?": recomputes from the anchor and, once the
 *          requirement has elapsed, satisfies the WATCH_VIDEO task.
 *
 * What the client CANNOT do, by construction rather than by validation:
 *   • send an elapsed time — the body carries only a session id
 *   • send completed=true — completion is derived from the anchor, never accepted
 *   • restart or extend the timer — the anchor is written once, under a row lock,
 *     with WHERE "openedAt" IS NULL, so refreshes and replays are no-ops
 *   • change the requirement — requiredSec is derived from YouTube's duration
 *
 * Ownership is enforced in the service (session.supporterId must equal the
 * caller), so a stolen session id from another user is rejected.
 *
 * The rate limit is loose on purpose: polling for remaining time is the intended
 * usage and reads nothing but the clock.
 */
export const POST = active(
  "support.watch.open",
  async ({ req, user }) => {
    const { sessionId } = await parseBody(req, supportWatchSchema);
    return openWatchTarget({ sessionId, supporterId: user.id });
  },
  { rateLimit: "supportWatch" }
);

export const PATCH = active(
  "support.watch.status",
  async ({ req, user }) => {
    const { sessionId } = await parseBody(req, supportWatchSchema);
    return watchTimerStatus({ sessionId, supporterId: user.id });
  },
  { rateLimit: "supportWatch" }
);

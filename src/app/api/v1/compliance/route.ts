import { active } from "@/lib/handler";
import { complianceSnapshot } from "@/lib/services/subscription-compliance";

/**
 * Current subscription-compliance state for the signed-in user.
 *
 * COSTS ZERO YOUTUBE QUOTA. This is the read the UI polls and every page render
 * uses, so it is served entirely from the database — `complianceSnapshot` has no
 * code path to the API at all. That is a structural guarantee, not a convention:
 * refreshing this endpoint a thousand times cannot spend a single unit.
 *
 * A live check is a separate, explicitly requested action (POST ../recheck).
 *
 * Ownership needs no check: the state is loaded by `user.id` from the session, so
 * there is no identifier in the request that could point at another account.
 * `stale` tells the client whether a recheck would consult YouTube, so the UI can
 * label the button honestly instead of implying a fresh check every time.
 */
export const GET = active(
  "compliance.status",
  async ({ user }) => complianceSnapshot(user.id),
  // Read-only: no CSRF, and no rate-limit policy — it touches nothing external
  // and the session guard already bounds who can call it.
  { csrf: false }
);

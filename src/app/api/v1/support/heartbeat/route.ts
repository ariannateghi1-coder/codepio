import { parseBody } from "@/lib/api";
import { active } from "@/lib/handler";
import { watchHeartbeatSchema } from "@/lib/validators";
import { recordWatchHeartbeat } from "@/lib/services/support";

/**
 * Watch heartbeat.
 *
 * The client reports its player position; the server decides what it is worth by
 * comparing the claimed progress with the wall-clock time it measured since the
 * previous heartbeat, and by tracking the union of watched segments. This is why
 * seeking to 90% earns nothing.
 *
 * The required `sequence` gives replay and out-of-order protection: the server
 * refuses a beat it has already applied, or one that arrives behind the last
 * accepted, so reordered delivery cannot corrupt the accounting.
 *
 * Ownership is enforced inside the service (session.supporterId must equal the
 * caller), so a stolen session id from another user is rejected.
 *
 * The rate limit is deliberately loose relative to the heartbeat cadence: too
 * tight a limit would break a legitimate long session, and cadence abuse is
 * already handled precisely by the sequence gate.
 */
export const POST = active(
  "support.heartbeat",
  async ({ req, user }) => {
    const data = await parseBody(req, watchHeartbeatSchema);
    return recordWatchHeartbeat({
      sessionId: data.sessionId,
      supporterId: user.id,
      position: data.position,
      playerState: data.playerState,
      sequence: data.sequence,
      hiddenSec: data.hiddenSec,
    });
  },
  { rateLimit: "supportHeartbeat" }
);

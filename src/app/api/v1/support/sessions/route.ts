import { parseBody } from "@/lib/api";
import { active } from "@/lib/handler";
import { supportStartSchema } from "@/lib/validators";
import { startSupportSession } from "@/lib/services/support";
import { youtubeEmbedUrl } from "@/lib/youtube";
import { env } from "@/lib/env";
import { youtubeConnectionState } from "@/lib/services/youtube-api";
import { WATCH_RULES } from "@/lib/gamification";

/**
 * Starts a support session.
 *
 * Requires an ACTIVE account, CSRF, and passes the rate-limit
 * policy. Eligibility, duplicate detection and the "one open session" rule live
 * in the service so they hold no matter which caller invokes them.
 *
 * The response tells the client exactly what will be verified and how, including
 * whether YouTube-side checks are possible for this user right now — so the UI
 * never promises verification it can't perform. The connection STATE is returned
 * rather than a boolean, because "never connected" and "connection expired, please
 * reconnect" need different copy.
 */
export const POST = active(
  "support.start",
  async ({ req, user, ipHash, userAgentHash }) => {
    const { campaignId } = await parseBody(req, supportStartSchema);

    const result = await startSupportSession({
      supporterId: user.id,
      campaignId,
      ipHash,
      userAgentHash,
    });

    const connection = await youtubeConnectionState(user.id);
    const oauthConnected = connection.state === "CONNECTED";

    return {
      sessionId: result.session.id,
      state: result.session.state,
      expiresAt: result.session.expiresAt,
      video: {
        id: result.video.id,
        youtubeVideoId: result.video.youtubeVideoId,
        durationSec: result.video.durationSec,
        embedUrl: youtubeEmbedUrl(result.video.youtubeVideoId, {
          origin: env.NEXT_PUBLIC_APP_URL,
          enableJsApi: true,
        }),
      },
      requiredWatchSeconds: result.requiredWatchSeconds,
      estimatedSeconds: result.estimatedSeconds,
      /** Cadence the client should use; the server validates what it observes. */
      heartbeatSeconds: WATCH_RULES.heartbeatSeconds,
      tasks: result.tasks.map((task) => ({
        ...task,
        /** Honest verification capability, per task, for this user. */
        verifiable:
          task.type === "WATCH_VIDEO"
            ? "PLATFORM_OBSERVED"
            : oauthConnected
              ? "YOUTUBE_API"
              : "REQUIRES_YOUTUBE_CONNECTION",
      })),
      youtubeConnected: oauthConnected,
      youtubeState: connection.state,
    };
  },
  { rateLimit: "supportStart" }
);

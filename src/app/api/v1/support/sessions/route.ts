import { parseBody } from "@/lib/api";
import { active } from "@/lib/handler";
import { supportStartSchema } from "@/lib/validators";
import { startSupportSession } from "@/lib/services/support";
import { youtubeWatchUrl } from "@/lib/youtube";
import { youtubeConnectionState } from "@/lib/services/youtube-api";

/**
 * Starts a support session.
 *
 * Requires an ACTIVE account, CSRF, and passes the rate-limit policy.
 * Eligibility, duplicate detection and the "one open session" rule live in the
 * service so they hold no matter which caller invokes them.
 *
 * WATCH TARGET: a canonical youtube.com watch URL, NOT an embed. The supporter
 * watches on YouTube (the app in the app, the site on desktop), which is why
 * there is no embedUrl and no heartbeat cadence here any more. `requiredWatchSeconds`
 * is computed server-side from the duration YouTube reported; the client is told
 * the number so it can show progress, but it has no way to change it.
 *
 * The response also states what will be verified and how, including whether
 * YouTube-side checks are possible for this user right now, so the UI never
 * promises verification it cannot perform. The connection STATE is returned
 * rather than a boolean, because "never connected" and "connection expired,
 * please reconnect" need different copy.
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
        /** Opened in a new tab / the YouTube app. Never embedded. */
        watchUrl: youtubeWatchUrl(result.video.youtubeVideoId),
      },
      requiredWatchSeconds: result.requiredWatchSeconds,
      /** Null until the video is opened; the timer starts on the server then. */
      openedAt: result.openedAt,
      remainingSeconds: result.remainingSeconds,
      estimatedSeconds: result.estimatedSeconds,
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

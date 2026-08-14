import { prisma } from "@/lib/prisma";
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

    // The channel identity the checks will run against. Returned so the flow can
    // tell the user WHICH YouTube account must perform the subscribe and like:
    // with two accounts signed in, acting on the wrong one produces a real
    // subscription that this grant can never see, and the failure looks like a bug.
    const connectedChannel = oauthConnected
      ? await prisma.youtubeConnection.findUnique({
          where: { userId: user.id },
          select: { channelId: true, channelTitle: true },
        })
      : null;

    /**
     * Whether subscribe and like verification is waived for this campaign.
     *
     * Either the creator declared it as kids content, or YouTube itself reports the
     * video as "Made for Kids". On that content YouTube does not report these
     * actions back to a read-only client, so the flow must say so up front instead
     * of sending supporters to repeat an action that can never be confirmed.
     */
    const waiver = await prisma.campaign
      .findUnique({
        where: { id: campaignId },
        select: { kidsContent: true, video: { select: { madeForKids: true } } },
      })
      .then((c) => Boolean(c?.kidsContent || c?.video?.madeForKids));

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
      /** The channel to subscribe to, named, with a direct subscribe link. */
      targetChannel: result.targetChannel,
      /**
       * True when YouTube's kids restrictions make subscribe and like unverifiable,
       * so the UI can label both as accepted-without-checking rather than pending.
       */
      kidsContentWaiver: waiver,
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
      /**
       * Which YouTube identity the subscribe/like checks will inspect.
       *
       * The email is included because that is what users recognise. Someone signed
       * into two Google accounts cannot tell which one we read from a channel name,
       * and that ambiguity is what makes a correct "not verified" look like a bug.
       */
      connectedChannel: connectedChannel
        ? { id: connectedChannel.channelId, title: connectedChannel.channelTitle, email: connection.googleEmail }
        : null,
    };
  },
  { rateLimit: "supportStart" }
);

import { prisma } from "@/lib/prisma";
import { authed } from "@/lib/handler";
import { revokeOAuthGrant, youtubeConnectionState } from "@/lib/services/youtube-api";
import { features } from "@/lib/env";
import { writeAudit } from "@/lib/audit";

/**
 * Channel connection status + disconnect.
 *
 * The response distinguishes verification levels explicitly so the UI can label
 * them honestly instead of showing a generic "verified" badge:
 *   YOUTUBE_API      — ownership proven through OAuth
 *   SELF_REPORTED    — user typed it, unproven
 *   UNVERIFIED       — nothing established
 *
 * It also returns the OAuth lifecycle STATE rather than a boolean, because
 * "never connected", "expired", "you revoked it" and "Google is erroring" need
 * different copy and different user actions.
 */
export const GET = authed(
  "youtube.channel.get",
  async ({ user }) => {
    const [connection, account, lifecycle] = await Promise.all([
      prisma.youtubeConnection.findUnique({
        where: { userId: user.id },
        select: {
          channelId: true,
          channelTitle: true,
          channelUrl: true,
          thumbnailUrl: true,
          subscriberCount: true,
          verified: true,
          verificationMethod: true,
          verifiedAt: true,
          syncedAt: true,
        },
      }),
      prisma.youtubeAccount.findUnique({
        where: { userId: user.id },
        select: { scope: true, lastRefreshedAt: true, accessTokenExpires: true },
      }),
      youtubeConnectionState(user.id),
    ]);

    const usable = lifecycle.state === "CONNECTED";

    return {
      channel: connection,
      oauth: {
        available: features.youtubeOAuth,
        connected: usable,
        state: lifecycle.state,
        /** Present only for a broken connection, to explain what to do next. */
        lastErrorCode: usable ? null : lifecycle.lastErrorCode,
        scopes: account?.scope?.split(" ") ?? [],
        lastRefreshedAt: account?.lastRefreshedAt ?? null,
      },
      /** What the platform can prove for this user right now. */
      capabilities: {
        subscriptionVerification: usable,
        likeVerification: usable,
        watchVerification: "PLATFORM_OBSERVED",
        commentVerification: connection?.channelId ? Boolean(features.youtubeDataApi) : false,
      },
    };
  },
  { csrf: false }
);

export const DELETE = authed("youtube.channel.disconnect", async ({ req, user }) => {
  await revokeOAuthGrant(user.id);
  await prisma.$transaction([
    prisma.youtubeConnection.updateMany({
      where: { userId: user.id },
      data: { verified: false, verificationMethod: "UNVERIFIED", verifiedAt: null },
    }),
    prisma.user.update({ where: { id: user.id }, data: { youtubeVerified: false } }),
  ]);

  await writeAudit({ userId: user.id, action: "DELETE", entity: "YoutubeConnection", entityId: user.id, req });
  return { message: "اتصال کانال یوتیوب قطع شد." };
});

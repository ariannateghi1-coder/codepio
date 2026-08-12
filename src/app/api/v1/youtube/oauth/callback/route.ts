import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { route } from "@/lib/api";
import { requireActiveUser } from "@/lib/security";
import { safeEqual, sha256 } from "@/lib/crypto";
import { env } from "@/lib/env";
import { exchangeCodeForTokens, fetchOwnChannel, storeOAuthGrant } from "@/lib/services/youtube-api";
import { recordReputation, ledgerKey } from "@/lib/services/ledger";
import { REPUTATION } from "@/lib/gamification";
import { evaluateBadges } from "@/lib/services/badges";
import { writeAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { OAUTH_STATE_COOKIE } from "@/lib/security-constants";

/**
 * OAuth callback: verifies `state`, exchanges the code, stores the encrypted
 * tokens, and — this is the point — establishes CHANNEL OWNERSHIP from the
 * authenticated `channels.list?mine=true` response.
 *
 * Typing a channel URL is never treated as proof; only this path sets
 * verified=true with method YOUTUBE_API.
 */
export const GET = route("youtube.oauth.callback", async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const redirect = (status: string) =>
    NextResponse.redirect(`${env.NEXT_PUBLIC_APP_URL}/settings/youtube?status=${status}`);

  if (error || !code || !state) return redirect(error === "access_denied" ? "denied" : "invalid");

  const user = await requireActiveUser();

  const jar = await cookies();
  const expected = jar.get(OAUTH_STATE_COOKIE)?.value;
  jar.delete(OAUTH_STATE_COOKIE);
  if (!expected || !safeEqual(expected, sha256(`${user.id}:${state}`))) {
    logger.warn("youtube oauth state mismatch", { userId: user.id });
    return redirect("state_mismatch");
  }

  const tokens = await exchangeCodeForTokens(code);

  // `sub` identifies the Google account; we read it from the id_token payload
  // without trusting anything else in it (the token itself came straight from
  // Google's token endpoint over TLS).
  const googleSub = decodeIdTokenSub(tokens.id_token) ?? `unknown:${user.id}`;

  await storeOAuthGrant({ userId: user.id, googleSub, tokens });

  const channel = await fetchOwnChannel(user.id);
  if (!channel) return redirect("no_channel");

  await prisma.$transaction(async (tx) => {
    await tx.youtubeConnection.upsert({
      where: { userId: user.id },
      update: {
        channelId: channel.channelId,
        channelTitle: channel.title,
        channelUrl: `https://www.youtube.com/channel/${channel.channelId}`,
        thumbnailUrl: channel.thumbnailUrl,
        subscriberCount: channel.subscriberCount,
        verified: true,
        verificationMethod: "YOUTUBE_API",
        verifiedAt: new Date(),
        syncedAt: new Date(),
      },
      create: {
        userId: user.id,
        channelId: channel.channelId,
        channelTitle: channel.title,
        channelUrl: `https://www.youtube.com/channel/${channel.channelId}`,
        thumbnailUrl: channel.thumbnailUrl,
        subscriberCount: channel.subscriberCount,
        verified: true,
        verificationMethod: "YOUTUBE_API",
        verifiedAt: new Date(),
        syncedAt: new Date(),
      },
    });

    await tx.youtubeAccount.update({ where: { userId: user.id }, data: { channelId: channel.channelId } });
    await tx.user.update({ where: { id: user.id }, data: { youtubeVerified: true } });

    await recordReputation(tx, {
      userId: user.id,
      type: "CHANNEL_VERIFIED",
      delta: REPUTATION.CHANNEL_VERIFIED,
      idempotencyKey: ledgerKey(["channel-verified", user.id, channel.channelId]),
      reason: "youtube channel ownership verified via OAuth",
    });

    await evaluateBadges(tx, user.id);
  });

  await writeAudit({
    userId: user.id,
    action: "UPDATE",
    entity: "YoutubeConnection",
    entityId: channel.channelId,
    req,
    metadata: { method: "YOUTUBE_API" },
  });

  return redirect("connected");
});

function decodeIdTokenSub(idToken?: string): string | null {
  if (!idToken) return null;
  const payload = idToken.split(".")[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub?: string };
    return json.sub ?? null;
  } catch {
    return null;
  }
}

import "server-only";
import type { YoutubeConnectionState } from "@prisma/client";
import { prisma } from "../prisma";
import { env, features } from "../env";
import { logger } from "../logger";
import { UpstreamError, internalMessage } from "../errors";
import { encryptSecret, decryptSecret } from "../crypto";
import { QUOTA_COST, recordQuotaSpend } from "./youtube-quota";
import { parseIsoDuration, isValidYoutubeChannelId, isValidYoutubeVideoId } from "../youtube";

/**
 * YouTube integration.
 *
 * What is actually verifiable, and how — this honesty is a product requirement,
 * not a caveat:
 *
 *  SUBSCRIBE  → verifiable server-side via subscriptions.list with the user's
 *               OAuth grant (youtube.readonly). Result: YOUTUBE_API.
 *  LIKE       → verifiable server-side via the liked-videos playlist with the user's
 *               OAuth grant. Result: YOUTUBE_API.
 *  WATCH 90%  → NOT verifiable through any YouTube API. There is no endpoint
 *               that reports whether a given user watched a given fraction of a
 *               video. We track it ourselves from IFrame Player events with
 *               server-side segment accounting. Result: PLATFORM_OBSERVED.
 *  COMMENT    → a comment's existence is public (commentThreads.list), so
 *               authorship can be matched to the connected channel:
 *               YOUTUBE_API when a channel is linked, otherwise SELF_REPORTED.
 *
 * Anything we cannot prove is labelled honestly in the UI. We never write
 * "Verified by YouTube" over a browser observation.
 */

const OAUTH_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const OAUTH_TOKEN = "https://oauth2.googleapis.com/token";
const OAUTH_REVOKE = "https://oauth2.googleapis.com/revoke";
const API_BASE = "https://www.googleapis.com/youtube/v3";

/**
 * Hard timeout for every outbound Google call.
 *
 * Without it, a hung connection would hold a database transaction open through
 * the whole verification step and eventually exhaust the connection pool — a
 * provider slowdown must not become an outage here.
 */
const REQUEST_TIMEOUT_MS = 8_000;

/** Minimum scopes. We never request write access to anyone's channel. */
export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "openid",
  "email",
] as const;

export function oauthRedirectUri() {
  return `${env.NEXT_PUBLIC_APP_URL}/api/v1/youtube/oauth/callback`;
}

export function buildOAuthUrl(state: string) {
  if (!features.youtubeOAuth) throw new UpstreamError("google", "OAuth client not configured");
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: oauthRedirectUri(),
    response_type: "code",
    scope: YOUTUBE_SCOPES.join(" "),
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    state,
  });
  return `${OAUTH_AUTHORIZE}?${params.toString()}`;
}

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  id_token?: string;
};

export async function exchangeCodeForTokens(code: string): Promise<TokenResponse> {
  if (!features.youtubeOAuth) throw new UpstreamError("google", "OAuth client not configured");
  const res = await fetch(OAUTH_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: oauthRedirectUri(),
      grant_type: "authorization_code",
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new UpstreamError("google", `token exchange failed with ${res.status}`);
  return (await res.json()) as TokenResponse;
}

/**
 * Returns a usable access token for a user, refreshing it when expired.
 * Tokens are stored encrypted (AES-256-GCM) and never logged or returned to a client.
 *
 * Returns a discriminated result rather than `string | null`, because "we have no
 * grant", "the grant is dead and only the user can fix it" and "Google is having
 * a bad minute" demand different behaviour: the first two must stop retrying, the
 * third must not be recorded as a verification failure.
 */
export type TokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; state: YoutubeConnectionState; reason: string; retryable: boolean };

/** Maximum consecutive transient failures before the grant is parked in ERROR. */
const MAX_REFRESH_FAILURES = 5;

async function getAccessToken(userId: string): Promise<TokenResult> {
  const account = await prisma.youtubeAccount.findUnique({ where: { userId } });
  if (!account) return { ok: false, state: "DISCONNECTED", reason: "NO_OAUTH_GRANT", retryable: false };

  if (account.state === "DISCONNECTED" || account.revokedAt) {
    return { ok: false, state: "DISCONNECTED", reason: "GRANT_REVOKED", retryable: false };
  }
  if (account.state === "REAUTH_REQUIRED") {
    // Already known dead. Do not spend a request confirming it again.
    return { ok: false, state: "REAUTH_REQUIRED", reason: "REAUTH_REQUIRED", retryable: false };
  }

  const stillValid = account.accessTokenExpires && account.accessTokenExpires.getTime() - 60_000 > Date.now();
  if (stillValid) {
    try {
      return { ok: true, accessToken: decryptSecret(account.accessTokenCipher) };
    } catch (e) {
      // Undecryptable ciphertext means the key rotated: the user must reconnect.
      logger.error("failed to decrypt youtube access token", { userId, error: internalMessage(e) });
      await markConnectionState(userId, "REAUTH_REQUIRED", "TOKEN_DECRYPT_FAILED");
      return { ok: false, state: "REAUTH_REQUIRED", reason: "TOKEN_DECRYPT_FAILED", retryable: false };
    }
  }

  if (!account.refreshTokenCipher) {
    await markConnectionState(userId, "EXPIRED", "NO_REFRESH_TOKEN");
    return { ok: false, state: "EXPIRED", reason: "NO_REFRESH_TOKEN", retryable: false };
  }
  if (!features.youtubeOAuth) {
    return { ok: false, state: "ERROR", reason: "OAUTH_NOT_CONFIGURED", retryable: true };
  }

  let refreshToken: string;
  try {
    refreshToken = decryptSecret(account.refreshTokenCipher);
  } catch (e) {
    logger.error("failed to decrypt youtube refresh token", { userId, error: internalMessage(e) });
    await markConnectionState(userId, "REAUTH_REQUIRED", "TOKEN_DECRYPT_FAILED");
    return { ok: false, state: "REAUTH_REQUIRED", reason: "TOKEN_DECRYPT_FAILED", retryable: false };
  }

  let res: Response;
  try {
    res = await fetch(OAUTH_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: env.GOOGLE_CLIENT_ID!,
        client_secret: env.GOOGLE_CLIENT_SECRET!,
        grant_type: "refresh_token",
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    // Network/timeout: transient. Never mark the grant dead for this.
    const failures = await bumpFailure(userId, "NETWORK_ERROR");
    logger.warn("youtube token refresh network failure", { userId, failures, error: internalMessage(e) });
    return { ok: false, state: "ERROR", reason: "NETWORK_ERROR", retryable: true };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const isInvalidGrant = res.status === 400 || res.status === 401 || /invalid_grant/i.test(body);

    if (isInvalidGrant) {
      // The user revoked access, changed their password, or the grant expired.
      // Only the user can fix this, so stop retrying and say so.
      await markConnectionState(userId, "REAUTH_REQUIRED", `invalid_grant (${res.status})`);
      logger.warn("youtube grant is no longer valid", { userId, status: res.status });
      return { ok: false, state: "REAUTH_REQUIRED", reason: "INVALID_GRANT", retryable: false };
    }

    // 5xx / 429: Google's problem, not the user's.
    const failures = await bumpFailure(userId, `HTTP_${res.status}`);
    logger.warn("youtube token refresh failed", { userId, status: res.status, failures });
    return { ok: false, state: "ERROR", reason: `HTTP_${res.status}`, retryable: failures < MAX_REFRESH_FAILURES };
  }

  const payload = (await res.json()) as TokenResponse;
  await prisma.youtubeAccount.update({
    where: { userId },
    data: {
      accessTokenCipher: encryptSecret(payload.access_token),
      accessTokenExpires: new Date(Date.now() + payload.expires_in * 1000),
      lastRefreshedAt: new Date(),
      state: "CONNECTED",
      failureCount: 0,
      lastErrorCode: null,
      ...(payload.refresh_token ? { refreshTokenCipher: encryptSecret(payload.refresh_token) } : {}),
    },
  });
  return { ok: true, accessToken: payload.access_token };
}

/** Moves a grant to an explicit terminal-ish state, so the UI can act on it. */
async function markConnectionState(userId: string, state: YoutubeConnectionState, code: string) {
  await prisma.youtubeAccount
    .update({
      where: { userId },
      data: {
        state,
        lastErrorCode: code.slice(0, 60),
        lastErrorAt: new Date(),
        ...(state === "DISCONNECTED" || state === "REAUTH_REQUIRED" ? { revokedAt: new Date() } : {}),
      },
    })
    .catch((e) => logger.warn("could not update youtube connection state", { userId, error: internalMessage(e) }));
}

/** Counts a transient failure; parks the grant in ERROR once they pile up. */
async function bumpFailure(userId: string, code: string): Promise<number> {
  const updated = await prisma.youtubeAccount
    .update({
      where: { userId },
      data: { failureCount: { increment: 1 }, lastErrorCode: code.slice(0, 60), lastErrorAt: new Date() },
      select: { failureCount: true },
    })
    .catch(() => null);
  const failures = updated?.failureCount ?? 0;
  if (failures >= MAX_REFRESH_FAILURES) await markConnectionState(userId, "ERROR", code);
  return failures;
}

/** Current connection state, for the UI and for verification decisions. */
export async function youtubeConnectionState(userId: string): Promise<{
  state: YoutubeConnectionState;
  channelId: string | null;
  /** The Google account the checks will run against, when known. */
  googleEmail: string | null;
  lastErrorCode: string | null;
}> {
  const account = await prisma.youtubeAccount.findUnique({
    where: { userId },
    select: { state: true, channelId: true, googleEmail: true, revokedAt: true, lastErrorCode: true },
  });
  if (!account) return { state: "DISCONNECTED", channelId: null, googleEmail: null, lastErrorCode: null };
  return {
    state: account.revokedAt && account.state === "CONNECTED" ? "DISCONNECTED" : account.state,
    channelId: account.channelId,
    googleEmail: account.googleEmail,
    lastErrorCode: account.lastErrorCode,
  };
}

export async function storeOAuthGrant(input: {
  userId: string;
  googleSub: string;
  /**
   * The Google account this grant belongs to.
   *
   * Stored so the product can NAME the identity it inspects. A user with several
   * Google accounts — the browser on one, the YouTube app on another — performs a
   * real subscribe or like that this grant cannot see, and a bare "not verified"
   * gives them no way to discover that. The channel title alone is not enough:
   * people recognise their email, not their channel id.
   */
  googleEmail?: string | null;
  tokens: TokenResponse;
  channelId?: string | null;
}) {
  const data = {
    googleSub: input.googleSub,
    ...(input.googleEmail ? { googleEmail: input.googleEmail } : {}),
    scope: input.tokens.scope,
    accessTokenCipher: encryptSecret(input.tokens.access_token),
    accessTokenExpires: new Date(Date.now() + input.tokens.expires_in * 1000),
    channelId: input.channelId ?? null,
    revokedAt: null,
    lastRefreshedAt: new Date(),
    // A fresh grant clears any previous dead state and its failure history.
    state: "CONNECTED" as const,
    failureCount: 0,
    lastErrorCode: null,
    ...(input.tokens.refresh_token ? { refreshTokenCipher: encryptSecret(input.tokens.refresh_token) } : {}),
  };
  await prisma.youtubeAccount.upsert({
    where: { userId: input.userId },
    update: data,
    create: { userId: input.userId, ...data },
  });
}

export async function revokeOAuthGrant(userId: string) {
  const account = await prisma.youtubeAccount.findUnique({ where: { userId } });
  if (!account) return;
  try {
    const token = account.refreshTokenCipher ? decryptSecret(account.refreshTokenCipher) : decryptSecret(account.accessTokenCipher);
    await fetch(`${OAUTH_REVOKE}?token=${encodeURIComponent(token)}`, {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    // Best effort: if Google never hears about it, the local grant is still gone.
    logger.warn("youtube revoke call failed", { userId, error: internalMessage(e) });
  }
  await prisma.youtubeAccount.update({
    where: { userId },
    data: { revokedAt: new Date(), state: "DISCONNECTED", failureCount: 0, lastErrorCode: null },
  });
}

async function apiGet<T>(path: string, params: Record<string, string>, auth: { accessToken?: string }): Promise<T> {
  const search = new URLSearchParams(params);
  const headers: Record<string, string> = {};
  if (auth.accessToken) {
    headers.Authorization = `Bearer ${auth.accessToken}`;
  } else if (env.YOUTUBE_API_KEY) {
    search.set("key", env.YOUTUBE_API_KEY);
  } else {
    throw new UpstreamError("youtube", "no credentials available for Data API call");
  }

  let res: globalThis.Response;
  try {
    res = await fetch(`${API_BASE}/${path}?${search.toString()}`, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new UpstreamError("youtube", `${path} request timed out or failed`, error);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new UpstreamError("youtube", `${path} responded ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export type VideoMetadataFailureCode =
  | "YOUTUBE_TIMEOUT"
  | "YOUTUBE_QUOTA_EXCEEDED"
  | "YOUTUBE_UPSTREAM_UNAVAILABLE"
  | "YOUTUBE_VIDEO_UNAVAILABLE";

export class VideoMetadataError extends UpstreamError {
  readonly metadataCode: VideoMetadataFailureCode;
  readonly retryable: boolean;

  constructor(code: VideoMetadataFailureCode, retryable: boolean, internal: string, cause?: unknown) {
    super("youtube", internal, cause);
    this.name = "VideoMetadataError";
    this.metadataCode = code;
    this.retryable = retryable;
  }
}

export function normalizeVideoMetadataError(error: unknown): VideoMetadataError {
  if (error instanceof VideoMetadataError) return error;
  const message = internalMessage(error);
  if (/timed? ?out|abort|network|ECONNRESET|fetch failed/i.test(message)) {
    return new VideoMetadataError("YOUTUBE_TIMEOUT", true, message, error);
  }
  if (/responded (429|403).*?(quotaExceeded|rateLimitExceeded|userRateLimitExceeded)|quotaExceeded|rateLimitExceeded|userRateLimitExceeded/i.test(message)) {
    return new VideoMetadataError("YOUTUBE_QUOTA_EXCEEDED", true, message, error);
  }
  if (/responded 5\d\d|backendError/i.test(message)) {
    return new VideoMetadataError("YOUTUBE_UPSTREAM_UNAVAILABLE", true, message, error);
  }
  return new VideoMetadataError("YOUTUBE_UPSTREAM_UNAVAILABLE", true, message, error);
}

export type VideoMetadata = {
  videoId: string;
  title: string;
  description: string;
  channelId: string;
  channelTitle: string;
  thumbnailUrl: string | null;
  durationSec: number | null;
  embeddable: boolean;
  privacyStatus: string;
  /**
   * True when YouTube applies its kids restrictions to this video — set by the
   * video's own flag OR by its channel's.
   *
   * Decides whether subscribe and like are verifiable at all. On kids content the
   * like does not appear in the viewer's own "Liked videos" playlist, which is the
   * only like surface a read-only grant can read, and subscriptions behave the same
   * way as far as we can tell from outside.
   */
  madeForKids: boolean;
};

/** Authoritative metadata straight from YouTube — never trusted from the client. */
export async function fetchVideoMetadata(videoId: string): Promise<VideoMetadata | null> {
  if (!isValidYoutubeVideoId(videoId)) return null;
  if (!features.youtubeDataApi) return null;

  type Response = {
    items?: {
      id: string;
      snippet: {
        title: string;
        description: string;
        channelId: string;
        channelTitle: string;
        thumbnails?: Record<string, { url: string }>;
      };
      contentDetails: { duration: string };
      status: { embeddable: boolean; privacyStatus: string; madeForKids?: boolean };
    }[];
  };

  let data: Response;
  try {
    data = await apiGet<Response>("videos", { part: "snippet,contentDetails,status", id: videoId }, {});
  } catch (error) {
    throw normalizeVideoMetadataError(error);
  }
  const item = data.items?.[0];
  if (!item) {
    throw new VideoMetadataError("YOUTUBE_VIDEO_UNAVAILABLE", false, `videos returned no item for ${videoId}`);
  }

  const thumbs = item.snippet.thumbnails ?? {};
  const thumbnailUrl = thumbs.maxres?.url ?? thumbs.high?.url ?? thumbs.medium?.url ?? thumbs.default?.url ?? null;

  return {
    videoId: item.id,
    title: item.snippet.title,
    description: item.snippet.description,
    channelId: item.snippet.channelId,
    channelTitle: item.snippet.channelTitle,
    thumbnailUrl,
    durationSec: parseIsoDuration(item.contentDetails.duration),
    embeddable: item.status.embeddable,
    privacyStatus: item.status.privacyStatus,
    // The video flag OR the channel flag. YouTube applies the kids restrictions
    // when EITHER is set, and a channel-level setting is not guaranteed to appear
    // on every individual upload — so trusting the per-video field alone leaves a
    // hole where a kids channel produces a video that reads as ordinary.
    madeForKids: item.status.madeForKids === true || (await channelIsMadeForKids(item.snippet.channelId)),
  };
}

/**
 * Channel-level "Made for Kids", as a fallback signal.
 *
 * Consulted only when the video itself does not carry the flag, so it costs one
 * extra unit on ordinary videos and none on kids content. Failures answer "not
 * stated" rather than propagating: this is a widening safety signal, and an
 * unreachable channels endpoint must not block registering a perfectly good video.
 */
async function channelIsMadeForKids(channelId: string): Promise<boolean> {
  try {
    const channel = await fetchChannelById(channelId);
    return channel?.madeForKids === true;
  } catch {
    return false;
  }
}

export type ChannelMetadata = {
  channelId: string;
  title: string;
  thumbnailUrl: string | null;
  subscriberCount: number | null;
  customUrl: string | null;
  /**
   * Channel-level "Made for Kids" setting, when YouTube reports one.
   *
   * A second, independent signal for the same restriction. Measured on this
   * deployment: a kids channel returns `true` here and every one of its uploads
   * carries the per-video flag as well, while an ordinary channel may omit the
   * field entirely — so `null` means "not stated", never "no".
   */
  madeForKids: boolean | null;
};

/** The channel owned by the OAuth-authenticated user — this is what proves ownership. */
export async function fetchOwnChannel(userId: string): Promise<ChannelMetadata | null> {
  const token = await getAccessToken(userId);
  if (!token.ok) return null;

  type Response = {
    items?: {
      id: string;
      snippet: { title: string; customUrl?: string; thumbnails?: Record<string, { url: string }> };
      statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean };
      status?: { madeForKids?: boolean };
    }[];
  };

  const data = await apiGet<Response>(
    "channels",
    { part: "snippet,statistics,status", mine: "true" },
    { accessToken: token.accessToken }
  );
  const item = data.items?.[0];
  if (!item) return null;

  const thumbs = item.snippet.thumbnails ?? {};
  return {
    channelId: item.id,
    title: item.snippet.title,
    thumbnailUrl: thumbs.high?.url ?? thumbs.medium?.url ?? thumbs.default?.url ?? null,
    subscriberCount: item.statistics?.subscriberCount ? Number(item.statistics.subscriberCount) : null,
    customUrl: item.snippet.customUrl ?? null,
    madeForKids: item.status?.madeForKids ?? null,
  };
}

export async function fetchChannelById(channelId: string): Promise<ChannelMetadata | null> {
  if (!isValidYoutubeChannelId(channelId) || !features.youtubeDataApi) return null;
  type Response = {
    items?: {
      id: string;
      snippet: { title: string; customUrl?: string; thumbnails?: Record<string, { url: string }> };
      statistics?: { subscriberCount?: string };
      status?: { madeForKids?: boolean };
    }[];
  };
  const data = await apiGet<Response>("channels", { part: "snippet,statistics,status", id: channelId }, {});
  const item = data.items?.[0];
  if (!item) return null;
  const thumbs = item.snippet.thumbnails ?? {};
  return {
    channelId: item.id,
    title: item.snippet.title,
    thumbnailUrl: thumbs.high?.url ?? thumbs.default?.url ?? null,
    subscriberCount: item.statistics?.subscriberCount ? Number(item.statistics.subscriberCount) : null,
    customUrl: item.snippet.customUrl ?? null,
    madeForKids: item.status?.madeForKids ?? null,
  };
}

/**
 * Result of asking YouTube a yes/no question about a user's action.
 *
 * The three outcomes are deliberately distinct, because collapsing them is how a
 * platform ends up either refusing a legitimate support during an outage or
 * paying for one it never verified:
 *
 *   VERIFIED          the API said yes.
 *   NOT_VERIFIED      the API said no. A real, final answer.
 *   TEMPORARY_ERROR   we could not ask (timeout, 5xx, quota). NOT a failure —
 *                     the task stays pending and the user may retry.
 *   REAUTH_REQUIRED   the grant is dead; only the user can fix it.
 *   UNAVAILABLE       we are not configured to ask at all.
 */
export type CheckOutcome = "VERIFIED" | "NOT_VERIFIED" | "TEMPORARY_ERROR" | "REAUTH_REQUIRED" | "UNAVAILABLE";

export type ApiCheck = {
  outcome: CheckOutcome;
  /** True only when the API was actually consulted and gave an answer. */
  available: boolean;
  satisfied: boolean;
  detail?: Record<string, unknown>;
};

/** Maps a failed token lookup onto a check outcome. */
function checkFromTokenFailure(result: Extract<TokenResult, { ok: false }>): ApiCheck {
  const outcome: CheckOutcome =
    result.state === "REAUTH_REQUIRED" || result.state === "EXPIRED"
      ? "REAUTH_REQUIRED"
      : result.retryable
        ? "TEMPORARY_ERROR"
        : "UNAVAILABLE";
  return { outcome, available: false, satisfied: false, detail: { reason: result.reason } };
}

/** Distinguishes a transient upstream problem from a definitive answer. */
function isTransientApiError(error: unknown): boolean {
  const message = internalMessage(error);
  if (/timed? ?out|abort|network|ECONNRESET|fetch failed/i.test(message)) return true;
  // 5xx and 429 are retryable; 403 quotaExceeded is too (it resets).
  if (/responded (5\d\d|429)/.test(message)) return true;
  if (/quotaExceeded|rateLimitExceeded|backendError|userRateLimitExceeded/i.test(message)) return true;
  return false;
}

/**
 * Is `userId` subscribed to `channelId`?
 *
 * A `TEMPORARY_ERROR` must never be recorded as "did not subscribe": that would
 * fail an honest supporter because Google had a bad minute.
 */
export async function checkSubscription(userId: string, channelId: string): Promise<ApiCheck> {
  const token = await getAccessToken(userId);
  if (!token.ok) return checkFromTokenFailure(token);

  try {
    type Response = { items?: { id: string }[]; pageInfo?: { totalResults: number } };
    await recordQuotaSpend(QUOTA_COST.subscriptionsList);
    const data = await apiGet<Response>(
      "subscriptions",
      { part: "snippet", forChannelId: channelId, mine: "true", maxResults: "1" },
      { accessToken: token.accessToken }
    );
    const satisfied = (data.items?.length ?? 0) > 0;
    return {
      outcome: satisfied ? "VERIFIED" : "NOT_VERIFIED",
      available: true,
      satisfied,
      detail: { totalResults: data.pageInfo?.totalResults ?? 0 },
    };
  } catch (e) {
    return await apiFailureToCheck(userId, e, { channelId });
  }
}

/**
 * Is `userId` subscribed to EACH of `channelIds`?
 *
 * THE ONE REAL BATCHING WIN AVAILABLE HERE
 * `subscriptions.list` accepts a comma-separated `forChannelId`, and the call
 * costs 1 quota unit no matter how many channels are listed. So a supporter with
 * six outstanding obligations is answered for 1 unit instead of 6.
 *
 * WHAT CANNOT BE BATCHED, STATED PLAINLY
 * Users. Every call is signed with that user's own OAuth token, so no request
 * shape answers for two people. The cost of compliance is therefore one unit per
 * user per TTL window — batching helps within a user and not across them, and any
 * capacity planning that assumes otherwise is wrong.
 *
 * FAILURE SEMANTICS
 * All-or-nothing. On failure the verdict applies to every channel asked about,
 * because a partial answer is indistinguishable from "subscribed to some": the
 * API returns only matches, so a missing tail looks identical whether the user is
 * not subscribed or the request died early. Marking a subset NOT_VERIFIED off a
 * failed call is precisely how an outage becomes a wave of false violations.
 *
 * `maxResults` follows the number of channels asked about rather than being
 * pinned at 1, since a truncated page would silently read as "not subscribed"
 * for everything past the cut.
 */
export async function checkSubscriptions(
  userId: string,
  channelIds: string[]
): Promise<{ outcome: CheckOutcome; available: boolean; subscribed: Set<string>; detail?: Record<string, unknown> }> {
  const unique = [...new Set(channelIds.filter(Boolean))];
  if (unique.length === 0) {
    return { outcome: "VERIFIED", available: true, subscribed: new Set() };
  }

  const token = await getAccessToken(userId);
  if (!token.ok) {
    const failure = checkFromTokenFailure(token);
    return { outcome: failure.outcome, available: false, subscribed: new Set(), detail: failure.detail };
  }

  try {
    type Response = {
      items?: { snippet?: { resourceId?: { channelId?: string } } }[];
      pageInfo?: { totalResults: number };
    };
    await recordQuotaSpend(QUOTA_COST.subscriptionsList);
    const data = await apiGet<Response>(
      "subscriptions",
      {
        part: "snippet",
        forChannelId: unique.join(","),
        mine: "true",
        maxResults: String(Math.min(50, Math.max(1, unique.length))),
      },
      { accessToken: token.accessToken }
    );

    // Built from the resource ids the API returned, intersected with what was
    // asked. An unexpected extra item therefore cannot mark an unrelated
    // obligation satisfied.
    const asked = new Set(unique);
    const subscribed = new Set<string>();
    for (const item of data.items ?? []) {
      const id = item.snippet?.resourceId?.channelId;
      if (id && asked.has(id)) subscribed.add(id);
    }

    return {
      outcome: "VERIFIED",
      available: true,
      subscribed,
      detail: { asked: unique.length, matched: subscribed.size, totalResults: data.pageInfo?.totalResults ?? 0 },
    };
  } catch (e) {
    const failure = await apiFailureToCheck(userId, e, { channels: unique.length });
    return { outcome: failure.outcome, available: false, subscribed: new Set(), detail: failure.detail };
  }
}

/**
 * Did `userId` like `videoId`?
 *
 * Reads the user's own "Liked videos" playlist (`LL`) filtered to this one video:
 * one item back means liked, zero means not. Costs 1 quota unit either way.
 *
 * The obvious call, `videos.getRating`, is NOT usable here. Google classifies it
 * as a write-adjacent rating endpoint, so it demands the full `youtube` /
 * `youtube.force-ssl` scope and answers a `youtube.readonly` grant with
 * `403 ACCESS_TOKEN_SCOPE_INSUFFICIENT`. That failure is indistinguishable from a
 * generic API error at the HTTP layer, which is exactly how an honest supporter
 * who really had liked the video ended up reading "لایک تأیید نشد" forever.
 *
 * Asking for the wider scope was the alternative and was rejected: `youtube`
 * grants the ability to rate, comment, subscribe and modify playlists on the
 * user's behalf. Read-only access to a list the user already owns is the smaller
 * ask for the same answer.
 *
 * Caveat worth knowing: `LL` reflects likes, so a user who has cleared or paused
 * their like history can be liking a video that is not in the list. That returns
 * NOT_VERIFIED, never a false VERIFIED, so the failure direction stays safe.
 */
export async function checkLike(userId: string, videoId: string): Promise<ApiCheck> {
  const token = await getAccessToken(userId);
  if (!token.ok) return checkFromTokenFailure(token);

  try {
    type Response = { items?: { contentDetails?: { videoId?: string } }[]; pageInfo?: { totalResults: number } };
    const data = await apiGet<Response>(
      "playlistItems",
      { part: "contentDetails", playlistId: "LL", videoId, maxResults: "1" },
      { accessToken: token.accessToken }
    );
    // The videoId filter is applied by the API, but confirm the returned item is
    // the video we asked about rather than trusting a non-empty list.
    const satisfied = (data.items ?? []).some((item) => item.contentDetails?.videoId === videoId);
    return {
      outcome: satisfied ? "VERIFIED" : "NOT_VERIFIED",
      available: true,
      satisfied,
      detail: { source: "LIKED_PLAYLIST", matched: satisfied },
    };
  } catch (e) {
    return await apiFailureToCheck(userId, e, { videoId });
  }
}

/**
 * Classifies an API exception. A 401 on a call we made with a fresh token means
 * the grant died between refresh and use, so the connection is parked rather than
 * retried forever.
 */
async function apiFailureToCheck(userId: string, error: unknown, context: Record<string, unknown>): Promise<ApiCheck> {
  const message = internalMessage(error);

  if (/responded 401/.test(message)) {
    await markConnectionState(userId, "REAUTH_REQUIRED", "API_401");
    logger.warn("youtube API rejected a fresh token", { userId, ...context });
    return { outcome: "REAUTH_REQUIRED", available: false, satisfied: false, detail: { reason: "UNAUTHORIZED" } };
  }

  // A grant that cannot answer this particular question is still valid for the
  // others, so the connection is left alone — parking it would break the
  // subscribe check too. What matters is not reporting this as "task not done":
  // that is the shape the getRating bug took, where an honest like read as a
  // failure and no amount of re-checking could ever clear it.
  if (/insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes/i.test(message)) {
    logger.warn("youtube grant lacks the scope for this check", { userId, ...context });
    return { outcome: "REAUTH_REQUIRED", available: false, satisfied: false, detail: { reason: "SCOPE_INSUFFICIENT" } };
  }

  if (isTransientApiError(error)) {
    logger.warn("youtube API transient failure", { userId, ...context, error: message.slice(0, 200) });
    return { outcome: "TEMPORARY_ERROR", available: false, satisfied: false, detail: { reason: "TEMPORARY_ERROR" } };
  }

  logger.warn("youtube API check failed", { userId, ...context, error: message.slice(0, 200) });
  return { outcome: "UNAVAILABLE", available: false, satisfied: false, detail: { reason: "API_ERROR" } };
}

/**
 * Looks for a top-level comment on `videoId` authored by `channelId`.
 * Public data, so it works with an API key alone; without a linked channel we
 * cannot attribute authorship and the task stays SELF_REPORTED.
 */
export async function checkComment(videoId: string, channelId: string | null): Promise<ApiCheck> {
  if (!channelId) {
    return { outcome: "UNAVAILABLE", available: false, satisfied: false, detail: { reason: "NO_LINKED_CHANNEL" } };
  }
  if (!features.youtubeDataApi) {
    return { outcome: "UNAVAILABLE", available: false, satisfied: false, detail: { reason: "NO_API_KEY" } };
  }

  try {
    type Response = {
      items?: { snippet: { topLevelComment: { snippet: { authorChannelId?: { value: string } } } } }[];
    };
    const data = await apiGet<Response>(
      "commentThreads",
      { part: "snippet", videoId, maxResults: "100", order: "time" },
      {}
    );
    const satisfied = (data.items ?? []).some(
      (item) => item.snippet.topLevelComment.snippet.authorChannelId?.value === channelId
    );
    return {
      outcome: satisfied ? "VERIFIED" : "NOT_VERIFIED",
      available: true,
      satisfied,
      detail: { scanned: data.items?.length ?? 0 },
    };
  } catch (e) {
    const transient = isTransientApiError(e);
    logger.warn("comment check failed", { videoId, error: internalMessage(e).slice(0, 200) });
    return {
      outcome: transient ? "TEMPORARY_ERROR" : "UNAVAILABLE",
      available: false,
      satisfied: false,
      detail: { reason: transient ? "TEMPORARY_ERROR" : "API_ERROR" },
    };
  }
}

export async function hasOAuthGrant(userId: string): Promise<boolean> {
  const { state } = await youtubeConnectionState(userId);
  return state === "CONNECTED";
}

import "server-only";
import type { YoutubeConnectionState } from "@prisma/client";
import { prisma } from "../prisma";
import { env, features } from "../env";
import { logger } from "../logger";
import { UpstreamError, internalMessage } from "../errors";
import { encryptSecret, decryptSecret } from "../crypto";
import { parseIsoDuration, isValidYoutubeChannelId, isValidYoutubeVideoId } from "../youtube";

/**
 * YouTube integration.
 *
 * What is actually verifiable, and how — this honesty is a product requirement,
 * not a caveat:
 *
 *  SUBSCRIBE  → verifiable server-side via subscriptions.list with the user's
 *               OAuth grant (youtube.readonly). Result: YOUTUBE_API.
 *  LIKE       → verifiable server-side via videos.getRating with the user's
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
  lastErrorCode: string | null;
}> {
  const account = await prisma.youtubeAccount.findUnique({
    where: { userId },
    select: { state: true, channelId: true, revokedAt: true, lastErrorCode: true },
  });
  if (!account) return { state: "DISCONNECTED", channelId: null, lastErrorCode: null };
  return {
    state: account.revokedAt && account.state === "CONNECTED" ? "DISCONNECTED" : account.state,
    channelId: account.channelId,
    lastErrorCode: account.lastErrorCode,
  };
}

export async function storeOAuthGrant(input: {
  userId: string;
  googleSub: string;
  tokens: TokenResponse;
  channelId?: string | null;
}) {
  const data = {
    googleSub: input.googleSub,
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
      status: { embeddable: boolean; privacyStatus: string };
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
  };
}

export type ChannelMetadata = {
  channelId: string;
  title: string;
  thumbnailUrl: string | null;
  subscriberCount: number | null;
  customUrl: string | null;
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
    }[];
  };

  const data = await apiGet<Response>(
    "channels",
    { part: "snippet,statistics", mine: "true" },
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
  };
}

export async function fetchChannelById(channelId: string): Promise<ChannelMetadata | null> {
  if (!isValidYoutubeChannelId(channelId) || !features.youtubeDataApi) return null;
  type Response = {
    items?: {
      id: string;
      snippet: { title: string; customUrl?: string; thumbnails?: Record<string, { url: string }> };
      statistics?: { subscriberCount?: string };
    }[];
  };
  const data = await apiGet<Response>("channels", { part: "snippet,statistics", id: channelId }, {});
  const item = data.items?.[0];
  if (!item) return null;
  const thumbs = item.snippet.thumbnails ?? {};
  return {
    channelId: item.id,
    title: item.snippet.title,
    thumbnailUrl: thumbs.high?.url ?? thumbs.default?.url ?? null,
    subscriberCount: item.statistics?.subscriberCount ? Number(item.statistics.subscriberCount) : null,
    customUrl: item.snippet.customUrl ?? null,
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

/** Did `userId` like `videoId`? Uses videos.getRating on the user's own grant. */
export async function checkLike(userId: string, videoId: string): Promise<ApiCheck> {
  const token = await getAccessToken(userId);
  if (!token.ok) return checkFromTokenFailure(token);

  try {
    type Response = { items?: { videoId: string; rating: string }[] };
    const data = await apiGet<Response>("videos/getRating", { id: videoId }, { accessToken: token.accessToken });
    const rating = data.items?.[0]?.rating ?? "none";
    const satisfied = rating === "like";
    return { outcome: satisfied ? "VERIFIED" : "NOT_VERIFIED", available: true, satisfied, detail: { rating } };
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

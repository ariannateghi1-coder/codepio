import "server-only";
import { prisma } from "./prisma";
import { env, features } from "./env";
import { logger } from "./logger";
import { RateLimitError } from "./errors";

/**
 * Rate limiting with two interchangeable backends.
 *
 * Redis (Upstash) is used when configured: a single INCR + conditional EXPIRE is
 * atomic, needs no cleanup, and survives horizontal scaling. Otherwise we fall
 * back to Postgres with a single INSERT ... ON CONFLICT DO UPDATE, which is also
 * atomic (the row lock is held by the upsert) — the read-then-write version this
 * replaced allowed two concurrent requests to both see count=9 and both pass.
 */

export type RateLimitResult = {
  ok: boolean;
  limit: number;
  remaining: number;
  resetAt: Date;
};

/** Named policies, so limits live in one place instead of scattered magic numbers. */
export const RATE_LIMITS = {
  login: { limit: 8, windowSeconds: 900 },
  register: { limit: 5, windowSeconds: 3600 },
  forgotPassword: { limit: 5, windowSeconds: 3600 },
  resetPassword: { limit: 10, windowSeconds: 3600 },
  changePassword: { limit: 5, windowSeconds: 900 },
  emailVerification: { limit: 5, windowSeconds: 3600 },
  supportStart: { limit: 40, windowSeconds: 3600 },
  supportHeartbeat: { limit: 600, windowSeconds: 3600 },
  supportComplete: { limit: 40, windowSeconds: 3600 },
  campaignWrite: { limit: 30, windowSeconds: 3600 },
  videoWrite: { limit: 30, windowSeconds: 3600 },
  report: { limit: 10, windowSeconds: 3600 },
  pushSubscribe: { limit: 20, windowSeconds: 3600 },
  notificationWrite: { limit: 120, windowSeconds: 3600 },
  realtimeToken: { limit: 60, windowSeconds: 3600 },
  publicSearch: { limit: 120, windowSeconds: 300 },
  explore: { limit: 300, windowSeconds: 300 },
  adminMutation: { limit: 200, windowSeconds: 3600 },
  youtubeOAuth: { limit: 10, windowSeconds: 3600 },
} as const;

export type RateLimitPolicy = keyof typeof RATE_LIMITS;

async function redisRateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult | null> {
  const base = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !token) return null;

  try {
    // Pipeline: INCR then (only meaningful on first hit) set the TTL, then read
    // the remaining TTL so callers can report an accurate reset time.
    const res = await fetch(`${base}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify([
        ["INCR", key],
        ["EXPIRE", key, String(windowSeconds), "NX"],
        ["TTL", key],
      ]),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Upstash HTTP ${res.status}`);
    const payload = (await res.json()) as { result: number }[];
    const count = Number(payload[0]?.result ?? 0);
    const ttl = Number(payload[2]?.result ?? windowSeconds);
    const resetAt = new Date(Date.now() + Math.max(ttl, 1) * 1000);
    return { ok: count <= limit, limit, remaining: Math.max(0, limit - count), resetAt };
  } catch (e) {
    // Never let the limiter's own outage break the request path; fall through to
    // Postgres instead of failing open silently.
    logger.warn("redis rate limit unavailable, falling back to postgres", { error: e });
    return null;
  }
}

async function postgresRateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  const now = new Date();
  const nextExpiry = new Date(now.getTime() + windowSeconds * 1000);

  const rows = await prisma.$queryRaw<{ count: number; expiresAt: Date }[]>`
    INSERT INTO "RateLimit" ("key", "count", "expiresAt", "updatedAt")
    VALUES (${key}, 1, ${nextExpiry}, ${now})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "RateLimit"."expiresAt" < ${now} THEN 1 ELSE "RateLimit"."count" + 1 END,
      "expiresAt" = CASE WHEN "RateLimit"."expiresAt" < ${now} THEN ${nextExpiry} ELSE "RateLimit"."expiresAt" END,
      "updatedAt" = ${now}
    RETURNING "count", "expiresAt";
  `;

  const row = rows[0];
  if (!row) return { ok: true, limit, remaining: limit - 1, resetAt: nextExpiry };
  return {
    ok: Number(row.count) <= limit,
    limit,
    remaining: Math.max(0, limit - Number(row.count)),
    resetAt: row.expiresAt,
  };
}

export async function rateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  if (features.redisRateLimit) {
    const result = await redisRateLimit(key, limit, windowSeconds);
    if (result) return result;
  }
  return postgresRateLimit(key, limit, windowSeconds);
}

/**
 * Applies a named policy and throws RateLimitError when exceeded, so routes
 * don't each re-implement the 429 response.
 */
export async function enforceRateLimit(policy: RateLimitPolicy, identity: string): Promise<RateLimitResult> {
  const { limit, windowSeconds } = RATE_LIMITS[policy];
  const result = await rateLimit(`${policy}:${identity}`, limit, windowSeconds);
  if (!result.ok) {
    const retryAfter = Math.max(1, Math.ceil((result.resetAt.getTime() - Date.now()) / 1000));
    throw new RateLimitError(retryAfter);
  }
  return result;
}

/** Removes expired counters. Called by the maintenance endpoint/cron. */
export async function purgeExpiredRateLimits() {
  const { count } = await prisma.rateLimit.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return count;
}

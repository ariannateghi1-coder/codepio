/**
 * Environment contract — single source of truth, validated once at import time.
 *
 * Rules encoded here:
 *  - Secrets are server-only. Anything the browser needs is NEXT_PUBLIC_*.
 *  - Development gets working defaults so `npm run dev` needs zero setup.
 *  - Production gets NO secret defaults: a missing/weak secret is a startup
 *    failure, not a silently insecure app (fail-fast).
 */
import { z } from "zod";

const isProd = process.env.NODE_ENV === "production";

/** In production a value must be explicitly provided; in dev/test we fall back. */
function devDefault<T extends z.ZodTypeAny>(schema: T, fallback: z.input<T>) {
  return isProd ? schema : schema.default(fallback as never);
}

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  DATABASE_URL: devDefault(
    z.string().url(),
    "postgresql://postgres:postgres@localhost:5432/academy_support"
  ),

  /** Used to derive the AES key that encrypts stored OAuth tokens. */
  SESSION_SECRET: devDefault(
    z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
    "development-session-secret-change-me-32chars"
  ),

  NEXT_PUBLIC_APP_URL: devDefault(z.string().url(), "http://localhost:3000"),

  /**
   * Number of proxy hops we trust in x-forwarded-for. 0 = trust nothing and use
   * the socket address. Netlify/Vercel put the real client IP as the LAST entry
   * they append, so blindly taking xff[0] is spoofable — see src/lib/http.ts.
   */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(isProd ? 1 : 0),

  // ---- Realtime (optional; app degrades to DB polling) ----
  ABLY_API_KEY: z.string().optional(),

  // ---- Rate limiting (optional; falls back to Postgres) ----
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),

  // ---- Web Push (optional) ----
  VAPID_PUBLIC_KEY: z.string().optional(),
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default("mailto:admin@academy-support.example"),

  /**
   * Bearer secret for the scheduled maintenance endpoint. When unset, a value is
   * derived from SESSION_SECRET so the endpoint is never open — but SESSION_SECRET
   * itself is never accepted directly, because a cron configuration is far more
   * widely shared than the signing secret.
   */
  MAINTENANCE_SECRET: z.string().min(24).optional(),

  // ---- Google / YouTube OAuth + Data API ----
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  YOUTUBE_API_KEY: z.string().optional(),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default(isProd ? "info" : "debug"),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const detail = parsed.error.issues
    .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
  throw new Error(`Invalid environment configuration:\n${detail}`);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";

/** Feature availability, derived once so call sites never re-check raw env. */
export const features = {
  realtime: Boolean(env.ABLY_API_KEY),
  redisRateLimit: Boolean(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN),
  webPush: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY),
  youtubeOAuth: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
  youtubeDataApi: Boolean(env.YOUTUBE_API_KEY),
} as const;

/**
 * Production readiness report. Surfaced by /api/v1/health and logged at boot so
 * a half-configured deployment is visible instead of silently degrading — e.g.
 * "password reset works" is a lie if no email provider is configured.
 */
export function productionReadiness() {
  const missing: string[] = [];
  if (!features.youtubeDataApi) missing.push("YOUTUBE_API_KEY (video metadata cannot be validated)");
  if (!features.youtubeOAuth) missing.push("GOOGLE_CLIENT_ID/SECRET (subscribe & like cannot be API-verified)");
  if (!features.redisRateLimit) missing.push("UPSTASH_REDIS_REST_URL/TOKEN (rate limiting falls back to Postgres)");
  if (!features.webPush) missing.push("VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY (web push disabled)");
  if (!features.realtime) missing.push("ABLY_API_KEY (realtime notifications disabled)");
  return { ready: missing.length === 0, missing };
}

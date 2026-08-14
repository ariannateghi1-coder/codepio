import "server-only";
import { prisma } from "../prisma";
import { env } from "../env";
import { logger } from "../logger";

/**
 * YouTube Data API quota accounting.
 *
 * WHY THIS EXISTS
 * The Data API's default allowance is 10,000 units per project per day, reset at
 * midnight Pacific. Exceeding it does not degrade gracefully: every subsequent
 * call returns 403 quotaExceeded for the rest of the day, which would take down
 * subscribe verification, like verification and video metadata validation all at
 * once. Compliance checking adds a recurring background cost on top of the
 * interactive one, so the spend has to be measured rather than hoped about.
 *
 * WHY IT REUSES THE RateLimit TABLE
 * A counter keyed by string with an expiry is exactly what `RateLimit` already
 * is, and its INSERT ... ON CONFLICT DO UPDATE is atomic, so two concurrent
 * requests cannot both read the same count and both pass. Adding a second table
 * with the same shape and weaker guarantees would be strictly worse. The
 * maintenance job already purges expired rows, so this needs no cleanup of its
 * own.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * It does not block interactive verification. Refusing to check a subscription
 * during a live support would either fail an honest supporter or hand out a
 * reward unverified, both worse than spending the unit. Only the discretionary
 * background sweep yields to the budget — see `hasSweepBudget`.
 *
 * ACCURACY, STATED HONESTLY
 * This is our own tally of calls we chose to make, not Google's ledger. It will
 * drift: another process sharing the API key, or a call made outside these
 * helpers, is invisible here. That is acceptable because the number is used to
 * decide whether to skip optional work, never to assert that quota remains. The
 * authoritative signal is still a 403 from Google, which the callers already
 * treat as a temporary error rather than a verification failure.
 */

/** Cost in quota units of the calls this service makes. */
export const QUOTA_COST = {
  /** subscriptions.list — 1 unit regardless of how many channels are filtered. */
  subscriptionsList: 1,
} as const;

/**
 * Quota day boundary, in the API's own timezone.
 *
 * Google resets at midnight Pacific, so a UTC day would reset the counter at
 * 16:00 or 17:00 Pacific and let a burst late in Google's day spend twice the
 * allowance. `en-CA` yields YYYY-MM-DD directly.
 */
function quotaDayKey(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function counterKey(now = new Date()): string {
  return `youtube-quota:${quotaDayKey(now)}`;
}

/**
 * Records `units` of spend and returns the running total for the quota day.
 *
 * Never throws: a failure to record spend must not fail the operation that spent
 * it. A lost increment makes the tally optimistic, which the caller's 403
 * handling already covers.
 */
export async function recordQuotaSpend(units = QUOTA_COST.subscriptionsList): Promise<number> {
  if (units <= 0) return 0;
  const now = new Date();
  // Expires a little after the Pacific day ends, so the row is purged by
  // maintenance rather than lingering, and a same-day read always finds it.
  const expiresAt = new Date(now.getTime() + 36 * 3_600_000);

  try {
    const rows = await prisma.$queryRaw<{ count: number }[]>`
      INSERT INTO public."RateLimit" ("key", "count", "expiresAt", "updatedAt")
      VALUES (${counterKey(now)}, ${units}, ${expiresAt}, ${now})
      ON CONFLICT ("key") DO UPDATE SET
        "count" = "RateLimit"."count" + ${units},
        "updatedAt" = ${now}
      RETURNING "count";
    `;
    return Number(rows[0]?.count ?? units);
  } catch (e) {
    logger.warn("could not record youtube quota spend", { units, error: e });
    return 0;
  }
}

/** Units spent so far today, by our own reckoning. */
export async function quotaSpentToday(): Promise<number> {
  try {
    const row = await prisma.rateLimit.findUnique({
      where: { key: counterKey() },
      select: { count: true },
    });
    return Number(row?.count ?? 0);
  } catch (e) {
    logger.warn("could not read youtube quota counter", { error: e });
    return 0;
  }
}

export type QuotaStatus = {
  spent: number;
  dailyLimit: number;
  remaining: number;
  /** Fraction of the daily limit consumed, 0..1+. */
  used: number;
};

export async function quotaStatus(): Promise<QuotaStatus> {
  const dailyLimit = env.YOUTUBE_DAILY_QUOTA;
  const spent = await quotaSpentToday();
  return {
    spent,
    dailyLimit,
    remaining: Math.max(0, dailyLimit - spent),
    used: dailyLimit > 0 ? spent / dailyLimit : 1,
  };
}

/**
 * May the background compliance sweep spend `units` right now?
 *
 * Applies only to discretionary work. Interactive checks never consult this: a
 * user starting a support or pressing «بررسی مجدد» is answered even when the
 * sweep has been paused, because the alternative is blocking a legitimate action
 * over a budget that exists to protect exactly that action.
 */
export async function hasSweepBudget(
  fraction: number,
  units = QUOTA_COST.subscriptionsList
): Promise<{ allowed: boolean; status: QuotaStatus; ceiling: number }> {
  const status = await quotaStatus();
  const ceiling = Math.floor(status.dailyLimit * Math.min(1, Math.max(0, fraction)));
  return { allowed: status.spent + units <= ceiling, status, ceiling };
}

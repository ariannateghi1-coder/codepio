import { ok, route } from "@/lib/api";
import { env } from "@/lib/env";
import { derivedSecret, safeEqualHashed } from "@/lib/crypto";
import { UnauthorizedError } from "@/lib/errors";
import { purgeExpiredSessions } from "@/lib/security";
import { purgeExpiredRateLimits } from "@/lib/rate-limit";
import { expireStaleSessions } from "@/lib/services/support";
import { snapshotLeaderboard } from "@/lib/services/leaderboard";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";

/**
 * Scheduled maintenance endpoint (Netlify scheduled function / external cron).
 *
 * Authenticated with a bearer secret compared in constant time — it is not a user
 * session, so it must not rely on cookies, and the comparison hashes both sides so
 * the secret's length does not leak either.
 *
 * The credential is MAINTENANCE_SECRET, or a value derived from SESSION_SECRET
 * when that is unset. SESSION_SECRET is deliberately NOT accepted directly: a cron
 * secret ends up in scheduler configuration, CI variables and logs, and handing out
 * the session-signing secret for that purpose would let a leak there compromise
 * every stored OAuth token.
 */
export const POST = route("maintenance.run", async (req) => {
  const expected = env.MAINTENANCE_SECRET ?? derivedSecret("maintenance-endpoint");
  const provided = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!provided || !safeEqualHashed(provided, expected)) throw new UnauthorizedError("دسترسی مجاز نیست.");

  const [sessions, rateLimits, staleSupport, tokens] = await Promise.all([
    purgeExpiredSessions(),
    purgeExpiredRateLimits(),
    expireStaleSessions(),
    prisma.$transaction([
      prisma.passwordResetToken.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 86_400_000) } } }),
      prisma.emailVerificationToken.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 7 * 86_400_000) } } }),
    ]),
  ]);

  const snapshots = await Promise.all([
    snapshotLeaderboard("WEEKLY", "TOP_SUPPORTERS"),
    snapshotLeaderboard("WEEKLY", "TOP_CREATORS"),
    snapshotLeaderboard("MONTHLY", "TOP_SUPPORTERS"),
  ]);

  const result = {
    purgedSessions: sessions,
    purgedRateLimits: rateLimits,
    closedSupportSessions: staleSupport,
    purgedTokens: tokens.reduce((sum, r) => sum + r.count, 0),
    leaderboardRows: snapshots.reduce((a, b) => a + b, 0),
  };

  logger.info("maintenance completed", result);
  return ok(result);
});

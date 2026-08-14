import { ok, parseQuery, route } from "@/lib/api";
import { env } from "@/lib/env";
import { derivedSecret, safeEqualHashed } from "@/lib/crypto";
import { UnauthorizedError } from "@/lib/errors";
import { purgeExpiredSessions } from "@/lib/security";
import { purgeExpiredRateLimits } from "@/lib/rate-limit";
import { expireStaleSessions } from "@/lib/services/support";
import { runComplianceSweep } from "@/lib/services/subscription-compliance";
import { snapshotLeaderboard } from "@/lib/services/leaderboard";
import { runRetention } from "@/lib/services/retention";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { z } from "zod";

/**
 * Scheduled maintenance endpoint (Netlify scheduled function / external cron / a
 * VPS cron calling curl — the transport is deliberately irrelevant).
 *
 * Authenticated with a bearer secret compared in constant time — it is not a user
 * session, so it must not rely on cookies, and the comparison hashes both sides so
 * the secret's length does not leak either. No user role can reach this: there is
 * no session lookup at all, so being an admin is neither sufficient nor relevant.
 *
 * The credential is MAINTENANCE_SECRET, or a value derived from SESSION_SECRET
 * when that is unset. SESSION_SECRET is deliberately NOT accepted directly: a cron
 * secret ends up in scheduler configuration, CI variables and logs, and handing out
 * the session-signing secret for that purpose would let a leak there compromise
 * every stored OAuth token.
 *
 * Query parameters (all optional) tune the retention pass:
 *   ?dryRun=1              report what would be deleted, delete nothing
 *   ?batchSize=500         rows per DELETE statement
 *   ?maxBatches=50         per-table batch cap for this run
 *
 * They are validated rather than trusted: an unbounded batchSize from a query
 * string would defeat the point of batching.
 */
const maintenanceQuerySchema = z.object({
  dryRun: z
    .enum(["0", "1", "true", "false"])
    .optional()
    .transform((value) => value === "1" || value === "true"),
  batchSize: z.coerce.number().int().min(1).max(10_000).optional(),
  maxBatches: z.coerce.number().int().min(1).max(1_000).optional(),
});

export const POST = route("maintenance.run", async (req) => {
  const expected = env.MAINTENANCE_SECRET ?? derivedSecret("maintenance-endpoint");
  const provided = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!provided || !safeEqualHashed(provided, expected)) throw new UnauthorizedError("دسترسی مجاز نیست.");

  const options = parseQuery(new URL(req.url), maintenanceQuerySchema);

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

  // Subscription compliance sweep. Runs sequentially and AFTER the cleanup above
  // for two reasons: it is the only step that talks to an external provider, so it
  // must not delay local cleanup if YouTube is slow; and it is self-limiting (a
  // hard user cap per run plus a quota ceiling), so a large backlog drains over
  // several runs instead of in one burst.
  //
  // A dry run skips it: there is no read-only version of "ask YouTube", and
  // spending quota during a dry run would contradict the flag's whole purpose.
  const compliance = options.dryRun ? null : await runComplianceSweep();

  // Retention runs LAST and sequentially, after the snapshots above. Order matters:
  // snapshotLeaderboard() reads period aggregates, and running it after a large
  // delete pass would have it compete for I/O with the cleanup for no benefit.
  //
  // It is also the only step that can legitimately run out of budget, so putting it
  // last means a capped retention pass never starves session/token cleanup.
  const retention = await runRetention({
    batchSize: options.batchSize,
    maxBatchesPerTable: options.maxBatches,
    dryRun: options.dryRun,
  });

  const result = {
    purgedSessions: sessions,
    purgedRateLimits: rateLimits,
    closedSupportSessions: staleSupport,
    purgedTokens: tokens.reduce((sum, r) => sum + r.count, 0),
    leaderboardRows: snapshots.reduce((a, b) => a + b, 0),
    compliance,
    retention,
  };

  logger.info("maintenance completed", {
    ...result,
    // The full per-table array is already logged by runRetention; keep this line
    // scannable.
    retention: { totalDeleted: retention.totalDeleted, hadErrors: retention.hadErrors },
  });
  return ok(result);
});

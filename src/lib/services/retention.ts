import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { logger } from "../logger";

/**
 * Data retention and cleanup.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 * At the target scale — 1,000 active users × ~1,000 supports each per month —
 * one month produces roughly:
 *
 *   Support               1,000,000 rows   PERMANENT (the outcome record)
 *   CreditLedger          1,000,000 rows   PERMANENT (the accounting record)
 *   SupportSession        1,000,000 rows   permanent, but its children are not
 *   SupportTask         2–4,000,000 rows   temporary execution state
 *   SupportVerification 2–4,000,000 rows   temporary execution state
 *   WatchSession          1,000,000 rows   temporary execution state
 *   XpLedger            2–3,000,000 rows   detail trail, aggregated permanently
 *   Activity              2,000,000 rows   display-only feed
 *   Notification          1,000,000 rows   display-only
 *   AbuseSignal              variable      reviewable evidence
 *   AuditLog                 variable      operational trail
 *
 * The permanent tables stay. Everything below them is either temporary execution
 * state whose conclusion has already been copied somewhere permanent, or a
 * short-lived display/audit trail.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT RETENTION NEVER DELETES
 * ═══════════════════════════════════════════════════════════════════════════
 *   User, Campaign, Support, CreditLedger, UserDailyRollup, ReputationEvent,
 *   LeaderboardSnapshot, Badge, UserBadge, Referral, Report, Video,
 *   SupportSession itself, and every cached balance on User
 *   (credits / points / level / reputation / trustScore).
 *
 * Three of these deserve a note:
 *
 *   CreditLedger      is the audit trail for money. Deleting any of it would make
 *                     User.credits unverifiable, so it is excluded on principle,
 *                     not on size. At ~1M rows/month it is the largest permanent
 *                     table; if it ever needs managing, the answer is partitioning
 *                     or archival to cold storage, never deletion.
 *
 *   ReputationEvent   looks like a history table but is not pruned: unlike XP there
 *                     is no aggregate that could reconstruct it, and reputation
 *                     drives Explore exposure and rank tier. Its write rate is also
 *                     far lower — one per settlement, not one per reward component.
 *
 *   SupportSession    is kept because Support.sessionId-style joins and the
 *                     moderation queue read it, and because it is the row that
 *                     proves a support had a real session. Only its CHILDREN are
 *                     temporary.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PRECONDITION FOR DELETING EXECUTION STATE
 * ═══════════════════════════════════════════════════════════════════════════
 * WatchSession, SupportVerification and SupportTask are removed only once the
 * owning SupportSession is terminal, settled, and has been so for a grace period.
 * This is safe because settlement copies the conclusions onto the permanent
 * Support row — watchedSec, requiredWatchSec, riskScore and a compact per-task
 * verification summary (see services/support.ts). Nothing needs the detail rows to
 * determine whether a past support succeeded or why it was paid.
 *
 * A session still open, or held at PENDING_REVIEW awaiting a moderator, is never
 * touched regardless of age.
 */

/** Retention windows, in days. One place, so the policy reads at a glance. */
export const RETENTION_DAYS = {
  notification: 3,
  activity: 7,
  auditLog: 7,
  abuseSignal: 7,
  xpLedger: 7,
  /**
   * Grace period after a session becomes terminal before its execution state is
   * purged. Deliberately not zero: a supporter may still have the completion
   * screen open, and support staff commonly inspect a session the same day.
   */
  sessionExecutionState: 2,
} as const;

export type RetentionTable = keyof typeof RETENTION_DAYS;

/**
 * Rows deleted per statement. Bounded so a single DELETE never locks a large slice
 * of a hot table: at 1M+ rows, an unbounded `DELETE ... WHERE createdAt < cutoff`
 * would hold locks and generate WAL long enough to affect live requests.
 */
export const DEFAULT_BATCH_SIZE = 1_000;

/**
 * Safety valve per table per run. Without it, the first run against a large
 * backlog would loop until done, which on a serverless host means hitting the
 * function timeout mid-way. Reaching the cap is normal: it simply means the next
 * scheduled run continues. The operation is resumable by construction, because
 * "old enough to delete" does not change as rows disappear — there is no cursor to
 * lose.
 */
export const DEFAULT_MAX_BATCHES = 20;

export type RetentionOptions = {
  batchSize?: number;
  maxBatchesPerTable?: number;
  /** Overrides "now". Used by tests to age rows deterministically. */
  now?: Date;
  /** Reports what would be deleted, deleting nothing. */
  dryRun?: boolean;
};

export type TableResult = {
  table: string;
  deleted: number;
  batches: number;
  /** True when the per-run cap stopped us before the backlog was clear. */
  capped: boolean;
  /** Set when this table failed. Other tables still run. */
  error?: string;
};

export type RetentionResult = {
  startedAt: string;
  durationMs: number;
  dryRun: boolean;
  batchSize: number;
  totalDeleted: number;
  tables: TableResult[];
  /** True when at least one table errored. */
  hadErrors: boolean;
};

type ResolvedOptions = {
  batchSize: number;
  maxBatchesPerTable: number;
  dryRun: boolean;
};

/** A table's cleanup, expressed as two bounded operations. */
type BatchPlan = {
  table: string;
  /** Returns at most `take` ids that are currently eligible for deletion. */
  scan: (take: number) => Promise<string[]>;
  /** Deletes those ids, re-checking eligibility. Returns how many went. */
  remove: (ids: string[]) => Promise<number>;
};

const cutoff = (now: Date, days: number) => new Date(now.getTime() - days * 86_400_000);

/**
 * Runs one table's plan in bounded batches until nothing matches, the cap is hit,
 * or a batch fails.
 *
 * Each batch is its own statement, so an interrupted run leaves whole batches
 * committed and the remainder untouched — never a half-deleted batch.
 *
 * A failure is caught and reported rather than thrown: a lock timeout on Activity
 * is no reason to leave Notification unpruned, and the caller needs the partial
 * counts for its log line.
 */
async function runPlan(plan: BatchPlan, options: ResolvedOptions): Promise<TableResult> {
  let deleted = 0;
  let batches = 0;

  while (batches < options.maxBatchesPerTable) {
    let ids: string[];
    try {
      ids = await plan.scan(options.batchSize);
    } catch (error) {
      logger.error("retention scan failed", { table: plan.table, batches, deleted, error });
      return { table: plan.table, deleted, batches, capped: false, error: String(error) };
    }

    if (ids.length === 0) return { table: plan.table, deleted, batches, capped: false };

    if (options.dryRun) {
      // Counts one batch and stops. A dry run must not loop: nothing is removed, so
      // the same rows would be found forever.
      return { table: plan.table, deleted: ids.length, batches: 1, capped: ids.length === options.batchSize };
    }

    try {
      const count = await plan.remove(ids);
      deleted += count;
      batches += 1;
      // Deleted nothing despite finding candidates: another run took them, or they
      // stopped being eligible. Stop rather than spin.
      if (count === 0) return { table: plan.table, deleted, batches, capped: false };
    } catch (error) {
      logger.error("retention batch failed", { table: plan.table, batches, deleted, error });
      return { table: plan.table, deleted, batches, capped: false, error: String(error) };
    }
  }

  return { table: plan.table, deleted, batches, capped: true };
}

/* -------------------------------------------------------------------------- */
/* Per-table plans                                                            */
/*                                                                            */
/* Each is written against its concrete Prisma delegate rather than a generic  */
/* wrapper, so the `where` clauses are type-checked against the real schema —  */
/* the one thing in this file that must not be loosely typed.                  */
/* -------------------------------------------------------------------------- */

/**
 * Notification — 3 days.
 *
 * Unread state is deliberately not preserved past the window: a 3-day-old unread
 * notification is not actionable, and the unread badge is a COUNT over what
 * remains, so it corrects itself.
 */
function notificationPlan(now: Date): BatchPlan {
  const where: Prisma.NotificationWhereInput = {
    createdAt: { lt: cutoff(now, RETENTION_DAYS.notification) },
  };
  return {
    table: "Notification",
    scan: async (take) => {
      const rows = await prisma.notification.findMany({
        where,
        select: { id: true },
        // Oldest first: deterministic progress, and the batch stays on the
        // createdAt index.
        orderBy: { createdAt: "asc" },
        take,
      });
      return rows.map((row) => row.id);
    },
    // The age predicate is repeated on delete so a row cannot be removed on stale
    // grounds if it changed between scan and delete.
    remove: async (ids) =>
      (await prisma.notification.deleteMany({ where: { AND: [{ id: { in: ids } }, where] } })).count,
  };
}

/**
 * Activity — 7 days.
 *
 * Pure feed data. Confirmed by inspection that nothing reads it for business
 * logic: its only consumer is the dashboard's 8-row recent-activity list, and
 * every write happens alongside a permanent record (a Support row, a ledger entry,
 * a Campaign, a Video).
 */
function activityPlan(now: Date): BatchPlan {
  const where: Prisma.ActivityWhereInput = { createdAt: { lt: cutoff(now, RETENTION_DAYS.activity) } };
  return {
    table: "Activity",
    scan: async (take) => {
      const rows = await prisma.activity.findMany({
        where,
        select: { id: true },
        orderBy: { createdAt: "asc" },
        take,
      });
      return rows.map((row) => row.id);
    },
    remove: async (ids) =>
      (await prisma.activity.deleteMany({ where: { AND: [{ id: { in: ids } }, where] } })).count,
  };
}

/**
 * AuditLog — 7 days.
 *
 * Read only by the admin audit viewer and the per-user admin drawer, both of which
 * are human-facing logs rather than inputs to any automated decision. Nothing
 * financial depends on it: money is reconstructed from CreditLedger, which is
 * permanent.
 *
 * Note this is a product decision with a real trade-off — a security incident
 * older than a week cannot be reconstructed from the database. If that becomes
 * unacceptable, the answer is shipping these lines to a log sink, not extending
 * the window, because the table grows with every request that mutates anything.
 */
function auditLogPlan(now: Date): BatchPlan {
  const where: Prisma.AuditLogWhereInput = { createdAt: { lt: cutoff(now, RETENTION_DAYS.auditLog) } };
  return {
    table: "AuditLog",
    scan: async (take) => {
      const rows = await prisma.auditLog.findMany({
        where,
        select: { id: true },
        orderBy: { createdAt: "asc" },
        take,
      });
      return rows.map((row) => row.id);
    },
    remove: async (ids) =>
      (await prisma.auditLog.deleteMany({ where: { AND: [{ id: { in: ids } }, where] } })).count,
  };
}

/**
 * XpLedger — 7 days.
 *
 * Detail trail only. The permanent sources are User.points (current total) and
 * UserDailyRollup (per-day history). Verified that no balance, level, rank tier,
 * leaderboard period or dashboard trend reads this table any more.
 *
 * Reversal entries are pruned on the same schedule as the entries they reverse,
 * which is correct: both have already been folded into the same day's rollup and
 * into User.points.
 *
 * FOREIGN KEY behaviour, checked against the migration: `XpLedger.reversalOfId`
 * self-references with ON DELETE SET NULL, so deleting an original whose reversal
 * is still inside the window nulls the link rather than failing or cascading. That
 * is harmless — the unique index on `reversalOfId` permits multiple NULLs in
 * PostgreSQL, and the only reader of that column is reverseXp()'s double-reversal
 * guard, which looks it up by the ORIGINAL's id and therefore cannot be reached
 * once the original is gone. Reversing such a support instead goes through
 * compensateMissingXp(), which works from the permanent Support.xpAwarded.
 */
function xpLedgerPlan(now: Date): BatchPlan {
  const where: Prisma.XpLedgerWhereInput = { createdAt: { lt: cutoff(now, RETENTION_DAYS.xpLedger) } };
  return {
    table: "XpLedger",
    scan: async (take) => {
      const rows = await prisma.xpLedger.findMany({
        where,
        select: { id: true },
        orderBy: { createdAt: "asc" },
        take,
      });
      return rows.map((row) => row.id);
    },
    remove: async (ids) =>
      (await prisma.xpLedger.deleteMany({ where: { AND: [{ id: { in: ids } }, where] } })).count,
  };
}

/**
 * AbuseSignal — 7 days, EXCEPT while still needed for an open decision.
 *
 * A signal is kept regardless of age when either:
 *   • its session is not terminal — the decision has not been made yet; or
 *   • its session's reward is held at PENDING_REVIEW — a moderator is going to
 *     look at exactly this evidence.
 *
 * Account-level signals (no session) follow the plain age rule.
 *
 * The 30-day trust-score penalty is unaffected: severity is summed from
 * UserDailyRollup, which is permanent. Without that rollup this window would have
 * silently restored a flagged account's trust score after a week.
 */
function abuseSignalPlan(now: Date): BatchPlan {
  const where: Prisma.AbuseSignalWhereInput = {
    createdAt: { lt: cutoff(now, RETENTION_DAYS.abuseSignal) },
    OR: [
      { sessionId: null },
      {
        session: {
          state: { in: ["COMPLETED", "FAILED", "EXPIRED", "ABANDONED"] },
          rewardState: { not: "PENDING_REVIEW" },
        },
      },
    ],
  };
  return {
    table: "AbuseSignal",
    scan: async (take) => {
      const rows = await prisma.abuseSignal.findMany({
        where,
        select: { id: true },
        orderBy: { createdAt: "asc" },
        take,
      });
      return rows.map((row) => row.id);
    },
    remove: async (ids) =>
      (await prisma.abuseSignal.deleteMany({ where: { AND: [{ id: { in: ids } }, where] } })).count,
  };
}

/**
 * The gate every piece of session execution state must pass.
 *
 * Four conditions, each closing a specific way this could destroy something still
 * in use:
 *
 *   terminal state             the flow is over; no heartbeat or verify call can
 *                              still arrive for it
 *   not PENDING_REVIEW         a held reward awaits a human who needs the watch
 *                              figures and task results to decide
 *   updatedAt past the grace    someone may still be looking at it
 *   settled outcome recorded    a COMPLETED session must carry its Support row —
 *                              that is where the conclusion now lives
 *
 * The last condition is the important one. A COMPLETED session without `supportId`
 * would mean settlement did not finish, making its execution state the only
 * remaining evidence of what happened, so it is left alone.
 */
function settledSessionGate(now: Date): Prisma.SupportSessionWhereInput {
  return {
    state: { in: ["COMPLETED", "FAILED", "EXPIRED", "ABANDONED"] },
    rewardState: { not: "PENDING_REVIEW" },
    updatedAt: { lt: cutoff(now, RETENTION_DAYS.sessionExecutionState) },
    OR: [{ state: { not: "COMPLETED" } }, { supportId: { not: null } }],
  };
}

/** SupportVerification — purged once its session is terminal and settled. */
function supportVerificationPlan(now: Date): BatchPlan {
  const where: Prisma.SupportVerificationWhereInput = { session: settledSessionGate(now) };
  return {
    table: "SupportVerification",
    scan: async (take) => {
      const rows = await prisma.supportVerification.findMany({ where, select: { id: true }, take });
      return rows.map((row) => row.id);
    },
    remove: async (ids) =>
      (await prisma.supportVerification.deleteMany({ where: { AND: [{ id: { in: ids } }, where] } })).count,
  };
}

/** WatchSession — purged once its session is terminal and settled. */
function watchSessionPlan(now: Date): BatchPlan {
  const where: Prisma.WatchSessionWhereInput = { session: settledSessionGate(now) };
  return {
    table: "WatchSession",
    scan: async (take) => {
      const rows = await prisma.watchSession.findMany({ where, select: { id: true }, take });
      return rows.map((row) => row.id);
    },
    remove: async (ids) =>
      (await prisma.watchSession.deleteMany({ where: { AND: [{ id: { in: ids } }, where] } })).count,
  };
}

/**
 * SupportTask — purged once its session is terminal and settled.
 *
 * Included because it is the largest of the three (one row per task per session,
 * so 2–4× the session count) and carries no information the Support row lacks: the
 * per-task outcome is in Support.verification, and the pass/fail decision is
 * already reflected in whether a Support row exists at all.
 */
function supportTaskPlan(now: Date): BatchPlan {
  const where: Prisma.SupportTaskWhereInput = { session: settledSessionGate(now) };
  return {
    table: "SupportTask",
    scan: async (take) => {
      const rows = await prisma.supportTask.findMany({ where, select: { id: true }, take });
      return rows.map((row) => row.id);
    },
    remove: async (ids) =>
      (await prisma.supportTask.deleteMany({ where: { AND: [{ id: { in: ids } }, where] } })).count,
  };
}

/**
 * Runs every retention policy.
 *
 * Safe alongside live traffic and safe to re-run: it only deletes rows already
 * past their window, so a second run minutes later finds nothing new. Tables run
 * sequentially on purpose — parallel bulk deletes across six tables would multiply
 * the lock and I/O pressure this design exists to avoid.
 */
export async function runRetention(options: RetentionOptions = {}): Promise<RetentionResult> {
  const startedAt = new Date();
  const now = options.now ?? startedAt;
  const resolved: ResolvedOptions = {
    batchSize: Math.min(10_000, Math.max(1, Math.trunc(options.batchSize ?? DEFAULT_BATCH_SIZE))),
    maxBatchesPerTable: Math.min(1_000, Math.max(1, Math.trunc(options.maxBatchesPerTable ?? DEFAULT_MAX_BATCHES))),
    dryRun: options.dryRun ?? false,
  };

  // Order is not a correctness requirement — nothing here cascades, because
  // SupportSession is never deleted — but the display tables come first so that a
  // run which exhausts its budget has still done the work users notice, and the
  // execution-state tables (largest, least visible) come last.
  const plans: BatchPlan[] = [
    notificationPlan(now),
    activityPlan(now),
    auditLogPlan(now),
    xpLedgerPlan(now),
    abuseSignalPlan(now),
    supportVerificationPlan(now),
    supportTaskPlan(now),
    watchSessionPlan(now),
  ];

  const tables: TableResult[] = [];
  for (const plan of plans) {
    tables.push(await runPlan(plan, resolved));
  }

  const totalDeleted = tables.reduce((sum, row) => sum + row.deleted, 0);
  const hadErrors = tables.some((row) => row.error);

  const result: RetentionResult = {
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    dryRun: resolved.dryRun,
    batchSize: resolved.batchSize,
    totalDeleted,
    tables,
    hadErrors,
  };

  logger[hadErrors ? "warn" : "info"]("retention completed", {
    totalDeleted,
    dryRun: resolved.dryRun,
    durationMs: result.durationMs,
    perTable: Object.fromEntries(tables.map((row) => [row.table, row.deleted])),
    // Surfaced so an operator can tell "nothing left to do" from "ran out of
    // budget", which is the signal to raise batch size or run more often.
    capped: tables.filter((row) => row.capped).map((row) => row.table),
    errors: tables.filter((row) => row.error).map((row) => row.table),
  });

  return result;
}

/**
 * Pure policy predicates, exported so the rules can be tested without a database.
 *
 * These mirror the WHERE clauses above. They are not used by runRetention — the
 * queries have to filter in SQL — so a test asserting these is verifying the rule,
 * not the query. The database-backed tests in retention.test.ts cover the queries.
 */
export const retentionPolicy = {
  /** True when a row keyed only on age is past its window. */
  isExpired(table: RetentionTable, createdAt: Date, now = new Date()): boolean {
    return createdAt.getTime() < cutoff(now, RETENTION_DAYS[table]).getTime();
  },

  /** Mirrors abuseSignalPlan's gate. */
  canDeleteAbuseSignal(
    signal: { createdAt: Date; session: { state: string; rewardState: string } | null },
    now = new Date()
  ): boolean {
    if (!retentionPolicy.isExpired("abuseSignal", signal.createdAt, now)) return false;
    if (!signal.session) return true;
    const terminal = ["COMPLETED", "FAILED", "EXPIRED", "ABANDONED"].includes(signal.session.state);
    return terminal && signal.session.rewardState !== "PENDING_REVIEW";
  },

  /** Mirrors settledSessionGate. */
  canDeleteSessionExecutionState(
    session: { state: string; rewardState: string; updatedAt: Date; supportId: string | null },
    now = new Date()
  ): boolean {
    if (!["COMPLETED", "FAILED", "EXPIRED", "ABANDONED"].includes(session.state)) return false;
    if (session.rewardState === "PENDING_REVIEW") return false;
    if (session.updatedAt.getTime() >= cutoff(now, RETENTION_DAYS.sessionExecutionState).getTime()) return false;
    if (session.state === "COMPLETED" && !session.supportId) return false;
    return true;
  },
};

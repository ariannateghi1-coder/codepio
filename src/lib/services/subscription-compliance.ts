import "server-only";
import type { ComplianceStatus, Prisma, SubscriptionCompliance } from "@prisma/client";
import { prisma } from "../prisma";
import { logger } from "../logger";
import { COMPLIANCE_RULES } from "../gamification";
import { checkSubscriptions } from "./youtube-api";
import { hasSweepBudget } from "./youtube-quota";
import { persistAbuseSignals } from "./anti-abuse";
import { createNotificationTx, deliverNotification } from "./notifications";
import { writeAudit, writeAuditTx } from "../audit";
import { BusinessRuleError } from "../errors";

/**
 * Subscription compliance.
 *
 * THE RULE
 * Being paid to subscribe creates an obligation to stay subscribed. Unsubscribing
 * afterwards does not undo the payment — it suspends the ability to earn more
 * until the subscription is restored.
 *
 * WHAT A VIOLATION DOES AND DOES NOT TOUCH
 *   DOES      block starting any new support (option B: the whole flow, not only
 *             campaigns that happen to ask for a subscribe), block release of a
 *             reward still held at PENDING_REVIEW, and record an abuse signal.
 *   DOES NOT  alter CreditLedger, XpLedger, ReputationEvent, Support.status,
 *             Support.creditsAwarded, User.credits or User.points. Not one line in
 *             this file writes to any of them. Past supports keep their money and
 *             their history; that is the difference between a gate and a clawback,
 *             and it is why this feature does not reuse SupportStatus.REVERSED.
 *
 * NEVER PERMANENT
 * A violation is a state, not a punishment: re-subscribe, press «بررسی مجدد», and
 * access returns immediately. There is no cooldown, no penalty counter, and no
 * path from this file to a ban. The only lasting trace is the RESTORED status and
 * the abuse signal, which exist so a repeated subscribe/unsubscribe cycle is
 * visible to a moderator rather than invisible.
 *
 * WHY A TEMPORARY API FAILURE IS NOT A VIOLATION
 * `checkSubscriptions` returns a distinct outcome for "could not ask" versus "the
 * answer is no". Only a definitive NOT-subscribed verdict from a completed call
 * moves a row to VIOLATED. A timeout, a 5xx, a 403 quotaExceeded, a 429 or a dead
 * OAuth grant increments `checkFailureCount`, pushes `nextCheckAfter` out with
 * exponential backoff, and leaves the status untouched. Getting this backwards
 * would mean a Google outage mass-blocks honest users, which is a worse failure
 * than briefly missing a real violation.
 *
 * QUOTA
 * Reads are served from the cached verdict while it is inside the TTL, so page
 * loads and dashboard refreshes cost zero units no matter how often they happen.
 * A live call happens only when a sensitive operation finds the cache stale, when
 * the user explicitly asks, or when the background sweep picks the row up. Within
 * one user every outstanding obligation is answered by a single call.
 */

type Tx = Prisma.TransactionClient;

export const COMPLIANCE_MESSAGES = {
  BLOCKED:
    "برای ادامه فعالیت، باید اشتراک کانال‌هایی که بابت آن‌ها حمایت دریافت کرده‌اید را حفظ کنید. ابتدا دوباره کانال را سابسکرایب کنید و سپس بررسی مجدد را انجام دهید.",
  RESTORED: "اشتراک شما تأیید شد و دسترسی شما برگشت.",
  STILL_UNSUBSCRIBED: "برای ادامه فعالیت باید کانال موردنظر را سابسکرایب کنید.",
  CHECK_UNAVAILABLE: "فعلاً امکان بررسی وضعیت اشتراک وجود ندارد. لطفاً کمی بعد دوباره تلاش کنید.",
  REAUTH_REQUIRED:
    "دسترسی حساب یوتیوب شما منقضی یا لغو شده است. برای بررسی وضعیت اشتراک، حساب یوتیوب را دوباره متصل کنید.",
  NOTHING_TO_CHECK: "در حال حاضر هیچ اشتراک الزامی برای بررسی ندارید.",
} as const;

/** Raised when a support-dependent operation is refused for non-compliance. */
export class ComplianceBlockedError extends BusinessRuleError {
  readonly channels: string[];
  constructor(channels: string[]) {
    super(COMPLIANCE_MESSAGES.BLOCKED, { rule: "SUBSCRIPTION_COMPLIANCE_VIOLATED", details: { channels } });
    this.channels = channels;
  }
}

/** Compliance is satisfied by both of these — see the enum's note on RESTORED. */
const COMPLIANT: ComplianceStatus[] = ["ACTIVE", "RESTORED"];

function ttlCutoff(now = new Date()): Date {
  return new Date(now.getTime() - COMPLIANCE_RULES.verificationTtlMinutes * 60_000);
}

/** Is this row's stored verdict still authoritative? */
function isFresh(row: Pick<SubscriptionCompliance, "lastSubscriptionCheckAt">, now = new Date()): boolean {
  return Boolean(row.lastSubscriptionCheckAt && row.lastSubscriptionCheckAt > ttlCutoff(now));
}

/**
 * Backoff for a row whose check could not be completed.
 *
 * Capped, and jittered by up to a minute so a batch of rows that failed together
 * during one outage does not come back in a synchronized wave.
 */
function backoffUntil(failureCount: number, now = new Date()): Date {
  const minutes = Math.min(
    COMPLIANCE_RULES.backoffMaxMinutes,
    COMPLIANCE_RULES.backoffBaseMinutes * 2 ** Math.max(0, failureCount - 1)
  );
  return new Date(now.getTime() + minutes * 60_000 + Math.floor(Math.random() * 60_000));
}

/* ------------------------------------------------------------------------- */
/* Recording an obligation                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Records the obligation created by a settled support.
 *
 * Called INSIDE the settlement transaction, so an obligation can never be missing
 * for a support that was paid — and never exist for one that rolled back.
 *
 * Idempotent by the unique index on `supportId`: the replay path in
 * completeSupportSession re-runs this and upserts the same row rather than
 * creating a second obligation.
 *
 * `subscriptionVerified` is passed in from the verification results that were used
 * to decide the payout; it is never assumed. A campaign with no SUBSCRIBE_CHANNEL
 * task still gets a row, with `subscriptionRequired: false`, so "this support
 * carried no subscription obligation" is recorded rather than inferred from
 * absence.
 */
export async function recordComplianceObligation(
  tx: Tx,
  input: {
    userId: string;
    supportId: string;
    targetChannelId: string | null;
    subscriptionRequired: boolean;
    subscriptionVerified: boolean;
  }
): Promise<void> {
  // Without a channel id there is nothing to re-check later, so no obligation can
  // be enforced and none is claimed.
  if (!input.targetChannelId) return;

  const now = new Date();
  const verified = input.subscriptionRequired && input.subscriptionVerified;

  await tx.subscriptionCompliance.upsert({
    where: { supportId: input.supportId },
    create: {
      userId: input.userId,
      supportId: input.supportId,
      targetChannelId: input.targetChannelId,
      subscriptionRequired: input.subscriptionRequired,
      subscriptionVerified: verified,
      lastKnownSubscribed: verified,
      // Seeded from the settlement-time verification, which is a real API answer.
      // This is what stops a freshly created obligation from being re-checked
      // immediately and spending a unit to learn what was just confirmed.
      lastSubscriptionCheckAt: verified ? now : null,
      status: "ACTIVE",
    },
    // A replayed settlement must not resurrect a violation that a later check
    // found, so the update deliberately touches only the obligation's shape and
    // never `status`, `lastKnownSubscribed` or the violation timestamps.
    update: {
      targetChannelId: input.targetChannelId,
      subscriptionRequired: input.subscriptionRequired,
      ...(verified ? { subscriptionVerified: true } : {}),
    },
  });
}

/* ------------------------------------------------------------------------- */
/* Reading state (no API calls, ever)                                         */
/* ------------------------------------------------------------------------- */

export type ComplianceSnapshot = {
  compliant: boolean;
  status: "OK" | "VIOLATED" | "NO_OBLIGATIONS";
  /** Obligations currently in violation, for the UI's list. */
  violations: {
    supportId: string;
    channelId: string;
    detectedAt: string | null;
    lastCheckedAt: string | null;
  }[];
  totalObligations: number;
  /** Oldest verification among enforceable rows; drives «آخرین بررسی». */
  lastCheckedAt: string | null;
  /** True when a recheck would consult YouTube rather than reuse the cache. */
  stale: boolean;
  message: string | null;
};

/**
 * Current compliance state, read from the database ONLY.
 *
 * Explicitly makes no API call — this is what the dashboard, the support-flow
 * banner and any page render use, so refreshing a page a hundred times costs zero
 * quota. Requirement 8's "repeated page refresh must not spend quota" is enforced
 * here structurally, by there being no code path to the API in this function.
 */
export async function complianceSnapshot(userId: string): Promise<ComplianceSnapshot> {
  const rows = await prisma.subscriptionCompliance.findMany({
    where: { userId, subscriptionRequired: true, subscriptionVerified: true },
    select: {
      supportId: true,
      targetChannelId: true,
      status: true,
      violationDetectedAt: true,
      lastSubscriptionCheckAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  if (rows.length === 0) {
    return {
      compliant: true,
      status: "NO_OBLIGATIONS",
      violations: [],
      totalObligations: 0,
      lastCheckedAt: null,
      stale: false,
      message: null,
    };
  }

  const violated = rows.filter((row) => row.status === "VIOLATED");
  const checkedAts = rows
    .map((row) => row.lastSubscriptionCheckAt)
    .filter((value): value is Date => value instanceof Date);
  const oldest = checkedAts.length === rows.length ? new Date(Math.min(...checkedAts.map((d) => d.getTime()))) : null;

  return {
    compliant: violated.length === 0,
    status: violated.length > 0 ? "VIOLATED" : "OK",
    violations: violated.map((row) => ({
      supportId: row.supportId,
      channelId: row.targetChannelId,
      detectedAt: row.violationDetectedAt?.toISOString() ?? null,
      lastCheckedAt: row.lastSubscriptionCheckAt?.toISOString() ?? null,
    })),
    totalObligations: rows.length,
    lastCheckedAt: oldest?.toISOString() ?? null,
    stale: !oldest || oldest <= ttlCutoff(),
    message: violated.length > 0 ? COMPLIANCE_MESSAGES.BLOCKED : null,
  };
}

/* ------------------------------------------------------------------------- */
/* Verification                                                               */
/* ------------------------------------------------------------------------- */

export type VerifyReason = "SENSITIVE_OPERATION" | "USER_RECHECK" | "SWEEP";

export type VerifyOutcome = {
  /** True when no enforceable obligation is currently violated. */
  compliant: boolean;
  /** Did this call actually consult YouTube? */
  consultedApi: boolean;
  /** Set when the API was consulted and could not answer. */
  apiOutcome: "VERIFIED" | "TEMPORARY_ERROR" | "REAUTH_REQUIRED" | "UNAVAILABLE" | null;
  checked: number;
  newViolations: string[];
  restored: string[];
  violations: string[];
  message: string | null;
};

/**
 * Verifies a user's outstanding obligations, consulting YouTube only when needed.
 *
 * `force` is what a sensitive operation and an explicit recheck pass. Without it
 * a fresh cached verdict is reused and no call is made, which is the entire reason
 * the feature is affordable.
 *
 * The API call happens OUTSIDE any transaction, on purpose. `completeSupportSession`
 * runs at Serializable isolation, and an 8-second YouTube timeout inside that
 * transaction would hold it open and exhaust the connection pool. This mirrors
 * how `verifySessionTasks` already sequences its calls: talk to the provider
 * first, then write in short transactions.
 */
export async function verifyCompliance(
  userId: string,
  options: { force?: boolean; reason: VerifyReason } = { reason: "SENSITIVE_OPERATION" }
): Promise<VerifyOutcome> {
  const now = new Date();

  const rows = await prisma.subscriptionCompliance.findMany({
    where: { userId, subscriptionRequired: true, subscriptionVerified: true },
    orderBy: { lastSubscriptionCheckAt: { sort: "asc", nulls: "first" } },
  });

  if (rows.length === 0) {
    return {
      compliant: true,
      consultedApi: false,
      apiOutcome: null,
      checked: 0,
      newViolations: [],
      restored: [],
      violations: [],
      message: COMPLIANCE_MESSAGES.NOTHING_TO_CHECK,
    };
  }

  const violatedNow = rows.filter((row) => row.status === "VIOLATED").map((row) => row.targetChannelId);

  // A row is examined when the caller forces it, or when its cached verdict has
  // aged out. A VIOLATED row is always examined on a forced call regardless of
  // freshness: that is the recheck the user is asking for, and refusing it because
  // the "no" is recent would make the restore button useless.
  const candidates = rows.filter((row) => {
    if (options.force) return row.status === "VIOLATED" || !isFresh(row, now);
    return !isFresh(row, now);
  });

  if (candidates.length === 0) {
    return {
      compliant: violatedNow.length === 0,
      consultedApi: false,
      apiOutcome: null,
      checked: 0,
      newViolations: [],
      restored: [],
      violations: violatedNow,
      message: violatedNow.length > 0 ? COMPLIANCE_MESSAGES.BLOCKED : null,
    };
  }

  // One call per user covers up to maxChannelsPerCall obligations. A user beyond
  // that is truncated to the stalest ones rather than paged, because a second page
  // costs another unit for a case that effectively does not occur; the remainder
  // is picked up by the next sweep.
  const channels = [...new Set(candidates.map((row) => row.targetChannelId))].slice(
    0,
    COMPLIANCE_RULES.maxChannelsPerCall
  );

  const result = await checkSubscriptions(userId, channels);

  // ---- Could not ask: never a violation ----------------------------------
  if (!result.available) {
    await recordCheckFailure(candidates, now);
    logger.info("compliance check could not be completed", {
      userId,
      reason: options.reason,
      outcome: result.outcome,
      rows: candidates.length,
    });
    await writeAudit({
      userId,
      action: "SECURITY",
      entity: "SubscriptionCompliance",
      metadata: { event: "CHECK_FAILED", outcome: result.outcome, reason: options.reason, rows: candidates.length },
    });

    return {
      compliant: violatedNow.length === 0,
      consultedApi: true,
      apiOutcome: result.outcome === "REAUTH_REQUIRED" ? "REAUTH_REQUIRED" : result.outcome === "TEMPORARY_ERROR" ? "TEMPORARY_ERROR" : "UNAVAILABLE",
      checked: 0,
      newViolations: [],
      restored: [],
      violations: violatedNow,
      // A user in violation is still told they are blocked, but the reason for the
      // failed CHECK is reported separately so they are never accused of
      // unsubscribing because Google timed out.
      message:
        result.outcome === "REAUTH_REQUIRED"
          ? COMPLIANCE_MESSAGES.REAUTH_REQUIRED
          : COMPLIANCE_MESSAGES.CHECK_UNAVAILABLE,
    };
  }

  // ---- A definitive answer arrived ---------------------------------------
  const newViolations: string[] = [];
  const restored: string[] = [];

  for (const row of candidates) {
    if (!channels.includes(row.targetChannelId)) continue;
    const subscribed = result.subscribed.has(row.targetChannelId);

    if (subscribed) {
      // ACTIVE stays ACTIVE; VIOLATED becomes RESTORED. Nothing here creates a
      // support, a ledger entry or a reward — a restore only lifts the gate.
      const wasViolated = row.status === "VIOLATED";
      await prisma.subscriptionCompliance.update({
        where: { id: row.id },
        data: {
          status: wasViolated ? "RESTORED" : row.status,
          lastKnownSubscribed: true,
          lastSubscriptionCheckAt: now,
          checkFailureCount: 0,
          nextCheckAfter: null,
          ...(wasViolated ? { restoredAt: now, violationDetectedAt: null } : {}),
        },
      });
      if (wasViolated) restored.push(row.targetChannelId);
      continue;
    }

    // Definitively not subscribed.
    if (COMPLIANT.includes(row.status)) {
      await markViolation(row, now);
      newViolations.push(row.targetChannelId);
    } else {
      // Already VIOLATED and still unsubscribed: refresh the check timestamp so
      // the sweep does not keep re-asking, but leave the violation as it is.
      await prisma.subscriptionCompliance.update({
        where: { id: row.id },
        data: { lastKnownSubscribed: false, lastSubscriptionCheckAt: now, checkFailureCount: 0, nextCheckAfter: null },
      });
    }
  }

  const stillViolated = await prisma.subscriptionCompliance.findMany({
    where: { userId, subscriptionRequired: true, subscriptionVerified: true, status: "VIOLATED" },
    select: { targetChannelId: true },
  });
  const violations = stillViolated.map((row) => row.targetChannelId);

  if (newViolations.length > 0 || restored.length > 0) {
    logger.info("compliance state changed", {
      userId,
      reason: options.reason,
      newViolations: newViolations.length,
      restored: restored.length,
    });
  }

  return {
    compliant: violations.length === 0,
    consultedApi: true,
    apiOutcome: "VERIFIED",
    checked: channels.length,
    newViolations,
    restored,
    violations,
    message:
      violations.length > 0
        ? newViolations.length > 0
          ? COMPLIANCE_MESSAGES.BLOCKED
          : COMPLIANCE_MESSAGES.STILL_UNSUBSCRIBED
        : restored.length > 0
          ? COMPLIANCE_MESSAGES.RESTORED
          : null,
  };
}

/**
 * Marks one obligation violated, and records WHY in the places a human will look.
 *
 * The abuse signal is SUBSCRIPTION_CHURN, which already existed in the enum and
 * was until now unused — the architecture had reserved a slot for exactly this.
 * Severity 4 is a moderate signal: on its own it will not deny anything (the deny
 * threshold is 75 and SEVERITY_WEIGHT is 8), but a user who repeatedly subscribes
 * and unsubscribes accumulates them and becomes visible.
 *
 * Everything in this function is one transaction, so a violation can never exist
 * without its audit row and its notification.
 */
async function markViolation(row: SubscriptionCompliance, now: Date): Promise<void> {
  const notification = await prisma.$transaction(async (tx) => {
    // Conditional update: only a compliant row may become violated, so two
    // concurrent checks cannot both report a new violation for one obligation.
    const claimed = await tx.subscriptionCompliance.updateMany({
      where: { id: row.id, status: { in: COMPLIANT } },
      data: {
        status: "VIOLATED",
        lastKnownSubscribed: false,
        lastSubscriptionCheckAt: now,
        violationDetectedAt: now,
        restoredAt: null,
        checkFailureCount: 0,
        nextCheckAfter: null,
      },
    });
    if (claimed.count === 0) return null;

    await persistAbuseSignals(tx, {
      userId: row.userId,
      reasons: [
        {
          type: "SUBSCRIPTION_CHURN",
          severity: 4,
          note: `unsubscribed from ${row.targetChannelId} after being rewarded (support ${row.supportId})`,
        },
      ],
    });

    await writeAuditTx(tx, {
      userId: row.userId,
      action: "SECURITY",
      entity: "SubscriptionCompliance",
      entityId: row.id,
      metadata: {
        event: "VIOLATION_DETECTED",
        supportId: row.supportId,
        channelId: row.targetChannelId,
      },
    });

    return createNotificationTx(tx, {
      userId: row.userId,
      type: "SECURITY",
      title: "اشتراک یکی از کانال‌های حمایت‌شده لغو شده است",
      message: COMPLIANCE_MESSAGES.BLOCKED,
      metadata: { supportId: row.supportId, channelId: row.targetChannelId },
      // One notification per violation event, not per check.
      dedupeKey: `compliance-violation:${row.id}:${now.toISOString().slice(0, 10)}`,
    });
  });

  if (notification) await deliverNotification({ ...notification, actor: null });
}

/**
 * Records a failed check across the rows it covered.
 *
 * Status is untouched by design — this is the code path that keeps a Google outage
 * from becoming a wave of false violations.
 */
async function recordCheckFailure(rows: SubscriptionCompliance[], now: Date): Promise<void> {
  await Promise.all(
    rows.map((row) =>
      prisma.subscriptionCompliance
        .update({
          where: { id: row.id },
          data: {
            checkFailureCount: { increment: 1 },
            nextCheckAfter: backoffUntil(row.checkFailureCount + 1, now),
          },
        })
        .catch((e) => logger.warn("could not record compliance check failure", { id: row.id, error: e }))
    )
  );
}

/* ------------------------------------------------------------------------- */
/* The gate                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Gate for any operation that depends on Support.
 *
 * Option B: this blocks ALL new support activity while a violation stands, not
 * only campaigns that ask for a subscribe. The reasoning the product chose is
 * that the feature protects the quality of support overall, so someone currently
 * holding a reward for a subscription they cancelled does not get to keep earning
 * elsewhere in the meantime.
 *
 * Non-destructive and instantly reversible: the only way out is re-subscribing,
 * and the moment a check confirms it the gate opens. Nothing here bans, suspends
 * or penalizes an account.
 *
 * Cheap in the common case. It first asks the database whether any violation
 * exists — an index lookup on (userId, status). A user with a clean record and a
 * fresh cache reaches the API zero times. A live call happens only when the cache
 * has aged past the TTL, and its result is then reused by every subsequent
 * operation inside the window.
 */
export async function assertCompliant(userId: string): Promise<void> {
  const violated = await prisma.subscriptionCompliance.findFirst({
    where: { userId, status: "VIOLATED", subscriptionRequired: true, subscriptionVerified: true },
    select: { targetChannelId: true },
  });

  if (violated) {
    // A standing violation is re-verified before it blocks anything, so a user who
    // re-subscribed but has not pressed the button is not turned away. Failure to
    // reach the API keeps the block in place: the last definitive answer was "not
    // subscribed", and an outage is not evidence to the contrary.
    const result = await verifyCompliance(userId, { force: true, reason: "SENSITIVE_OPERATION" });
    if (!result.compliant) throw new ComplianceBlockedError(result.violations);
    return;
  }

  // No violation on record. Refresh only if the cache has expired.
  const stale = await prisma.subscriptionCompliance.findFirst({
    where: {
      userId,
      subscriptionRequired: true,
      subscriptionVerified: true,
      status: { in: COMPLIANT },
      OR: [{ lastSubscriptionCheckAt: null }, { lastSubscriptionCheckAt: { lte: ttlCutoff() } }],
      AND: [{ OR: [{ nextCheckAfter: null }, { nextCheckAfter: { lte: new Date() } }] }],
    },
    select: { id: true },
  });
  if (!stale) return;

  const result = await verifyCompliance(userId, { force: true, reason: "SENSITIVE_OPERATION" });
  if (!result.compliant) throw new ComplianceBlockedError(result.violations);
}

/* ------------------------------------------------------------------------- */
/* Background sweep                                                           */
/* ------------------------------------------------------------------------- */

export type SweepResult = {
  usersConsidered: number;
  usersChecked: number;
  newViolations: number;
  restored: number;
  skippedForQuota: boolean;
  quota: { spent: number; ceiling: number; dailyLimit: number };
};

/**
 * Periodic low-cost compliance sweep, run from the maintenance job.
 *
 * FOUR FILTERS, EACH THERE TO AVOID SPENDING A UNIT FOR NOTHING
 *   1. subscriptionRequired AND subscriptionVerified — an obligation that was
 *      never API-verified cannot be judged.
 *   2. lastSubscriptionCheckAt past the TTL — a fresh verdict needs no call.
 *   3. nextCheckAfter elapsed — respects the backoff from earlier failures.
 *   4. the user was active within `inactiveDays` — a dormant user cannot earn
 *      anything without passing the gate at that moment, so checking them in the
 *      background buys nothing and takes quota from active users.
 *
 * Then a hard cap of `sweepMaxUsersPerRun` users per run, and a budget ceiling at
 * `sweepQuotaFraction` of the daily quota. The budget is re-read before each user,
 * so a run stops as soon as the ceiling is reached instead of overshooting by a
 * whole batch.
 *
 * Grouped by user because one call answers all of one user's channels, so the
 * unit of work is a user rather than an obligation.
 */
export async function runComplianceSweep(): Promise<SweepResult> {
  const now = new Date();
  const activeSince = new Date(now.getTime() - COMPLIANCE_RULES.inactiveDays * 86_400_000);

  const due = await prisma.subscriptionCompliance.findMany({
    where: {
      subscriptionRequired: true,
      subscriptionVerified: true,
      status: { in: ["ACTIVE", "VIOLATED", "RESTORED"] },
      OR: [{ lastSubscriptionCheckAt: null }, { lastSubscriptionCheckAt: { lte: ttlCutoff(now) } }],
      AND: [{ OR: [{ nextCheckAfter: null }, { nextCheckAfter: { lte: now } }] }],
      user: { status: "ACTIVE", lastActiveAt: { gte: activeSince } },
    },
    select: { userId: true },
    orderBy: { lastSubscriptionCheckAt: { sort: "asc", nulls: "first" } },
    // Read enough rows to fill the user cap even when one user holds several.
    take: COMPLIANCE_RULES.sweepMaxUsersPerRun * COMPLIANCE_RULES.maxChannelsPerCall,
  });

  const userIds = [...new Set(due.map((row) => row.userId))].slice(0, COMPLIANCE_RULES.sweepMaxUsersPerRun);

  let usersChecked = 0;
  let newViolations = 0;
  let restored = 0;
  let skippedForQuota = false;

  for (const userId of userIds) {
    const budget = await hasSweepBudget(COMPLIANCE_RULES.sweepQuotaFraction);
    if (!budget.allowed) {
      skippedForQuota = true;
      logger.warn("compliance sweep paused: quota ceiling reached", {
        spent: budget.status.spent,
        ceiling: budget.ceiling,
      });
      break;
    }

    // force: false — the TTL filter already selected stale rows, and leaving the
    // decision to verifyCompliance means the sweep can never bypass the cache.
    const result = await verifyCompliance(userId, { reason: "SWEEP" });
    if (result.consultedApi) usersChecked += 1;
    newViolations += result.newViolations.length;
    restored += result.restored.length;
  }

  const finalBudget = await hasSweepBudget(COMPLIANCE_RULES.sweepQuotaFraction);
  const summary: SweepResult = {
    usersConsidered: userIds.length,
    usersChecked,
    newViolations,
    restored,
    skippedForQuota,
    quota: {
      spent: finalBudget.status.spent,
      ceiling: finalBudget.ceiling,
      dailyLimit: finalBudget.status.dailyLimit,
    },
  };

  if (userIds.length > 0) logger.info("compliance sweep completed", summary);
  return summary;
}

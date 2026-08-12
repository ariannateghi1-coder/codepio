import "server-only";
import { Prisma, type SupportSession, type VerificationMethod } from "@prisma/client";
import { prisma } from "../prisma";
import { logger } from "../logger";
import { BusinessRuleError, ConflictError, NotFoundError } from "../errors";
import { REWARDS, TASK_REWARDS, WATCH_RULES } from "../gamification";
import { ledgerKey, recordCredit, recordReputation, recordXp, reverseSessionLedger } from "./ledger";
import { REPUTATION } from "../gamification";
import { assessSessionEvidence, assessSupportRisk, persistAbuseSignals, scoreFromReasons, type RiskReason } from "./anti-abuse";
import {
  applyHeartbeat,
  boundedElapsed,
  checkSequence,
  isWatchSatisfied,
  minimumElapsedSeconds,
  parseSegments,
  requiredWatchSeconds,
  watchPercent,
} from "./watch";
import { assertRewardTransition, isTerminal, nextState } from "./support-state";
import { computeSettlement, defaultTaskBonus, settlementBreakdown } from "./reward";
import { checkComment, checkLike, checkSubscription } from "./youtube-api";
import { createNotificationTx, deliverNotification } from "./notifications";
import { campaignAvailabilityFailure } from "./campaign-eligibility";
import { evaluateBadges } from "./badges";
import { registerStreakDay } from "./streak";
import { writeAuditTx } from "../audit";

/**
 * Support Exchange core service.
 *
 * The product loop, enforced end-to-end:
 *   start → watch (server-verified segments) → subscribe/like (YouTube API) →
 *   optional comment → risk assessment → reward (instant / pending / denied)
 *
 * Design decisions worth stating:
 *
 *  - A `Support` row is created only when a session actually completes. Clicking
 *    a button is not support; a verified session is.
 *  - Reward math never touches `user.points` directly — everything goes through
 *    the ledgers with deterministic idempotency keys, so retries and reversals
 *    are exact.
 *  - The campaign capacity check and the budget decrement happen as conditional
 *    atomic UPDATEs (`WHERE spent + cost <= budget`), so 25 concurrent
 *    completions on a capacity of 5 admit exactly 5 without relying on
 *    Serializable retries for correctness.
 *  - Eligibility is re-checked at completion time, not just at start: a campaign
 *    can be paused or exhausted while a user is watching.
 */

type Tx = Prisma.TransactionClient;

export class SupportServiceError extends BusinessRuleError {
  readonly rule: string;
  constructor(rule: string, message: string) {
    super(message, { rule });
    this.rule = rule;
  }
}

const RULE_MESSAGES: Record<string, string> = {
  SELF_SUPPORT: "نمی‌توانید از خودتان حمایت کنید.",
  CAMPAIGN_NOT_FOUND: "این کمپین وجود ندارد.",
  CAMPAIGN_INACTIVE: "این کمپین در حال حاضر فعال نیست.",
  CAMPAIGN_NOT_STARTED: "این کمپین هنوز شروع نشده است.",
  CAMPAIGN_ENDED: "زمان این کمپین به پایان رسیده است.",
  CAMPAIGN_FULL: "ظرفیت این کمپین تکمیل شده است.",
  CAMPAIGN_BUDGET_EXHAUSTED: "بودجه پاداش این کمپین تمام شده است.",
  DAILY_LIMIT: "سقف روزانه این کمپین پر شده است.",
  USER_LIMIT: "سهم شما از این کمپین تکمیل شده است.",
  DUPLICATE_SUPPORT: "قبلاً در این کمپین حمایت کرده‌اید.",
  ACCOUNT_TOO_NEW: "برای این کمپین حساب شما باید قدیمی‌تر باشد.",
  CREATOR_UNAVAILABLE: "حساب سازنده این کمپین در دسترس نیست.",
  VIDEO_UNAVAILABLE: "ویدیوی این کمپین در دسترس نیست.",
  SESSION_NOT_FOUND: "این نشست حمایت پیدا نشد.",
  SESSION_CLOSED: "این نشست حمایت بسته شده است.",
  SESSION_EXPIRED: "زمان این نشست حمایت به پایان رسیده است.",
  WATCH_INCOMPLETE: "تماشای ویدیو کامل نشده است.",
  IMPOSSIBLE_TIMELINE: "زمان سپری‌شده با میزان تماشای گزارش‌شده هم‌خوانی ندارد.",
  REQUIRED_TASK_INCOMPLETE: "همه کارهای الزامی انجام نشده‌اند.",
  RISK_DENIED: "این حمایت به دلیل رفتار مشکوک تأیید نشد.",
  ALREADY_SUPPORTED_PAIR: "در بازه خنک‌سازی این سازنده هستید.",
};

function ruleError(rule: keyof typeof RULE_MESSAGES | string): SupportServiceError {
  return new SupportServiceError(rule, RULE_MESSAGES[rule] ?? "امکان انجام این عملیات وجود ندارد.");
}

/* ------------------------------------------------------------------------- */
/* Eligibility                                                                */
/* ------------------------------------------------------------------------- */

type EligibilityInput = {
  supporterId: string;
  campaignId: string;
};

/**
 * Full eligibility check. Runs at session start AND again at completion, since
 * campaign state can change while the supporter is watching.
 */
async function assertEligible(tx: Tx, input: EligibilityInput) {
  const campaign = await tx.campaign.findUnique({
    where: { id: input.campaignId },
    include: {
      creator: { select: { id: true, status: true, username: true, name: true, avatarUrl: true } },
      video: { select: { id: true, status: true, youtubeVideoId: true, durationSec: true, userId: true } },
      tasks: { orderBy: { sortOrder: "asc" } },
    },
  });

  if (!campaign) throw ruleError("CAMPAIGN_NOT_FOUND");
  if (!campaign.creatorId || !campaign.creator) throw ruleError("CREATOR_UNAVAILABLE");
  if (campaign.creatorId === input.supporterId) throw ruleError("SELF_SUPPORT");
  if (campaign.creator.status !== "ACTIVE") throw ruleError("CREATOR_UNAVAILABLE");

  const now = new Date();
  if (campaign.status !== "ACTIVE") throw ruleError("CAMPAIGN_INACTIVE");
  if (campaign.startAt > now) throw ruleError("CAMPAIGN_NOT_STARTED");
  if (campaign.endAt < now) throw ruleError("CAMPAIGN_ENDED");

  if (!campaign.video || campaign.video.status !== "ACTIVE" || campaign.video.userId !== campaign.creatorId) {
    throw ruleError("VIDEO_UNAVAILABLE");
  }

  const supporter = await tx.user.findUniqueOrThrow({
    where: { id: input.supporterId },
    select: { id: true, status: true, createdAt: true, name: true, username: true, avatarUrl: true },
  });
  if (supporter.status !== "ACTIVE") throw ruleError("CREATOR_UNAVAILABLE");

  if (campaign.minAccountAgeHours > 0) {
    const ageHours = (now.getTime() - supporter.createdAt.getTime()) / 3_600_000;
    if (ageHours < campaign.minAccountAgeHours) throw ruleError("ACCOUNT_TOO_NEW");
  }

  // Already completed for this pair+campaign? The unique index is the real
  // guard, this is the friendly early exit.
  const existing = await tx.support.findUnique({
    where: {
      supporterId_receiverId_campaignId: {
        supporterId: input.supporterId,
        receiverId: campaign.creatorId,
        campaignId: campaign.id,
      },
    },
    select: { id: true, status: true },
  });
  if (existing && existing.status === "ACTIVE") throw ruleError("DUPLICATE_SUPPORT");

  if (campaign.maxSupportsPerUser) {
    const count = await tx.support.count({
      where: { supporterId: input.supporterId, campaignId: campaign.id, status: "ACTIVE" },
    });
    if (count >= campaign.maxSupportsPerUser) throw ruleError("USER_LIMIT");
  }

  const since = new Date(now.getTime() - 86_400_000);
  const [totalSupports, dailySupports] = await Promise.all([
    tx.support.count({ where: { campaignId: campaign.id, status: "ACTIVE" } }),
    tx.support.count({
      where: { campaignId: campaign.id, status: "ACTIVE", createdAt: { gte: since } },
    }),
  ]);
  const availabilityFailure = campaignAvailabilityFailure({
    budgetCredits: campaign.budgetCredits,
    spentCredits: campaign.spentCredits,
    rewardCredits: campaign.rewardCredits,
    maxTotalSupports: campaign.maxTotalSupports,
    dailyLimit: campaign.dailyLimit,
    totalSupports,
    dailySupports,
    tasks: campaign.tasks,
  });
  if (availabilityFailure) throw ruleError(availabilityFailure);

  return { campaign, supporter };
}

/* ------------------------------------------------------------------------- */
/* Session start                                                              */
/* ------------------------------------------------------------------------- */

export type StartSupportInput = {
  supporterId: string;
  campaignId: string;
  ipHash: string | null;
  userAgentHash: string | null;
};

export type StartSupportResult = {
  session: SupportSession;
  video: { id: string; youtubeVideoId: string; durationSec: number | null };
  requiredWatchSeconds: number;
  tasks: { type: string; required: boolean; rewardCredits: number; rewardXp: number }[];
  estimatedSeconds: number;
};

export async function startSupportSession(input: StartSupportInput): Promise<StartSupportResult> {
  return prisma.$transaction(async (tx) => {
    const { campaign } = await assertEligible(tx, { supporterId: input.supporterId, campaignId: input.campaignId });

    // Reuse an in-flight session instead of stacking duplicates: double-clicking
    // "Start Support" must not create two sessions.
    const open = await tx.supportSession.findFirst({
      where: {
        supporterId: input.supporterId,
        campaignId: campaign.id,
        state: { in: ["STARTED", "VIDEO_OPENED", "WATCHING", "WATCH_THRESHOLD_REACHED", "VERIFYING"] },
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
    });

    const video = campaign.video!;
    const durationSec = video.durationSec ?? 0;
    const requiredSec = durationSec > 0 ? requiredWatchSeconds(durationSec, campaign.requiredWatchPercent) : 0;

    const tasks = campaign.tasks.length
      ? campaign.tasks
      : // A campaign with no explicit tasks still means "watch it".
        [
          {
            id: "",
            campaignId: campaign.id,
            type: "WATCH_VIDEO" as const,
            required: true,
            config: null,
            rewardCredits: TASK_REWARDS.WATCH_VIDEO.credits,
            rewardXp: TASK_REWARDS.WATCH_VIDEO.xp,
            timeoutSec: WATCH_RULES.sessionTtlMinutes * 60,
            sortOrder: 0,
          },
        ];

    const session =
      open ??
      (await tx.supportSession.create({
        data: {
          campaignId: campaign.id,
          supporterId: input.supporterId,
          creatorId: campaign.creatorId!,
          videoId: video.id,
          state: "STARTED",
          expiresAt: new Date(Date.now() + WATCH_RULES.sessionTtlMinutes * 60_000),
          ipHash: input.ipHash,
          userAgentHash: input.userAgentHash,
        },
      }));

    if (!open) {
      await tx.supportTask.createMany({
        data: tasks.map((task) => ({
          sessionId: session.id,
          campaignTaskId: task.id || null,
          type: task.type,
          required: task.required,
        })),
        skipDuplicates: true,
      });

      await tx.watchSession.create({
        data: {
          sessionId: session.id,
          videoId: video.id,
          durationSec,
          requiredSec,
        },
      });
    }

    return {
      session,
      video: { id: video.id, youtubeVideoId: video.youtubeVideoId, durationSec: video.durationSec },
      requiredWatchSeconds: requiredSec,
      tasks: tasks.map((task) => ({
        type: task.type,
        required: task.required,
        rewardCredits: task.rewardCredits,
        rewardXp: task.rewardXp,
      })),
      estimatedSeconds: requiredSec + 60,
    };
  });
}

/* ------------------------------------------------------------------------- */
/* Watch heartbeat                                                            */
/* ------------------------------------------------------------------------- */

export type HeartbeatResult = {
  accumulatedSec: number;
  requiredSec: number;
  percent: number;
  satisfied: boolean;
  state: SupportSession["state"];
  flagged: boolean;
  /** True when this beat was refused (replay / out-of-order / too frequent). */
  rejected: boolean;
  /** Sequence the server has accepted, so the client can resynchronise. */
  acceptedSequence: number;
};

/**
 * Applies one client heartbeat. The client reports its player position; the
 * server decides what that is worth by comparing it against the wall-clock time
 * it actually measured since the previous heartbeat. This is what makes
 * `seek(540)` worthless.
 *
 * Ordering is explicit rather than inferred: `lastSequence` rejects replays and
 * out-of-order delivery, and `lastPosition` is the credit cursor. Deriving the
 * cursor from the segment list (the previous approach) lost information after a
 * rewind, because two different playback positions can map to the same segment.
 *
 * A refused beat is not an error the user sees — the session simply does not
 * advance, and repeated refusals become an abuse signal.
 */
export async function recordWatchHeartbeat(input: {
  sessionId: string;
  supporterId: string;
  position: number;
  playerState: string;
  sequence: number;
  hiddenSec?: number;
}): Promise<HeartbeatResult> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "WatchSession" WHERE "sessionId" = ${input.sessionId} FOR UPDATE
    `;
    const session = await tx.supportSession.findUnique({
      where: { id: input.sessionId },
      include: { watchSession: true, campaign: { select: { requiredWatchPercent: true } } },
    });

    // Ownership is checked server-side; a session id is not a capability.
    if (!session || session.supporterId !== input.supporterId) throw ruleError("SESSION_NOT_FOUND");
    if (!session.watchSession) throw ruleError("SESSION_NOT_FOUND");
    if (session.expiresAt < new Date()) {
      await tx.supportSession.update({ where: { id: session.id }, data: { state: "EXPIRED" } });
      throw ruleError("SESSION_EXPIRED");
    }
    if (isTerminal(session.state)) throw ruleError("SESSION_CLOSED");

    const watch = session.watchSession;
    const now = new Date();
    const rawElapsed = (now.getTime() - watch.lastHeartbeatAt.getTime()) / 1000;

    // ---- Sequence / cadence gate ----------------------------------------
    const gate = checkSequence({
      sequence: input.sequence,
      lastSequence: watch.lastSequence,
      elapsedWallSeconds: rawElapsed,
      expectedIntervalSeconds: WATCH_RULES.heartbeatSeconds,
    });

    if (!gate.accepted) {
      await tx.watchSession.update({
        where: { sessionId: session.id },
        data: { rejectedBeats: { increment: 1 } },
      });
      if (gate.reason !== "TOO_FREQUENT") {
        // A replay attempt is worth recording; mere jitter is not.
        await persistAbuseSignals(tx, {
          userId: input.supporterId,
          sessionId: session.id,
          reasons: [{ type: "HEARTBEAT_REPLAY", severity: 3, note: gate.note }],
        });
      }
      return {
        accumulatedSec: watch.accumulatedSec,
        requiredSec: watch.requiredSec,
        percent: watchPercent(watch.accumulatedSec, watch.durationSec),
        satisfied: Boolean(watch.completedAt),
        state: session.state,
        flagged: false,
        rejected: true,
        acceptedSequence: watch.lastSequence,
      };
    }

    // Cap the allowance so a long silence cannot bank credit for a later jump.
    const elapsedWallSeconds = boundedElapsed(rawElapsed, WATCH_RULES.heartbeatSeconds);

    const outcome = applyHeartbeat({
      segments: parseSegments(watch.segments),
      previousPosition: watch.lastPosition,
      position: input.position,
      elapsedWallSeconds,
      durationSec: watch.durationSec,
      maxRate: WATCH_RULES.maxPlaybackRate,
    });

    const satisfied =
      watch.durationSec > 0 &&
      isWatchSatisfied(outcome.accumulatedSec, watch.durationSec, session.campaign.requiredWatchPercent);

    const acceptedSequence = input.sequence;

    await tx.watchSession.update({
      where: { sessionId: session.id },
      data: {
        segments: outcome.segments as unknown as Prisma.InputJsonValue,
        accumulatedSec: Math.floor(outcome.accumulatedSec),
        // The cursor advances even on a rejected-as-seek jump: the user really is
        // at the new position, they simply earned nothing for getting there.
        lastPosition: Math.floor(Math.min(Math.max(0, input.position), watch.durationSec || input.position)),
        lastSequence: acceptedSequence,
        playerState: input.playerState.slice(0, 20),
        heartbeats: { increment: 1 },
        seekCount: outcome.seeked ? { increment: 1 } : undefined,
        hiddenSec: input.hiddenSec ? { increment: Math.floor(input.hiddenSec) } : undefined,
        lastHeartbeatAt: now,
        completedAt: satisfied ? (watch.completedAt ?? now) : watch.completedAt,
      },
    });

    if (outcome.impossible) {
      // Recorded now, weighed later at completion — a single anomaly is a signal,
      // not a verdict.
      await persistAbuseSignals(tx, {
        userId: input.supporterId,
        sessionId: session.id,
        reasons: [{ type: "CLIENT_TAMPERING", severity: 6, note: "heartbeat reported non-physical progress" }],
      });
    }

    // The state machine decides whether the desired transition is legal, so a
    // late beat can never drag a VERIFYING session back to WATCHING.
    const desired = satisfied ? "WATCH_THRESHOLD_REACHED" : "WATCHING";
    const resolved = nextState(session.state, desired);
    if (resolved !== session.state) {
      await tx.supportSession.update({ where: { id: session.id }, data: { state: resolved } });
    }

    if (satisfied) {
      await tx.supportTask.updateMany({
        where: { sessionId: session.id, type: "WATCH_VIDEO", state: { not: "SATISFIED" } },
        data: { state: "SATISFIED", method: "PLATFORM_OBSERVED", satisfiedAt: now },
      });
    }

    return {
      accumulatedSec: Math.floor(outcome.accumulatedSec),
      requiredSec: watch.requiredSec,
      percent: watchPercent(outcome.accumulatedSec, watch.durationSec),
      satisfied,
      state: resolved,
      flagged: outcome.impossible,
      rejected: false,
      acceptedSequence,
    };
  });
}

/* ------------------------------------------------------------------------- */
/* Task verification                                                          */
/* ------------------------------------------------------------------------- */

export type TaskVerification = {
  type: string;
  required: boolean;
  satisfied: boolean;
  method: VerificationMethod;
  /** Machine-readable outcome, so the UI can distinguish "no" from "couldn't ask". */
  outcome: "VERIFIED" | "NOT_VERIFIED" | "TEMPORARY_ERROR" | "REAUTH_REQUIRED" | "UNAVAILABLE";
  /** User-facing explanation when a check could not be performed or failed. */
  note?: string;
};

/**
 * Verifies the YouTube-side tasks (subscribe / like / comment) for a session.
 *
 * Verification honesty rules:
 *  - With an OAuth grant, subscribe and like are answered by the API → YOUTUBE_API.
 *  - Without a grant we CANNOT confirm them. We do not accept the client's word
 *    as proof: the task stays unsatisfied and the UI explains that connecting
 *    the YouTube account is required. Optional tasks may pass as SELF_REPORTED,
 *    and are labelled that way everywhere.
 *  - A TEMPORARY_ERROR (timeout, 5xx, quota) leaves the task PENDING rather than
 *    FAILED. Recording "you did not subscribe" because Google was unreachable
 *    would punish an honest supporter for someone else's outage.
 */
export async function verifySessionTasks(sessionId: string, supporterId: string): Promise<TaskVerification[]> {
  const session = await prisma.supportSession.findUnique({
    where: { id: sessionId },
    include: {
      tasks: true,
      watchSession: true,
      campaign: { select: { requiredWatchPercent: true } },
      video: { select: { youtubeVideoId: true } },
      creator: { select: { youtubeConnection: { select: { channelId: true } } } },
    },
  });

  if (!session || session.supporterId !== supporterId) throw ruleError("SESSION_NOT_FOUND");
  if (isTerminal(session.state)) throw ruleError("SESSION_CLOSED");
  if (session.expiresAt < new Date()) throw ruleError("SESSION_EXPIRED");

  // Only advance the state if the machine allows it from here.
  const verifying = nextState(session.state, "VERIFYING");
  if (verifying !== session.state) {
    await prisma.supportSession.update({ where: { id: session.id }, data: { state: verifying } });
  }

  const channelId = session.creator.youtubeConnection?.channelId ?? null;
  const videoId = session.video?.youtubeVideoId ?? null;
  const supporterChannelId = (
    await prisma.youtubeConnection.findUnique({ where: { userId: supporterId }, select: { channelId: true } })
  )?.channelId ?? null;

  const results: TaskVerification[] = [];

  for (const task of session.tasks) {
    let satisfied = false;
    let method: VerificationMethod = "UNVERIFIED";
    let outcome: TaskVerification["outcome"] = "UNAVAILABLE";
    let note: string | undefined;
    let detail: Record<string, unknown> = {};

    if (task.type === "WATCH_VIDEO") {
      const watch = session.watchSession;
      satisfied = Boolean(
        watch &&
          watch.durationSec > 0 &&
          isWatchSatisfied(watch.accumulatedSec, watch.durationSec, session.campaign.requiredWatchPercent)
      );
      // Deliberately PLATFORM_OBSERVED, never YOUTUBE_API: no YouTube endpoint
      // reports how much of a video a specific user watched.
      method = satisfied ? "PLATFORM_OBSERVED" : "UNVERIFIED";
      outcome = satisfied ? "VERIFIED" : "NOT_VERIFIED";
      if (!satisfied && watch) {
        note = `تماشای ${watchPercent(watch.accumulatedSec, watch.durationSec)}٪ ثبت شده و به ${session.campaign.requiredWatchPercent}٪ نیاز است.`;
      }
      detail = watch ? { accumulatedSec: watch.accumulatedSec, requiredSec: watch.requiredSec } : {};
    } else if (task.type === "SUBSCRIBE_CHANNEL" && channelId) {
      const check = await checkSubscription(supporterId, channelId);
      satisfied = check.satisfied;
      method = check.available ? "YOUTUBE_API" : "UNVERIFIED";
      outcome = check.outcome;
      note = subscribeNote(check.outcome);
      detail = check.detail ?? {};
    } else if (task.type === "LIKE_VIDEO" && videoId) {
      const check = await checkLike(supporterId, videoId);
      satisfied = check.satisfied;
      method = check.available ? "YOUTUBE_API" : "UNVERIFIED";
      outcome = check.outcome;
      note = likeNote(check.outcome);
      detail = check.detail ?? {};
    } else if (task.type === "COMMENT_VIDEO" && videoId) {
      const check = await checkComment(videoId, supporterChannelId);
      satisfied = check.satisfied;
      method = check.available ? "YOUTUBE_API" : supporterChannelId ? "UNVERIFIED" : "SELF_REPORTED";
      outcome = check.outcome;
      note = check.available ? undefined : "بررسی خودکار کامنت ممکن نبود؛ این مورد اختیاری است.";
      detail = check.detail ?? {};
    } else {
      note = "پیکربندی این کار کامل نیست.";
    }

    // A transient upstream failure must not be written down as a definitive
    // failure: keep the task open so the user can retry.
    const nextTaskState =
      satisfied
        ? "SATISFIED"
        : outcome === "TEMPORARY_ERROR" || outcome === "REAUTH_REQUIRED"
          ? "PENDING"
          : task.required
            ? "FAILED"
            : "SKIPPED";

    await prisma.$transaction(async (tx) => {
      await tx.supportTask.update({
        where: { id: task.id },
        data: {
          state: nextTaskState,
          method,
          satisfiedAt: satisfied ? new Date() : null,
          attempts: { increment: 1 },
          evidence: detail as Prisma.InputJsonValue,
        },
      });
      await tx.supportVerification.create({
        data: {
          sessionId: session.id,
          taskType: task.type,
          method,
          result:
            satisfied
              ? "PASSED"
              : outcome === "TEMPORARY_ERROR"
                ? "PENDING"
                : outcome === "NOT_VERIFIED"
                  ? "FAILED"
                  : "INCONCLUSIVE",
          detail: detail as Prisma.InputJsonValue,
        },
      });
    });

    results.push({ type: task.type, required: task.required, satisfied, method, outcome, note });
  }

  return results;
}

/**
 * Failure copy for subscribe. Specific and actionable, never "something went
 * wrong" and never a raw provider status code.
 */
function subscribeNote(outcome: TaskVerification["outcome"]): string | undefined {
  switch (outcome) {
    case "VERIFIED":
      return undefined;
    case "NOT_VERIFIED":
      return "اشتراک این کانال تأیید نشد. کانال را سابسکرایب کنید و دوباره بررسی بزنید.";
    case "TEMPORARY_ERROR":
      return "یوتیوب در این لحظه پاسخ نداد. این مورد ناموفق ثبت نشد؛ چند لحظه بعد دوباره بررسی کنید.";
    case "REAUTH_REQUIRED":
      return "دسترسی حساب یوتیوب شما منقضی یا لغو شده است. برای بررسی، حساب را دوباره متصل کنید.";
    default:
      return "برای بررسی خودکار اشتراک باید حساب یوتیوب خود را متصل کنید.";
  }
}

function likeNote(outcome: TaskVerification["outcome"]): string | undefined {
  switch (outcome) {
    case "VERIFIED":
      return undefined;
    case "NOT_VERIFIED":
      return "لایک این ویدیو تأیید نشد. ویدیو را لایک کنید و دوباره بررسی بزنید.";
    case "TEMPORARY_ERROR":
      return "یوتیوب در این لحظه پاسخ نداد. این مورد ناموفق ثبت نشد؛ چند لحظه بعد دوباره بررسی کنید.";
    case "REAUTH_REQUIRED":
      return "دسترسی حساب یوتیوب شما منقضی یا لغو شده است. برای بررسی، حساب را دوباره متصل کنید.";
    default:
      return "برای بررسی خودکار لایک باید حساب یوتیوب خود را متصل کنید.";
  }
}

/* ------------------------------------------------------------------------- */
/* Completion                                                                 */
/* ------------------------------------------------------------------------- */

export type CompleteSupportResult = {
  status: "COMPLETED" | "PENDING_REVIEW" | "DENIED";
  supportId: string | null;
  rewards: { credits: number; xp: number };
  /** Component-by-component explanation of the reward actually paid. */
  breakdown: { label: string; credits: number; xp: number }[];
  mutual: boolean;
  multiplier: number;
  reputation: { before: number; after: number };
  level: { before: number; after: number };
  badges: { code: string; name: string; icon: string }[];
  riskScore: number;
  message: string;
};

/**
 * Finalizes a session: re-checks eligibility, requires every mandatory task to
 * be satisfied, scores abuse risk, then pays (or holds, or denies) the reward.
 *
 * Concurrency: capacity and budget are enforced with conditional atomic UPDATEs
 * inside a Serializable transaction, and the unique index on
 * (supporterId, receiverId, campaignId) is the final duplicate guard.
 */
export async function completeSupportSession(input: {
  sessionId: string;
  supporterId: string;
}): Promise<CompleteSupportResult> {
  const MAX_ATTEMPTS = 4;
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await runCompletion(input);
      // Side effects only after the transaction has committed.
      if (result.notification) await deliverNotification(result.notification);
      return result.payload;
    } catch (e) {
      lastError = e;
      const serializationConflict =
        (e as Prisma.PrismaClientKnownRequestError)?.code === "P2034" ||
        (e instanceof Error && /could not serialize|deadlock detected/i.test(e.message));
      if (serializationConflict && attempt < MAX_ATTEMPTS) {
        // Bounded exponential backoff with jitter, so a burst doesn't resonate.
        const delay = 40 * 2 ** (attempt - 1) + Math.floor(Math.random() * 40);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw e;
    }
  }
  throw lastError;
}

async function runCompletion(input: { sessionId: string; supporterId: string }) {
  return prisma.$transaction(
    async (tx) => {
      const session = await tx.supportSession.findUnique({
        where: { id: input.sessionId },
        include: {
          tasks: true,
          watchSession: true,
          campaign: true,
          supporter: { select: { id: true, username: true, name: true, avatarUrl: true, reputation: true, level: true } },
        },
      });

      if (!session || session.supporterId !== input.supporterId) throw ruleError("SESSION_NOT_FOUND");
      if (session.state === "COMPLETED" && session.supportId) {
        // Idempotent replay of a completed session: return the same answer rather
        // than paying again. This is the second line of defence — the ledger's
        // unique idempotency keys are the first.
        const support = await tx.support.findUniqueOrThrow({ where: { id: session.supportId } });
        return {
          payload: {
            status: "COMPLETED" as const,
            supportId: support.id,
            rewards: { credits: support.creditsAwarded, xp: support.xpAwarded },
            breakdown: [],
            mutual: support.mutual,
            multiplier: 1,
            reputation: { before: session.supporter.reputation, after: session.supporter.reputation },
            level: { before: session.supporter.level, after: session.supporter.level },
            badges: [],
            riskScore: session.riskScore,
            message: "این حمایت قبلاً ثبت شده است.",
          },
          notification: null,
        };
      }
      if (isTerminal(session.state)) throw ruleError("SESSION_CLOSED");
      if (session.expiresAt < new Date()) {
        await tx.supportSession.update({ where: { id: session.id }, data: { state: "EXPIRED" } });
        throw ruleError("SESSION_EXPIRED");
      }

      // Re-verify eligibility: the campaign may have been paused/filled while
      // the supporter was watching.
      const { campaign } = await assertEligible(tx, { supporterId: input.supporterId, campaignId: session.campaignId });

      const requiredTasks = session.tasks.filter((task) => task.required);
      const unmet = requiredTasks.filter((task) => task.state !== "SATISFIED");
      if (unmet.length > 0) {
        await tx.supportSession.update({
          where: { id: session.id },
          data: { state: "FAILED", failedAt: new Date(), failureCode: "REQUIRED_TASK_INCOMPLETE" },
        });
        await tx.user.update({ where: { id: input.supporterId }, data: { supportsAbandoned: { increment: 1 } } });
        throw ruleError("REQUIRED_TASK_INCOMPLETE");
      }

      // ---- Risk assessment -------------------------------------------------
      const watch = session.watchSession;
      const elapsedSeconds = (Date.now() - session.startedAt.getTime()) / 1000;

      // Real-time floor: even a client that spoofs positions perfectly cannot
      // compress wall-clock time. A ten-minute requirement cannot be met in
      // twenty seconds, whatever the segments say.
      if (watch && watch.requiredSec > 0) {
        const floor = minimumElapsedSeconds(watch.requiredSec, WATCH_RULES.maxPlaybackRate);
        if (elapsedSeconds < floor) {
          await tx.supportSession.update({
            where: { id: session.id },
            data: { state: "FAILED", rewardState: "DENIED", failedAt: new Date(), failureCode: "IMPOSSIBLE_TIMELINE" },
          });
          await persistAbuseSignals(tx, {
            userId: input.supporterId,
            sessionId: session.id,
            reasons: [
              {
                type: "IMPOSSIBLE_WATCH_SPEED",
                severity: 10,
                note: `session completed in ${Math.round(elapsedSeconds)}s, floor is ${Math.round(floor)}s`,
              },
            ],
          });
          throw ruleError("IMPOSSIBLE_TIMELINE");
        }
      }

      const evidenceReasons: RiskReason[] = watch
        ? assessSessionEvidence({
            elapsedSeconds,
            watchedSeconds: watch.accumulatedSec,
            requiredSeconds: watch.requiredSec,
            seekCount: watch.seekCount,
            heartbeats: watch.heartbeats,
            rejectedBeats: watch.rejectedBeats,
            hiddenSeconds: watch.hiddenSec,
            impossibleProgressEvents: await tx.abuseSignal.count({
              where: { sessionId: session.id, type: "CLIENT_TAMPERING" },
            }),
          })
        : [];

      const graphAssessment = await assessSupportRisk(tx, {
        supporterId: input.supporterId,
        receiverId: session.creatorId,
        ipHash: session.ipHash,
      });

      const combined = scoreFromReasons([...evidenceReasons, ...graphAssessment.reasons]);
      await persistAbuseSignals(tx, { userId: input.supporterId, sessionId: session.id, reasons: combined.reasons });

      await tx.supportSession.update({
        where: { id: session.id },
        data: {
          riskScore: combined.score,
          riskReasons: combined.reasons as unknown as Prisma.InputJsonValue,
        },
      });

      if (combined.decision === "DENY") {
        await tx.supportSession.update({
          where: { id: session.id },
          data: { state: "FAILED", rewardState: "DENIED", failedAt: new Date(), failureCode: "RISK_DENIED" },
        });
        await recordReputation(tx, {
          userId: input.supporterId,
          type: "ABUSE_SIGNAL",
          delta: REPUTATION.ABUSE_SIGNAL,
          idempotencyKey: ledgerKey(["risk-deny", session.id]),
          sessionId: session.id,
          reason: "risk score above deny threshold",
        });
        throw ruleError("RISK_DENIED");
      }

      // ---- Pair history & settlement ---------------------------------------
      const pair = await tx.supportPair.findUnique({
        where: { supporterId_receiverId: { supporterId: input.supporterId, receiverId: session.creatorId } },
      });
      const reversePair = await tx.supportPair.findUnique({
        where: { supporterId_receiverId: { supporterId: session.creatorId, receiverId: input.supporterId } },
      });

      const priorPairSupports = pair?.supportCount ?? 0;
      const mutual = (reversePair?.supportCount ?? 0) > 0;
      const firstMutualForPair = mutual && (pair?.reciprocalCount ?? 0) === 0;

      // One canonical settlement, computed once. Campaign reward is the base for
      // required tasks; only satisfied OPTIONAL tasks add a bonus. See reward.ts
      // for why two parallel reward models were collapsed into one.
      const campaignTaskConfig = await tx.campaignTask.findMany({
        where: { campaignId: campaign.id },
        select: { type: true, required: true, rewardCredits: true, rewardXp: true },
      });
      const configByType = new Map(campaignTaskConfig.map((task) => [task.type, task]));

      const settlement = computeSettlement({
        baseCredits: campaign.rewardCredits || REWARDS.SUPPORT_COMPLETED.credits,
        baseXp: campaign.rewardXp || REWARDS.SUPPORT_COMPLETED.xp,
        tasks: session.tasks.map((task) => {
          const config = configByType.get(task.type);
          const fallback = defaultTaskBonus(task.type, task.required);
          return {
            type: task.type,
            required: task.required,
            satisfied: task.state === "SATISFIED",
            rewardCredits: config?.rewardCredits || fallback.credits,
            rewardXp: config?.rewardXp || fallback.xp,
          };
        }),
        priorPairSupports,
        mutual,
        firstMutualForPair,
      });

      const multiplier = settlement.multiplier;

      // ---- Campaign eligibility reservation -------------------------------
      // Budget, lifetime capacity and the UTC-day limit are claimed by one row
      // update. Any later failure rolls all counters back with this transaction.
      const reserved = await tx.$queryRaw<Array<{ id: string }>>`
        UPDATE "Campaign"
        SET "spentCredits" = "spentCredits" + ${settlement.budgetCost},
            "completedSupports" = "completedSupports" + 1,
            "dailySupports" = CASE
              WHEN "dailyCounterDay" = CURRENT_DATE THEN "dailySupports" + 1
              ELSE 1
            END,
            "dailyCounterDay" = CURRENT_DATE
        WHERE "id" = ${campaign.id}
          AND "status" = 'ACTIVE'::"CampaignStatus"
          AND "startAt" <= NOW()
          AND "endAt" >= NOW()
          AND "spentCredits" + ${settlement.budgetCost} <= "budgetCredits"
          AND ("maxTotalSupports" IS NULL OR "completedSupports" < "maxTotalSupports")
          AND (
            "dailyLimit" IS NULL OR
            "dailyCounterDay" < CURRENT_DATE OR
            "dailySupports" < "dailyLimit"
          )
        RETURNING "id";
      `;
      if (reserved.length === 0) {
        const latest = await tx.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
        const today = new Date().toISOString().slice(0, 10);
        const marker = latest.dailyCounterDay.toISOString().slice(0, 10);
        if (latest.spentCredits + settlement.budgetCost > latest.budgetCredits) {
          throw ruleError("CAMPAIGN_BUDGET_EXHAUSTED");
        }
        if (latest.maxTotalSupports !== null && latest.completedSupports >= latest.maxTotalSupports) {
          throw ruleError("CAMPAIGN_FULL");
        }
        if (latest.dailyLimit !== null && marker === today && latest.dailySupports >= latest.dailyLimit) {
          throw ruleError("DAILY_LIMIT");
        }
        throw ruleError("CAMPAIGN_INACTIVE");
      }

      // ---- Create the Support record --------------------------------------
      const support = await tx.support.create({
        data: {
          supporterId: input.supporterId,
          receiverId: session.creatorId,
          campaignId: campaign.id,
          videoId: session.videoId,
          creditsAwarded: settlement.totalCredits,
          xpAwarded: settlement.totalXp,
          mutual,
        },
      });

      const targetRewardState = combined.decision === "REVIEW" ? "PENDING_REVIEW" : "CONFIRMED";
      assertRewardTransition(session.rewardState, targetRewardState);

      await tx.supportSession.update({
        where: { id: session.id },
        data: {
          state: "COMPLETED",
          completedAt: new Date(),
          supportId: support.id,
          rewardState: targetRewardState,
        },
      });

      // ---- Pair counters ---------------------------------------------------
      await tx.supportPair.upsert({
        where: { supporterId_receiverId: { supporterId: input.supporterId, receiverId: session.creatorId } },
        update: { supportCount: { increment: 1 }, lastSupportAt: new Date() },
        create: { supporterId: input.supporterId, receiverId: session.creatorId, supportCount: 1 },
      });
      if (mutual) {
        await tx.supportPair.update({
          where: { supporterId_receiverId: { supporterId: session.creatorId, receiverId: input.supporterId } },
          data: { reciprocalCount: { increment: 1 } },
        });
      }

      await tx.user.update({
        where: { id: input.supporterId },
        data: { supportsCompleted: { increment: 1 }, lastActiveAt: new Date() },
      });

      // ---- Rewards ---------------------------------------------------------
      // Held rewards are recorded as PENDING_REVIEW and paid by a moderator, so
      // the user is told the truth ("under verification") instead of being
      // silently shadow-banned.
      const pay = combined.decision === "ALLOW";
      let creditsPaid = 0;
      let xpPaid = 0;
      let levelAfter = session.supporter.level;

      if (pay) {
        // One ledger entry per settlement component, each with its own
        // idempotency key — so a retry can never pay a component twice, and a
        // reversal can undo them individually.
        await recordCredit(tx, {
          userId: input.supporterId,
          type: "SUPPORT_COMPLETED",
          amount: settlement.base.credits,
          idempotencyKey: ledgerKey(["support-credits", session.id]),
          sessionId: session.id,
          campaignId: campaign.id,
          supportId: support.id,
          reason: multiplier < 1 ? `diminished x${multiplier}` : undefined,
          metadata: { multiplier, priorPairSupports },
        });
        const xpResult = await recordXp(tx, {
          userId: input.supporterId,
          type: "SUPPORT_COMPLETED",
          amount: settlement.base.xp,
          idempotencyKey: ledgerKey(["support-xp", session.id]),
          sessionId: session.id,
          supportId: support.id,
        });
        levelAfter = xpResult.level;
        creditsPaid += settlement.base.credits;
        xpPaid += settlement.base.xp;

        // Optional-task bonuses. Keyed by task type, so adding a second optional
        // task later cannot collide with an existing entry.
        for (const bonus of settlement.taskBonuses) {
          await recordCredit(tx, {
            userId: input.supporterId,
            type: "CAMPAIGN_BONUS",
            amount: bonus.credits,
            idempotencyKey: ledgerKey(["task-credits", session.id, bonus.key]),
            sessionId: session.id,
            campaignId: campaign.id,
            supportId: support.id,
            reason: bonus.label,
          });
          const bonusXp = await recordXp(tx, {
            userId: input.supporterId,
            type: "SUPPORT_COMPLETED",
            amount: bonus.xp,
            idempotencyKey: ledgerKey(["task-xp", session.id, bonus.key]),
            sessionId: session.id,
            supportId: support.id,
          });
          if (bonusXp.applied) levelAfter = bonusXp.level;
          creditsPaid += bonus.credits;
          xpPaid += bonus.xp;
        }

        if (settlement.mutualBonus) {
          await recordCredit(tx, {
            userId: input.supporterId,
            type: "MUTUAL_BONUS",
            amount: settlement.mutualBonus.credits,
            idempotencyKey: ledgerKey(["mutual-credits", session.id]),
            sessionId: session.id,
            supportId: support.id,
          });
          const mutualXpResult = await recordXp(tx, {
            userId: input.supporterId,
            type: "MUTUAL_BONUS",
            amount: settlement.mutualBonus.xp,
            idempotencyKey: ledgerKey(["mutual-xp", session.id]),
            sessionId: session.id,
            supportId: support.id,
          });
          if (mutualXpResult.applied) levelAfter = mutualXpResult.level;
          creditsPaid += settlement.mutualBonus.credits;
          xpPaid += settlement.mutualBonus.xp;
        }

        // Creator side. Platform-funded, so it does not draw on the campaign
        // budget the creator themselves paid for.
        await recordCredit(tx, {
          userId: session.creatorId,
          type: "SUPPORT_RECEIVED",
          amount: settlement.creatorCredits,
          idempotencyKey: ledgerKey(["received-credits", session.id]),
          sessionId: session.id,
          supportId: support.id,
        });
        await recordXp(tx, {
          userId: session.creatorId,
          type: "SUPPORT_RECEIVED",
          amount: settlement.creatorXp,
          idempotencyKey: ledgerKey(["received-xp", session.id]),
          sessionId: session.id,
          supportId: support.id,
        });
      }

      // ---- Reputation ------------------------------------------------------
      const reputationResult = await recordReputation(tx, {
        userId: input.supporterId,
        type: "SUPPORT_VERIFIED",
        delta: pay ? REPUTATION.SUPPORT_VERIFIED : 0,
        idempotencyKey: ledgerKey(["support-reputation", session.id]),
        sessionId: session.id,
      });

      // ---- Streak, referral, badges ---------------------------------------
      await registerStreakDay(tx, input.supporterId);
      await creditReferralIfEligible(tx, input.supporterId, session.id);
      const badges = pay ? await evaluateBadges(tx, input.supporterId) : [];
      if (pay) await evaluateBadges(tx, session.creatorId);

      // ---- Activity + notification ----------------------------------------
      await tx.activity.createMany({
        data: [
          {
            userId: input.supporterId,
            actorId: input.supporterId,
            type: "SUPPORT_CREATED",
            targetId: support.id,
            metadata: { receiverId: session.creatorId, credits: creditsPaid },
          },
          {
            userId: session.creatorId,
            actorId: input.supporterId,
            type: mutual ? "MUTUAL_SUPPORT" : "SUPPORT_RECEIVED",
            targetId: support.id,
          },
        ],
      });

      const notification = pay
        ? await createNotificationTx(tx, {
            userId: session.creatorId,
            actorId: input.supporterId,
            type: mutual ? "SUPPORT_MUTUAL" : "SUPPORT_RECEIVED",
            title: mutual ? "حمایت متقابل کامل شد 🎉" : "حمایت جدید دریافت کردید",
            message: `${session.supporter.name} حمایت تأییدشده‌ای برای شما ثبت کرد.`,
            metadata: { supportId: support.id, campaignId: campaign.id, mutual },
            dedupeKey: ledgerKey(["support-notification", session.id]),
          })
        : await createNotificationTx(tx, {
            userId: input.supporterId,
            type: "REWARD_PENDING",
            title: "حمایت در حال بررسی است",
            message: "این حمایت برای بررسی نهایی علامت‌گذاری شد و پاداش آن موقتاً در انتظار است.",
            metadata: { sessionId: session.id, riskScore: combined.score },
            dedupeKey: ledgerKey(["support-pending", session.id]),
          });

      await writeAuditTx(tx, {
        userId: input.supporterId,
        action: "SUPPORT",
        entity: "SupportSession",
        entityId: session.id,
        metadata: {
          supportId: support.id,
          decision: combined.decision,
          riskScore: combined.score,
          credits: creditsPaid,
          xp: xpPaid,
          // The full component breakdown, so a reward can be explained after the
          // fact without recomputing it from possibly-changed config.
          breakdown: settlementBreakdown(settlement).map((part) => ({
            key: part.key,
            credits: part.credits,
            xp: part.xp,
          })),
        },
      });

      return {
        payload: {
          status: (pay ? "COMPLETED" : "PENDING_REVIEW") as "COMPLETED" | "PENDING_REVIEW",
          supportId: support.id,
          rewards: { credits: creditsPaid, xp: xpPaid },
          breakdown: settlementBreakdown(settlement).map((part) => ({
            label: part.label,
            credits: part.credits,
            xp: part.xp,
          })),
          mutual,
          multiplier,
          reputation: { before: session.supporter.reputation, after: reputationResult.valueAfter },
          level: { before: session.supporter.level, after: levelAfter },
          badges: badges.map((b) => ({ code: b.code, name: b.name, icon: b.icon })),
          riskScore: combined.score,
          message: pay
            ? "حمایت شما تأیید و ثبت شد."
            : "این حمایت در حال بررسی است؛ پاداش پس از تأیید اعمال می‌شود.",
        },
        notification: notification
          ? {
              ...notification,
              actor: { id: session.supporter.id, username: session.supporter.username, name: session.supporter.name, avatarUrl: session.supporter.avatarUrl },
            }
          : null,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5000, timeout: 20000 }
  );
}

/**
 * Pays the referral bonus once the referred user has completed a real support —
 * not at signup, which is what made throwaway-account farming profitable.
 * `creditedAt` + a conditional updateMany make the payout idempotent.
 */
async function creditReferralIfEligible(tx: Tx, referredUserId: string, sessionId: string) {
  const referral = await tx.referral.findUnique({ where: { referredId: referredUserId } });
  if (!referral || referral.creditedAt) return;
  if (referral.referrerId === referredUserId) return; // Defensive: self-referral.

  const claim = await tx.referral.updateMany({
    where: { id: referral.id, creditedAt: null },
    data: { creditedAt: new Date() },
  });
  if (claim.count === 0) return;

  const referrer = await tx.user.findUnique({ where: { id: referral.referrerId }, select: { status: true } });
  if (!referrer || referrer.status !== "ACTIVE") return;

  await recordCredit(tx, {
    userId: referral.referrerId,
    type: "REFERRAL",
    amount: REWARDS.REFERRAL.credits,
    idempotencyKey: ledgerKey(["referral-credits", referral.id]),
    sessionId,
    reason: "referral first verified support",
  });
  await recordXp(tx, {
    userId: referral.referrerId,
    type: "REFERRAL",
    amount: REWARDS.REFERRAL.xp,
    idempotencyKey: ledgerKey(["referral-xp", referral.id]),
    sessionId,
  });
  await createNotificationTx(tx, {
    userId: referral.referrerId,
    type: "SYSTEM",
    title: "پاداش دعوت دریافت شد 🎁",
    message: `کاربری که با کد دعوت شما ثبت‌نام کرد اولین حمایت تأییدشده‌اش را کامل کرد و ${REWARDS.REFERRAL.credits} اعتبار به شما اضافه شد.`,
    metadata: { referralId: referral.id },
    dedupeKey: ledgerKey(["referral-notification", referral.id]),
  });
}

/* ------------------------------------------------------------------------- */
/* Reversal                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Reverses a support: flips its status, reverses EVERY ledger entry tied to its
 * session (credits and XP, on both sides), applies a reputation penalty, and
 * recalculates the cached counters.
 *
 * Reversal strategy, stated explicitly per dependent concept:
 *
 *   Credits      reversed via mirrored ledger entries. Never `credits -= x`.
 *   XP           reversed the same way; the level is recomputed from the new total.
 *   Reputation   a penalty event, larger than the original gain — so a reversed
 *                support leaves the user worse off than never having done it.
 *   Leaderboard  derived from the ledger, so it corrects itself on the next read
 *                or snapshot. Nothing to undo by hand.
 *   Streak       deliberately NOT rolled back. A streak records that the user was
 *                active that day, which remains true; retroactively breaking a
 *                30-day streak over one reversed support is punishment out of
 *                proportion, and it would also corrupt already-awarded badges.
 *   Badges       kept. They are historical awards, and their credits are already
 *                in the ledger; revoking them would need its own reversal chain
 *                for a marginal gain. Future evaluations use the corrected
 *                counters, so a badge cannot be re-earned on reversed activity.
 *   Exposure     trustScore is recomputed, which lowers Explore ranking — the
 *                effective consequence for the creator side.
 *   Budget       returned to the campaign, so a reversed reward does not
 *                permanently consume the creator's budget.
 */
export async function reverseSupport(input: {
  supportId: string;
  moderatorId: string;
  reason: string;
}) {
  const result = await prisma.$transaction(async (tx) => {
    const support = await tx.support.findUnique({
      where: { id: input.supportId },
      include: { session: { select: { id: true, rewardState: true } } },
    });
    if (!support) throw new NotFoundError("این حمایت پیدا نشد.");
    if (support.status === "REVERSED") throw new ConflictError("این حمایت قبلاً برگشت خورده است.");

    await tx.support.update({
      where: { id: support.id },
      data: {
        status: "REVERSED",
        reversedAt: new Date(),
        reversedById: input.moderatorId,
        reversalReason: input.reason.slice(0, 500),
      },
    });

    if (support.session) {
      // The state machine refuses REVERSED → CONFIRMED, so this cannot later be
      // silently re-paid.
      assertRewardTransition(support.session.rewardState, "REVERSED");
      await reverseSessionLedger(tx, support.session.id, `support reversed: ${input.reason.slice(0, 120)}`);
      await tx.supportSession.update({
        where: { id: support.session.id },
        data: { rewardState: "REVERSED" },
      });
    }

    await recordReputation(tx, {
      userId: support.supporterId,
      type: "SUPPORT_REVERSED",
      delta: REPUTATION.SUPPORT_REVERSED,
      idempotencyKey: ledgerKey(["reversal-reputation", support.id]),
      sessionId: support.session?.id ?? null,
      reason: input.reason.slice(0, 200),
    });

    await tx.user.update({
      where: { id: support.supporterId },
      data: { supportsCompleted: { decrement: 1 } },
    });

    if (support.mutual) {
      await tx.supportPair
        .update({
          where: { supporterId_receiverId: { supporterId: support.receiverId, receiverId: support.supporterId } },
          data: { reciprocalCount: { decrement: 1 } },
        })
        .catch(() => null);
    }
    await tx.supportPair
      .update({
        where: { supporterId_receiverId: { supporterId: support.supporterId, receiverId: support.receiverId } },
        data: { supportCount: { decrement: 1 } },
      })
      .catch(() => null);

    // Return the campaign budget so a reversed reward doesn't permanently
    // consume the creator's budget. Clamped at zero: a manual adjustment
    // elsewhere must never be able to drive `spentCredits` negative.
    if (support.creditsAwarded > 0) {
      await tx.$executeRaw`
        UPDATE "Campaign"
        SET "spentCredits" = GREATEST(0, "spentCredits" - ${support.creditsAwarded})
        WHERE "id" = ${support.campaignId};
      `;
    }

    await tx.activity.create({
      data: {
        userId: support.supporterId,
        actorId: input.moderatorId,
        type: "SUPPORT_REVERSED",
        targetId: support.id,
        metadata: { reason: input.reason.slice(0, 200) },
      },
    });

    const notification = await createNotificationTx(tx, {
      userId: support.supporterId,
      type: "SUPPORT_REVERSED",
      title: "یک حمایت شما برگشت خورد",
      message: `دلیل: ${input.reason.slice(0, 160)}`,
      metadata: { supportId: support.id },
      dedupeKey: ledgerKey(["reversal-notification", support.id]),
    });

    await writeAuditTx(tx, {
      userId: input.moderatorId,
      action: "SUPPORT_REVERSAL",
      entity: "Support",
      entityId: support.id,
      metadata: { reason: input.reason.slice(0, 200), supporterId: support.supporterId },
    });

    return { support, notification };
  });

  if (result.notification) {
    await deliverNotification({ ...result.notification, actor: null });
  }
  return result.support;
}

/**
 * Marks sessions that stopped sending heartbeats as abandoned, which both frees
 * the "one open session" slot and feeds the completion-rate metric honestly.
 */
export async function expireStaleSessions() {
  const staleBefore = new Date(Date.now() - WATCH_RULES.staleAfterSeconds * 1000);
  const now = new Date();

  const stale = await prisma.supportSession.findMany({
    where: {
      state: { in: ["STARTED", "VIDEO_OPENED", "WATCHING", "WATCH_THRESHOLD_REACHED", "VERIFYING"] },
      OR: [{ expiresAt: { lt: now } }, { watchSession: { lastHeartbeatAt: { lt: staleBefore } } }],
    },
    select: { id: true, supporterId: true, expiresAt: true },
    take: 500,
  });
  if (stale.length === 0) return 0;

  await prisma.$transaction(async (tx) => {
    for (const session of stale) {
      await tx.supportSession.update({
        where: { id: session.id },
        data: {
          state: session.expiresAt < now ? "EXPIRED" : "ABANDONED",
          failedAt: now,
          failureCode: session.expiresAt < now ? "EXPIRED" : "ABANDONED",
        },
      });
      await tx.user.update({ where: { id: session.supporterId }, data: { supportsAbandoned: { increment: 1 } } });
    }
  });

  logger.info("expired stale support sessions", { count: stale.length });
  return stale.length;
}


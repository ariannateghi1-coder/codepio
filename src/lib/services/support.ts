import "server-only";
import { Prisma, type SupportSession, type VerificationMethod } from "@prisma/client";
import { prisma } from "../prisma";
import { logger } from "../logger";
import { BusinessRuleError, ConflictError, NotFoundError, internalMessage } from "../errors";
import { REWARDS, TASK_REWARDS, WATCH_RULES } from "../gamification";
import {
  compensateMissingXp,
  ledgerKey,
  recordCredit,
  recordReputation,
  recordXp,
  reverseSessionLedger,
} from "./ledger";
import { REPUTATION } from "../gamification";
import { assessSessionEvidence, assessSupportRisk, persistAbuseSignals, scoreFromReasons, type RiskReason } from "./anti-abuse";
import {
  creditedWatchSeconds,
  isTimerSatisfied,
  remainingWatchSeconds,
  requiredWatchSeconds,
  watchPercent,
} from "./watch";
import { assertRewardTransition, isTerminal, nextState } from "./support-state";
import { computeSettlement, defaultTaskBonus, settlementBreakdown } from "./reward";
import { checkComment, checkLike, checkSubscription, fetchVideoMetadata } from "./youtube-api";
import { assertCompliant, recordComplianceObligation } from "./subscription-compliance";
import { createNotificationTx, deliverNotification } from "./notifications";
import { campaignAvailabilityFailure } from "./campaign-eligibility";
import { evaluateBadges } from "./badges";
import { registerStreakDay } from "./streak";
import { writeAuditTx } from "../audit";
import { youtubeWatchUrl } from "../youtube";

/**
 * Support Exchange core service.
 *
 * The product loop, enforced end-to-end:
 *   start → open on YouTube (server-timed) → subscribe/like (YouTube API) →
 *   optional comment → risk assessment → reward (instant / pending / denied)
 *
 * WATCH MODEL — stated plainly because it is weaker than it looks:
 *   The video is opened on youtube.com, not embedded, so there is no player to
 *   observe. Completion is decided by elapsed SERVER time since the first open:
 *   `WatchSession.openedAt` is stamped once and never moved, and the requirement
 *   is ceil(durationSec * WATCH_RULES.defaultRequiredPercent / 100). We do not
 *   claim YouTube reported the watch. The client supplies no time, no position
 *   and no completion flag, so there is nothing in the request to forge; what it
 *   cannot prove is that a human was watching during those seconds.
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
  VIDEO_NOT_OPENED: "ابتدا ویدیو را در یوتیوب باز کنید تا زمان تماشا شروع شود.",
  VIDEO_DURATION_UNKNOWN: "مدت‌زمان این ویدیو از یوتیوب دریافت نشده است؛ تا همگام‌سازی، تماشا قابل ثبت نیست.",
  SESSION_CLOSED: "این نشست حمایت بسته شده است.",
  SESSION_EXPIRED: "زمان این نشست حمایت به پایان رسیده است.",
  WATCH_INCOMPLETE: "تماشای ویدیو کامل نشده است.",
  IMPOSSIBLE_TIMELINE: "زمان سپری‌شده با میزان تماشای گزارش‌شده هم‌خوانی ندارد.",
  REQUIRED_TASK_INCOMPLETE: "همه کارهای الزامی انجام نشده‌اند.",
  RISK_DENIED: "این حمایت به دلیل رفتار مشکوک تأیید نشد.",
  SUBSCRIPTION_COMPLIANCE_VIOLATED:
    "برای ادامه فعالیت، باید اشتراک کانال‌هایی که بابت آن‌ها حمایت دریافت کرده‌اید را حفظ کنید. ابتدا دوباره کانال را سابسکرایب کنید و سپس بررسی مجدد را انجام دهید.",
  ALREADY_SUPPORTED_PAIR: "در بازه خنک‌سازی این سازنده هستید.",
};

/**
 * Human remaining time, e.g. «۳ دقیقه و ۲۰ ثانیه». Persian digits come from the
 * client formatter; this builds the structure only.
 */
function formatRemaining(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(s / 60);
  const seconds = s % 60;
  if (minutes > 0 && seconds > 0) return `حدود ${minutes} دقیقه و ${seconds} ثانیه`;
  if (minutes > 0) return `حدود ${minutes} دقیقه`;
  return `${seconds} ثانیه`;
}

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
      video: {
        select: {
          id: true,
          status: true,
          youtubeVideoId: true,
          durationSec: true,
          userId: true,
          // The subscribe target, so the flow can NAME the channel to subscribe to
          // instead of just saying "subscribe".
          channelId: true,
          channelTitle: true,
        },
      },
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
    maxTotalSupports: campaign.maxTotalSupports,
    dailyLimit: campaign.dailyLimit,
    totalSupports,
    dailySupports,
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
  /**
   * The channel the supporter must subscribe to, named explicitly.
   *
   * "Subscribe to the channel" is not actionable when the video opens in the
   * YouTube app and the user has more than one account: they cannot tell which
   * channel we will check, or on which account. Naming it here is what makes the
   * subscribe task followable.
   */
  targetChannel: { id: string; title: string | null; url: string } | null;
  requiredWatchSeconds: number;
  /** Null until the supporter opens the video; the timer runs from this instant. */
  openedAt: Date | null;
  /** Seconds still to elapse. Equals requiredWatchSeconds before the first open. */
  remainingSeconds: number;
  tasks: { type: string; required: boolean; rewardXp: number }[];
  estimatedSeconds: number;
};

export async function startSupportSession(input: StartSupportInput): Promise<StartSupportResult> {
  // Subscription compliance is checked BEFORE the transaction opens, never inside
  // it. The check can reach YouTube, and this transaction also runs the whole
  // eligibility pass — holding it open across an 8-second provider timeout would
  // tie up a pooled connection for the duration. Same sequencing as
  // verifySessionTasks: talk to the provider first, then write.
  //
  // Placed at the very start so a blocked user is refused before any row is
  // created, and the error they get names the actual reason.
  await assertCompliant(input.supporterId);

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
    // Derived server-side from the duration YouTube reported, using the platform
    // constant. The campaign cannot lower it and the client cannot send it.
    const requiredSec = durationSec > 0 ? requiredWatchSeconds(durationSec, WATCH_RULES.defaultRequiredPercent) : 0;

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
            rewardCredits: 0,
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

    // Reusing an open session must also reuse its anchor, so re-entering the flow
    // shows the time already served instead of silently restarting the timer.
    const existingWatch = open
      ? await tx.watchSession.findUnique({ where: { sessionId: session.id }, select: { openedAt: true } })
      : null;
    const openedAt = existingWatch?.openedAt ?? null;

    return {
      session,
      video: { id: video.id, youtubeVideoId: video.youtubeVideoId, durationSec: video.durationSec },
      targetChannel: video.channelId
        ? {
            id: video.channelId,
            title: video.channelTitle,
            url: `https://www.youtube.com/channel/${video.channelId}?sub_confirmation=1`,
          }
        : null,
      requiredWatchSeconds: requiredSec,
      openedAt,
      remainingSeconds: remainingWatchSeconds(openedAt, requiredSec),
      // Credits are not per-task: the support pays one fixed transfer, so the
      // client is told the XP bonus per task and the transfer separately.
      tasks: tasks.map((task) => ({
        type: task.type,
        required: task.required,
        rewardXp: task.rewardXp,
      })),
      estimatedSeconds: requiredSec + 60,
    };
  });
}

/* ------------------------------------------------------------------------- */
/* Watch timer                                                                */
/* ------------------------------------------------------------------------- */

export type WatchTimerResult = {
  /** Canonical youtube.com watch URL. The client opens this, we do not embed it. */
  watchUrl: string;
  requiredSec: number;
  /** Whole seconds still to elapse. 0 once the requirement is met. */
  remainingSec: number;
  /** Seconds credited so far, capped at requiredSec. */
  elapsedSec: number;
  percent: number;
  satisfied: boolean;
  openedAt: Date;
  state: SupportSession["state"];
};

/**
 * Loads a session for the watch timer, enforcing ownership and liveness.
 *
 * Ownership is checked here rather than in the route: a session id is not a
 * capability, so another user holding the id gets SESSION_NOT_FOUND.
 */
async function loadLiveSession(tx: Tx, sessionId: string, supporterId: string) {
  const session = await tx.supportSession.findUnique({
    where: { id: sessionId },
    include: { watchSession: true, video: { select: { youtubeVideoId: true } } },
  });

  if (!session || session.supporterId !== supporterId) throw ruleError("SESSION_NOT_FOUND");
  if (!session.watchSession) throw ruleError("SESSION_NOT_FOUND");
  if (session.expiresAt < new Date()) {
    await tx.supportSession.update({ where: { id: session.id }, data: { state: "EXPIRED" } });
    throw ruleError("SESSION_EXPIRED");
  }
  if (isTerminal(session.state)) throw ruleError("SESSION_CLOSED");
  return session;
}

/**
 * Marks the video as opened and starts the timer.
 *
 * IDEMPOTENT BY CONSTRUCTION. `openedAt` is written with a conditional UPDATE
 * (`WHERE "openedAt" IS NULL`) inside a row lock, so refreshing the page,
 * double-clicking, or replaying this request cannot restart the clock, extend it,
 * or run two timers for one session. Every later call returns the SAME anchor and
 * therefore the same remaining time.
 *
 * Progress is not credited here — the timer is read, never accumulated, so there
 * is no counter to inflate by calling this repeatedly.
 */
export async function openWatchTarget(input: { sessionId: string; supporterId: string }): Promise<WatchTimerResult> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT "id" FROM public."WatchSession" WHERE "sessionId" = ${input.sessionId} FOR UPDATE
    `;
    const session = await loadLiveSession(tx, input.sessionId, input.supporterId);
    const watch = session.watchSession!;

    if (!session.video?.youtubeVideoId) throw ruleError("VIDEO_UNAVAILABLE");
    if (watch.requiredSec <= 0) throw ruleError("VIDEO_DURATION_UNKNOWN");

    // First open wins. A concurrent duplicate updates 0 rows and reuses the anchor.
    if (!watch.openedAt) {
      await tx.watchSession.updateMany({
        where: { sessionId: session.id, openedAt: null },
        data: { openedAt: new Date() },
      });
    }

    const fresh = await tx.watchSession.findUniqueOrThrow({ where: { sessionId: session.id } });
    const openedAt = fresh.openedAt!;

    const resolved = nextState(session.state, "VIDEO_OPENED");
    if (resolved !== session.state) {
      await tx.supportSession.update({ where: { id: session.id }, data: { state: resolved } });
    }

    return buildTimerResult(session.video.youtubeVideoId, fresh.requiredSec, fresh.durationSec, openedAt, resolved);
  });
}

/**
 * Reports timer state and, once the requirement is met, satisfies the watch task.
 *
 * Read-then-advance rather than accumulate: the elapsed value is recomputed from
 * the anchor on every call, so the result depends only on server time. Calling
 * this early, often, or never changes nothing except what the user is shown.
 */
export async function watchTimerStatus(input: { sessionId: string; supporterId: string }): Promise<WatchTimerResult> {
  return prisma.$transaction(async (tx) => {
    const session = await loadLiveSession(tx, input.sessionId, input.supporterId);
    const watch = session.watchSession!;
    if (!watch.openedAt) throw ruleError("VIDEO_NOT_OPENED");

    const satisfied = isTimerSatisfied(watch.openedAt, watch.requiredSec);
    let resolved = session.state;

    if (satisfied) {
      const now = new Date();
      // The accounting columns are written only at the moment the requirement is
      // met, and only up to requiredSec, so they can never exceed elapsed real
      // time. completedAt is set once (?? guard) to keep the first crossing.
      await tx.watchSession.update({
        where: { sessionId: session.id },
        data: {
          accumulatedSec: watch.requiredSec,
          completedAt: watch.completedAt ?? now,
        },
      });
      resolved = nextState(session.state, "WATCH_THRESHOLD_REACHED");
      if (resolved !== session.state) {
        await tx.supportSession.update({ where: { id: session.id }, data: { state: resolved } });
      }
      await tx.supportTask.updateMany({
        where: { sessionId: session.id, type: "WATCH_VIDEO", state: { not: "SATISFIED" } },
        data: { state: "SATISFIED", method: "PLATFORM_OBSERVED", satisfiedAt: now },
      });
    }

    return buildTimerResult(
      session.video?.youtubeVideoId ?? "",
      watch.requiredSec,
      watch.durationSec,
      watch.openedAt,
      resolved
    );
  });
}

function buildTimerResult(
  youtubeVideoId: string,
  requiredSec: number,
  durationSec: number,
  openedAt: Date,
  state: SupportSession["state"]
): WatchTimerResult {
  const elapsedSec = creditedWatchSeconds(openedAt, requiredSec);
  return {
    watchUrl: youtubeWatchUrl(youtubeVideoId),
    requiredSec,
    remainingSec: remainingWatchSeconds(openedAt, requiredSec),
    elapsedSec,
    percent: watchPercent(elapsedSec, requiredSec),
    satisfied: isTimerSatisfied(openedAt, requiredSec),
    openedAt,
    state,
  };
}

/* ------------------------------------------------------------------------- */
/* Task verification                                                          */
/* ------------------------------------------------------------------------- */

/**
 * The channel a supporter is asked to subscribe to.
 *
 * THIS IS THE CHANNEL THAT OWNS THE VIDEO, and not the creator's own linked
 * account. The two are usually the same person, but they are not the same fact:
 *
 *   - Video ownership is PUBLIC. `videos.list` names the uploading channel, so
 *     the subscribe target is knowable for every campaign video, with an API key
 *     and no user grant at all.
 *   - A creator's OAuth link is OPTIONAL. Reading the target from
 *     `YoutubeConnection` meant that a creator who had not connected their
 *     account produced `channelId === null`, the SUBSCRIBE_CHANNEL branch was
 *     skipped entirely, and the task fell through to the catch-all that reports
 *     "this task is not configured". Because that verdict is UNAVAILABLE rather
 *     than a definitive no, and a required task with no definitive answer was
 *     written down as FAILED, an honest supporter who really had subscribed was
 *     told they had not — and no amount of re-checking could ever clear it, since
 *     nothing about re-checking makes the creator connect their account.
 *
 * Resolution order, and why:
 *   1. `Video.channelId`, captured from YouTube when the video was registered.
 *   2. A lazy one-off lookup for rows created before that column existed, which
 *      is then persisted so it costs a single unit per video, ever.
 *
 * There is no third step. The creator's linked channel used to serve as a
 * fallback, but it answers a different question — "who registered this campaign?"
 * — and one production row was already wrong because of it, storing a Tech With
 * Tim video as if the registering user owned it.
 *
 * Returning null means we genuinely cannot name a target right now, which the
 * caller must report as "could not check" — never as "you did not subscribe".
 */
async function resolveTargetChannelId(
  video: { id: string; youtubeVideoId: string; channelId: string | null } | null
): Promise<string | null> {
  if (!video) return null;
  if (video.channelId) return video.channelId;

  try {
    const metadata = await fetchVideoMetadata(video.youtubeVideoId);
    if (metadata?.channelId) {
      // Persisted, so the next verification reads it from our own row instead of
      // spending another call — and so the value cannot drift mid-session.
      await prisma.video.update({
        where: { id: video.id },
        data: {
          channelId: metadata.channelId,
          channelTitle: metadata.channelTitle,
          madeForKids: metadata.madeForKids,
        },
      });
      return metadata.channelId;
    }
  } catch (e) {
    logger.warn("could not resolve the owning channel of a campaign video", {
      videoId: video.id,
      error: internalMessage(e),
    });
  }

  // Deliberately NOT falling back to the creator's linked channel. That fallback is
  // a guess about ownership, and when it is wrong the supporter is asked to
  // subscribe to one channel while we inspect another — the exact failure this
  // function exists to prevent. Returning null makes the caller report "could not
  // check", which is honest and recoverable, instead of a confident wrong answer.
  return null;
}

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
      video: { select: { id: true, youtubeVideoId: true, channelId: true, madeForKids: true } },
      campaign: { select: { kidsContent: true } },
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

  // The channel to subscribe to is the one that OWNS the video, not the creator's
  // own linked account. See resolveTargetChannelId() for why that distinction is
  // the whole bug.
  const channelId = await resolveTargetChannelId(session.video);
  const videoId = session.video?.youtubeVideoId ?? null;
  /**
   * The supporter's OWN connected channel.
   *
   * Carried into the failure copy on purpose. A "not verified" verdict is only
   * actionable if the user knows WHICH YouTube account was inspected: with several
   * Google accounts signed in — the browser on one, the YouTube app on another —
   * subscribing on the wrong one produces a real subscription that this check can
   * never see. Saying only "you are not subscribed" sends the user to repeat an
   * action they already performed, on the same wrong account, forever.
   */
  const [supporterConnection, supporterGrant] = await Promise.all([
    prisma.youtubeConnection.findUnique({
      where: { userId: supporterId },
      select: { channelId: true, channelTitle: true },
    }),
    prisma.youtubeAccount.findUnique({ where: { userId: supporterId }, select: { googleEmail: true } }),
  ]);
  const supporterChannelId = supporterConnection?.channelId ?? null;
  // The email is preferred over the channel title in failure copy: people recognise
  // which Google account they are signed into, not which channel it owns.
  const supporterIdentity = supporterGrant?.googleEmail ?? supporterConnection?.channelTitle ?? null;

  /**
   * Is YouTube verification waived for this campaign?
   *
   * True when the creator declared the campaign as kids content, and also when
   * YouTube itself reports the video as "Made for Kids" — the second is a fact we
   * can read, the first covers what we cannot.
   *
   * On this content YouTube switches personalisation off. The like provably never
   * reaches the viewer's own "Liked videos" playlist (a campaign video here has
   * public likes that appear in nobody's list). Subscriptions to such channels are
   * reported the same way by creators, and the API cannot refute it: an absent
   * subscription and one that was never made look identical from the outside.
   *
   * So both are waived rather than judged. The earlier remedy — asking the creator
   * to un-flag their video in YouTube Studio — was wrong: it asked them to
   * misdeclare kids content to YouTube in order to satisfy our checker.
   */
  let verificationWaived = Boolean(session.campaign?.kidsContent || session.video?.madeForKids);

  /**
   * Last line of defence before telling a supporter they did not do something.
   *
   * The waiver above rests on two facts, and BOTH can be false while the campaign is
   * still kids content:
   *
   *   - The creator may simply not have ticked the box. Nothing forces them to, and
   *     they have no reason to know our checker depends on it.
   *   - Our stored `Video.madeForKids` is a CACHE, written when the video was
   *     registered. A creator who flips "Made for Kids" in YouTube Studio afterwards
   *     — or whose video YouTube reclassifies — leaves that cache stale, and nothing
   *     in the system re-reads it on its own.
   *
   * In both cases the subscribe and like checks would run, find nothing (because
   * YouTube does not report these actions on kids content), and write FAILED against
   * a supporter who did exactly what was asked.
   *
   * So the premise is re-confirmed from YouTube at the only moment it matters: after
   * a check has come back "no", and before that "no" is recorded. Costs nothing in
   * the normal case — it runs only when a failure is imminent, at most once per
   * verification — and it is self-healing: the fresh flag is persisted and the
   * campaign is marked as kids content so later sessions skip the lookup entirely.
   */
  let waiverRechecked = false;
  // Bound once: a null-narrowing does not survive into a closure, and re-testing for
  // null inside would imply it could be null here when it cannot.
  const checkedSession = session;
  async function kidsContentConfirmedLate(): Promise<boolean> {
    if (verificationWaived) return true;
    // One lookup per verification, even with both subscribe and like failing.
    if (waiverRechecked) return false;
    waiverRechecked = true;

    const video = checkedSession.video;
    if (!video) return false;

    try {
      const fresh = await fetchVideoMetadata(video.youtubeVideoId);
      if (!fresh) return false;

      // Persist regardless of the answer: a confirmed "not kids" is worth caching too.
      await prisma.video.update({
        where: { id: video.id },
        data: {
          madeForKids: fresh.madeForKids,
          channelId: fresh.channelId,
          channelTitle: fresh.channelTitle,
          metadataSyncedAt: new Date(),
        },
      });

      if (!fresh.madeForKids) return false;

      // YouTube says kids content and the campaign did not. Record it on the campaign
      // so every later session is waived up front, and so the creator's own studio
      // view reflects what YouTube actually reports about their video.
      await prisma.campaign.update({ where: { id: checkedSession.campaignId }, data: { kidsContent: true } });
      logger.warn("kids content detected during verification; waiving subscribe/like for the campaign", {
        campaignId: checkedSession.campaignId,
        videoId: video.id,
      });

      verificationWaived = true;
      return true;
    } catch (e) {
      // Unreachable YouTube must not manufacture a failure either. Returning false
      // leaves the outcome as it was, and an unanswerable check stays PENDING.
      logger.warn("could not re-confirm the kids-content flag before failing a task", {
        videoId: video.id,
        error: internalMessage(e),
      });
      return false;
    }
  }

  const results: TaskVerification[] = [];

  for (const task of session.tasks) {
    let satisfied = false;
    let method: VerificationMethod = "UNVERIFIED";
    let outcome: TaskVerification["outcome"] = "UNAVAILABLE";
    let note: string | undefined;
    let detail: Record<string, unknown> = {};
    /**
     * "Not yet" rather than "no".
     *
     * The watch timer is the one check whose negative answer is purely a matter of
     * waiting: the requirement is not met because the seconds have not passed. That
     * is not a verdict against the supporter, so it must not be recorded as a
     * failure the way a completed YouTube check answering "no" is.
     */
    let stillRunning = false;
    /**
     * "Nobody can answer this", as opposed to "the answer was no".
     *
     * Some requirements cannot be verified by anyone with the access we hold — not
     * now, not after a retry, not with a wider scope. A like on a "Made for Kids"
     * video is the concrete case: YouTube keeps it out of the viewer's own liked
     * list, and the one endpoint that would answer directly refuses read-only
     * tokens. Leaving such a task PENDING would strand the session forever, and
     * marking it FAILED would accuse a supporter who did exactly what was asked, so
     * it is WAIVED: recorded as unproven, and not allowed to block settlement.
     */
    let unverifiable = false;

    if (task.type === "WATCH_VIDEO") {
      const watch = session.watchSession;
      // Recomputed from the server anchor, not read from a stored flag: the task
      // cannot be satisfied by any request, only by time having passed.
      satisfied = Boolean(watch && isTimerSatisfied(watch.openedAt, watch.requiredSec));
      // Deliberately PLATFORM_OBSERVED, never YOUTUBE_API: no YouTube endpoint
      // reports how much of a video a specific user watched. Here it means
      // "the required time elapsed after we sent you to YouTube".
      method = satisfied ? "PLATFORM_OBSERVED" : "UNVERIFIED";
      outcome = satisfied ? "VERIFIED" : "NOT_VERIFIED";
      if (!satisfied && watch) {
        // Whether the clock is running or has not been started, the next step is to
        // wait or to open the video — never to be told the task failed.
        stillRunning = true;
        note = watch.openedAt
          ? `${formatRemaining(remainingWatchSeconds(watch.openedAt, watch.requiredSec))} تا تأیید باقی مانده است.`
          : "ابتدا ویدیو را در یوتیوب باز کنید تا زمان تماشا شروع شود.";
      }
      detail = watch
        ? {
            requiredSec: watch.requiredSec,
            elapsedSec: creditedWatchSeconds(watch.openedAt, watch.requiredSec),
            openedAt: watch.openedAt?.toISOString() ?? null,
          }
        : {};
    } else if (task.type === "SUBSCRIBE_CHANNEL") {
      if (verificationWaived) {
        // Waived, not judged. See `verificationWaived`: on kids content YouTube does
        // not report these actions back to us, so a "no" here would carry no
        // information — it would just be an accusation we cannot support.
        outcome = "UNAVAILABLE";
        method = "UNVERIFIED";
        unverifiable = true;
        note = KIDS_CONTENT_NOTE;
        detail = { reason: "KIDS_CONTENT_VERIFICATION_WAIVED", channelId };
      } else if (!channelId) {
        // We could not name the channel to check, so we cannot answer. Reported as
        // "not checkable right now", never as "you did not subscribe": this branch
        // used to fall through to the catch-all below and mark a required task
        // FAILED, which told supporters who really had subscribed that they had not.
        outcome = "UNAVAILABLE";
        note = "کانال این ویدیو در دسترس نیست؛ این مورد فعلاً قابل بررسی نبود و ناموفق ثبت نشد. چند لحظه بعد دوباره بررسی کنید.";
        detail = { reason: "NO_TARGET_CHANNEL" };
      } else {
        const check = await checkSubscription(supporterId, channelId);
        if (check.outcome === "NOT_VERIFIED" && (await kidsContentConfirmedLate())) {
          // YouTube reports this as kids content after all, so "not found in the
          // subscription list" is not evidence of anything. Waive instead of accuse.
          outcome = "UNAVAILABLE";
          method = "UNVERIFIED";
          unverifiable = true;
          note = KIDS_CONTENT_NOTE;
          detail = { reason: "KIDS_CONTENT_DETECTED_LATE", channelId };
        } else {
          satisfied = check.satisfied;
          method = check.available ? "YOUTUBE_API" : "UNVERIFIED";
          outcome = check.outcome;
          note = subscribeNote(check.outcome, supporterIdentity);
          detail = { ...(check.detail ?? {}), channelId };
        }
      }
    } else if (task.type === "LIKE_VIDEO" && videoId) {
      if (verificationWaived) {
        /*
         * Kids content: the like is NOT verifiable, so we refuse to judge it.
         *
         * Proven on this server: a campaign video with public likes that appears in
         * nobody's "Liked videos" playlist. That playlist is the only like surface a
         * youtube.readonly grant can read — videos.getRating answers directly but
         * demands the full read/write youtube scope and returns 403 to a read-only
         * token, so widening the scope is not a fix either.
         */
        outcome = "UNAVAILABLE";
        method = "UNVERIFIED";
        unverifiable = true;
        note = KIDS_CONTENT_NOTE;
        detail = { reason: "KIDS_CONTENT_VERIFICATION_WAIVED" };
      } else {
        const check = await checkLike(supporterId, videoId);
        if (check.outcome === "NOT_VERIFIED" && (await kidsContentConfirmedLate())) {
          // Same reasoning as subscribe: on kids content the like never reaches the
          // viewer's own liked playlist, so its absence proves nothing.
          outcome = "UNAVAILABLE";
          method = "UNVERIFIED";
          unverifiable = true;
          note = KIDS_CONTENT_NOTE;
          detail = { reason: "KIDS_CONTENT_DETECTED_LATE" };
        } else {
          satisfied = check.satisfied;
          method = check.available ? "YOUTUBE_API" : "UNVERIFIED";
          outcome = check.outcome;
          note = likeNote(check.outcome, supporterIdentity);
          detail = check.detail ?? {};
        }
      }
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

    // A check that could not be COMPLETED must never be written down as a
    // definitive failure. Only NOT_VERIFIED — a finished call whose answer was
    // "no" — fails a required task. A transient error, a dead grant, or a target we
    // could not name all leave the task PENDING so re-checking can still clear it;
    // previously UNAVAILABLE fell into the same bucket as "no", which is how an
    // unanswerable check became a permanent accusation.
    const nextTaskState =
      satisfied
        ? "SATISFIED"
        : unverifiable
          ? // Waived: unprovable for everyone, so it neither passes nor fails. Kept
            // out of the settlement gate below instead of blocking it forever.
            "SKIPPED"
          : outcome === "NOT_VERIFIED" && !stillRunning
            ? task.required
              ? "FAILED"
              : "SKIPPED"
            : task.required
              ? "PENDING"
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
              : stillRunning
                ? "PENDING"
                : outcome === "NOT_VERIFIED"
                  ? "FAILED"
                  : outcome === "TEMPORARY_ERROR"
                    ? "PENDING"
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
 * What a supporter is told when a task is waived as kids content.
 *
 * Deliberately blames neither the supporter nor the creator: it is a YouTube
 * restriction. It also states the consequence honestly — the task is not counted
 * against them, and it earns no bonus, because nothing was verified.
 */
const KIDS_CONTENT_NOTE =
  "این کمپین به‌عنوان محتوای کودکان (YouTube Kids) ثبت شده است. یوتیوب برای این نوع محتوا سابسکرایب و لایک را به ما گزارش نمی‌دهد، پس این مورد قابل بررسی خودکار نیست؛ ناموفق ثبت نمی‌شود و مانع تکمیل حمایت شما نیست.";

/**
 * Failure copy for subscribe. Specific and actionable, never "something went
 * wrong" and never a raw provider status code.
 *
 * A NOT_VERIFIED verdict NAMES THE CHANNEL THAT WAS INSPECTED. The most common
 * cause of an honest "but I did subscribe!" is not a broken check: it is a second
 * Google account. The browser is signed into one, the YouTube app into another,
 * and the subscription lands on an account this grant cannot see. Without the
 * identity in the message, the only advice the user gets is to repeat the same
 * action on the same wrong account.
 */
function subscribeNote(outcome: TaskVerification["outcome"], connectedChannel: string | null): string | undefined {
  switch (outcome) {
    case "VERIFIED":
      return undefined;
    case "NOT_VERIFIED":
      return connectedChannel
        ? `ما اشتراک این کانال را در حساب «${connectedChannel}» بررسی کردیم و پیدا نشد. اگر سابسکرایب کرده‌اید، تقریباً همیشه علتش این است که در یوتیوب با یک حساب گوگل دیگر وارد هستید؛ در یوتیوب حساب را به «${connectedChannel}» عوض کنید و همان‌جا سابسکرایب کنید.`
        : "اشتراک این کانال تأیید نشد. کانال را سابسکرایب کنید و دوباره بررسی بزنید.";
    case "TEMPORARY_ERROR":
      return "یوتیوب در این لحظه پاسخ نداد. این مورد ناموفق ثبت نشد؛ چند لحظه بعد دوباره بررسی کنید.";
    case "REAUTH_REQUIRED":
      return "دسترسی حساب یوتیوب شما منقضی یا لغو شده است. برای بررسی، حساب را دوباره متصل کنید.";
    default:
      return "برای بررسی خودکار اشتراک باید حساب یوتیوب خود را متصل کنید.";
  }
}

function likeNote(outcome: TaskVerification["outcome"], connectedChannel: string | null): string | undefined {
  switch (outcome) {
    case "VERIFIED":
      return undefined;
    case "NOT_VERIFIED":
      return connectedChannel
        ? `ما لایک این ویدیو را در حساب «${connectedChannel}» بررسی کردیم و پیدا نشد. اگر لایک کرده‌اید، تقریباً همیشه علتش این است که در یوتیوب با یک حساب گوگل دیگر وارد هستید؛ در یوتیوب حساب را به «${connectedChannel}» عوض کنید و لایک را روی همان حساب بزنید.`
        : "این ویدیو در فهرست «ویدیوهای پسندیده» حساب یوتیوب شما پیدا نشد. اگر همین حالا لایک کرده‌اید، چند لحظه صبر کنید و دوباره بررسی بزنید.";
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
  // Same reasoning as startSupportSession: outside the transaction, because the
  // settlement transaction is Serializable and must not wait on YouTube.
  //
  // Checked here too, not only at start: a session can be started while compliant
  // and completed an hour later, and settlement is where the money actually moves.
  await assertCompliant(input.supporterId);

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
      // SKIPPED on a REQUIRED task means waived: verification was structurally
      // impossible (see `unverifiable` in verifySessionTasks), so holding the
      // session hostage to it would strand a supporter who did what was asked. It
      // still earns no task bonus and still records as unproven, so nothing is
      // claimed that YouTube did not confirm.
      const unmet = requiredTasks.filter((task) => task.state !== "SATISFIED" && task.state !== "SKIPPED");
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

      // Real-time gate, re-evaluated from the anchor at settlement rather than
      // trusting the task row. The task was satisfied by a previous request, and
      // this is the last point before money moves, so the requirement is proven
      // again here: full requiredSec must have elapsed since the video was opened.
      if (watch && watch.requiredSec > 0) {
        if (!isTimerSatisfied(watch.openedAt, watch.requiredSec)) {
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
                note: watch.openedAt
                  ? `completed ${Math.round(
                      remainingWatchSeconds(watch.openedAt, watch.requiredSec)
                    )}s before the ${watch.requiredSec}s requirement elapsed`
                  : "completed without ever opening the video",
              },
            ],
          });
          throw ruleError("IMPOSSIBLE_TIMELINE");
        }
      }

      // seekCount / heartbeats / rejectedBeats / hiddenSec are deliberately NOT
      // passed: with the video on YouTube there is no player to observe, so those
      // columns are structurally 0. Reporting 0 would make every honest watch look
      // like a forged one to the heartbeat-anomaly rule, which is why
      // assessSessionEvidence treats them as absent rather than zero.
      const evidenceReasons: RiskReason[] = watch
        ? assessSessionEvidence({
            elapsedSeconds,
            watchedSeconds: creditedWatchSeconds(watch.openedAt, watch.requiredSec),
            requiredSeconds: watch.requiredSec,
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
        select: { type: true, required: true, rewardXp: true },
      });
      const configByType = new Map(campaignTaskConfig.map((task) => [task.type, task]));

      // The credit leg is NOT passed in: it is the platform transfer constant, so
      // no campaign field can make one support pay more or cost less than another.
      // Only XP is campaign-configurable here.
      const settlement = computeSettlement({
        baseXp: campaign.rewardXp || REWARDS.SUPPORT_COMPLETED.xp,
        tasks: session.tasks.map((task) => {
          const config = configByType.get(task.type);
          const fallback = defaultTaskBonus(task.type, task.required);
          return {
            type: task.type,
            required: task.required,
            satisfied: task.state === "SATISFIED",
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
        UPDATE public."Campaign"
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
      // The Support row is the PERMANENT outcome record, so the evidence the
      // decision rested on is copied into it here rather than left only in
      // WatchSession / SupportVerification. Those two tables hold temporary
      // execution data and are purged once the session is terminal (see
      // src/lib/services/retention.ts); without this copy, purging them would
      // destroy the ability to audit why a past support was paid.
      const verificationSummary = await tx.supportVerification.findMany({
        where: { sessionId: session.id },
        orderBy: { createdAt: "asc" },
        select: { taskType: true, method: true, result: true },
      });

      const support = await tx.support.create({
        data: {
          supporterId: input.supporterId,
          receiverId: session.creatorId,
          campaignId: campaign.id,
          videoId: session.videoId,
          creditsAwarded: settlement.totalCredits,
          xpAwarded: settlement.totalXp,
          mutual,
          watchedSec: watch?.accumulatedSec ?? 0,
          requiredWatchSec: watch?.requiredSec ?? 0,
          riskScore: combined.score,
          // Deduplicated to the LAST result per task: verify can be retried, so the
          // raw table may hold several attempts per task and only the final one is
          // what the payout was based on.
          verification: Object.values(
            verificationSummary.reduce<Record<string, { type: string; method: string; result: string }>>(
              (acc, row) => {
                acc[row.taskType] = { type: row.taskType, method: row.method, result: row.result };
                return acc;
              },
              {}
            )
          ) as unknown as Prisma.InputJsonValue,
        },
      });

      const targetRewardState = combined.decision === "REVIEW" ? "PENDING_REVIEW" : "CONFIRMED";
      assertRewardTransition(session.rewardState, targetRewardState);

      // ---- Subscription obligation ----------------------------------------
      // Recorded inside the settlement transaction, so an obligation can never be
      // missing for a support that was paid, nor exist for one that rolled back.
      //
      // The channel is read here rather than passed in because the obligation is to
      // the channel that was actually supported: copying it now means a creator who
      // later links a different channel cannot silently move or void everyone's
      // obligation.
      //
      // `subscriptionVerified` comes from the task row's own state — SATISFIED with
      // method YOUTUBE_API is the only combination that means YouTube itself
      // confirmed it. A PLATFORM_OBSERVED or SELF_REPORTED pass is deliberately not
      // enough to create an enforceable obligation: it would be unfair to block
      // someone later over a subscription we never actually verified.
      const subscribeTask = session.tasks.find((task) => task.type === "SUBSCRIBE_CHANNEL");
      // The obligation is to the channel that was actually verified, which is the
      // channel that owns the video — the same target verifySessionTasks used. It is
      // read from the video row — the same source the verification used — so the
      // obligation cannot point at a different channel than the one the supporter
      // was actually asked to subscribe to. The creator's own linked channel is NOT
      // consulted: it answers "who registered this campaign", which is a different
      // question and is wrong whenever someone registers a video they do not own.
      const creatorChannel =
        subscribeTask && session.videoId
          ? await tx.video.findUnique({
              where: { id: session.videoId },
              select: { channelId: true },
            })
          : null;

      await recordComplianceObligation(tx, {
        userId: input.supporterId,
        supportId: support.id,
        targetChannelId: creatorChannel?.channelId ?? null,
        subscriptionRequired: Boolean(subscribeTask?.required),
        subscriptionVerified: subscribeTask?.state === "SATISFIED" && subscribeTask.method === "YOUTUBE_API",
      });

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
        //
        // THE ONLY CREDIT MOVEMENT in this settlement. It is the receiving half of
        // a transfer whose paying half is the campaign budget: `spentCredits` was
        // incremented by exactly settlement.budgetCost in the conditional UPDATE
        // above, and budgetCost === transferCredits === this amount. The credits
        // themselves left the creator's balance when the budget was funded
        // (services/budget.ts), so nothing is minted here and nothing is burned.
        await recordCredit(tx, {
          userId: input.supporterId,
          type: "SUPPORT_COMPLETED",
          amount: settlement.transferCredits,
          idempotencyKey: ledgerKey(["support-credits", session.id]),
          sessionId: session.id,
          campaignId: campaign.id,
          supportId: support.id,
          reason: "support transfer from campaign budget",
          metadata: { transferCredits: settlement.transferCredits, xpMultiplier: multiplier, priorPairSupports },
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
        creditsPaid += settlement.transferCredits;
        xpPaid += settlement.base.xp;

        // Optional-task bonuses — XP ONLY. Keyed by task type, so adding a second
        // optional task later cannot collide with an existing entry. Paying credits
        // here would mint them: the budget was charged the transfer amount and
        // nothing more, so there is no funded source for a credit bonus.
        for (const bonus of settlement.taskBonuses) {
          const bonusXp = await recordXp(tx, {
            userId: input.supporterId,
            type: "SUPPORT_COMPLETED",
            amount: bonus.xp,
            idempotencyKey: ledgerKey(["task-xp", session.id, bonus.key]),
            sessionId: session.id,
            supportId: support.id,
          });
          if (bonusXp.applied) levelAfter = bonusXp.level;
          xpPaid += bonus.xp;
        }

        // Mutual-exchange bonus — XP ONLY, for the same reason as task bonuses.
        if (settlement.mutualBonus) {
          const mutualXpResult = await recordXp(tx, {
            userId: input.supporterId,
            type: "MUTUAL_BONUS",
            amount: settlement.mutualBonus.xp,
            idempotencyKey: ledgerKey(["mutual-xp", session.id]),
            sessionId: session.id,
            supportId: support.id,
          });
          if (mutualXpResult.applied) levelAfter = mutualXpResult.level;
          xpPaid += settlement.mutualBonus.xp;
        }

        // Creator side — XP ONLY, never credits. The creator's return on a support
        // is the support itself (exposure, watch time, a subscriber); crediting
        // them as well would create currency with no matching debit, which is how
        // total credits previously grew without bound.
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
 * Pays the referral bonus (XP) once the referred user has completed a real
 * support — not at signup, which is what made throwaway-account farming
 * profitable. `creditedAt` + a conditional updateMany make the payout idempotent.
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

  // XP ONLY. A credit referral bonus has no funding source, so it would mint
  // currency — and an invite-driven credit faucet is exactly what makes
  // throwaway-account farming profitable.
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
    message: `کاربری که با کد دعوت شما ثبت‌نام کرد اولین حمایت تأییدشده‌اش را کامل کرد و ${REWARDS.REFERRAL.xp} XP به شما اضافه شد.`,
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
 *                For a support older than XpLedger's retention window the detail
 *                entries are gone, so the shortfall is charged from the permanent
 *                Support.xpAwarded copy — see compensateMissingXp().
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
/**
 * Resolves a reward held at PENDING_REVIEW.
 *
 * This is the missing half of the anti-abuse design. Settlement holds a risky
 * reward instead of paying or denying it silently, but until now nothing could
 * resolve the hold: the credits had already left the campaign budget (settlement
 * increments `spentCredits` before deciding whether to pay) and never reached
 * the supporter, so every held support permanently destroyed its own transfer
 * amount. Both branches below exist to restore conservation.
 *
 * APPROVE pays what settlement computed and recorded on the `Support` row. It
 * mints nothing: `spentCredits` was already charged for exactly this amount, so
 * this is the delayed receiving half of a transfer whose paying half happened at
 * settlement. The credit key is deliberately the SAME key settlement would have
 * used, which is what makes an approval unable to double-pay.
 *
 * REFUSE returns the amount to the campaign budget instead, so the creator is
 * not charged for a support that was never paid out.
 *
 * Idempotent on both paths: the reward transition guard rejects a second call
 * (PENDING_REVIEW is the only legal source state), and every ledger write is
 * keyed.
 */
export async function resolveHeldReward(input: {
  sessionId: string;
  moderatorId: string;
  decision: "APPROVE" | "REFUSE";
  reason?: string;
}) {
  const reason = input.reason?.slice(0, 500) ?? "";

  // A held reward is new credit about to be paid, so it is gated like any other
  // earning: approving one for a supporter who has since unsubscribed would pay
  // out precisely the behaviour compliance exists to discourage.
  //
  // Only the APPROVE path is gated. A REFUSE must always be able to proceed — it
  // returns the amount to the campaign budget, and leaving held rewards stuck
  // because the supporter is non-compliant would penalize the creator instead.
  if (input.decision === "APPROVE") {
    const held = await prisma.supportSession.findUnique({
      where: { id: input.sessionId },
      select: { supporterId: true },
    });
    if (held) await assertCompliant(held.supporterId);
  }

  const result = await prisma.$transaction(async (tx) => {
    const session = await tx.supportSession.findUnique({
      where: { id: input.sessionId },
      select: {
        id: true,
        rewardState: true,
        supporterId: true,
        creatorId: true,
        campaignId: true,
        riskScore: true,
        supportId: true,
        supporter: { select: { level: true, reputation: true } },
      },
    });
    if (!session) throw new NotFoundError("این نشست حمایت پیدا نشد.");
    if (session.rewardState !== "PENDING_REVIEW") {
      throw new ConflictError("این پاداش در انتظار بررسی نیست.");
    }
    if (!session.supportId) {
      // A held session always has one; without it there is no recorded amount to
      // pay and no way to know what to return, so refuse to guess.
      throw new BusinessRuleError("این نشست هنوز تسویه نشده است.", { rule: "reward-not-settled" });
    }

    const support = await tx.support.findUnique({
      where: { id: session.supportId },
      select: { id: true, creditsAwarded: true, xpAwarded: true, campaignId: true, status: true },
    });
    if (!support) throw new NotFoundError("رکورد این حمایت پیدا نشد.");

    const target = input.decision === "APPROVE" ? "CONFIRMED" : "DENIED";
    assertRewardTransition(session.rewardState, target);

    let creditsPaid = 0;
    let xpPaid = 0;
    let levelAfter = session.supporter.level;
    let reputationAfter = session.supporter.reputation;

    if (input.decision === "APPROVE") {
      // Same idempotency key settlement uses for the transfer leg. If settlement
      // had paid it, this is a no-op returning applied:false rather than a second
      // payment.
      const credit = await recordCredit(tx, {
        userId: session.supporterId,
        type: "SUPPORT_COMPLETED",
        amount: support.creditsAwarded,
        idempotencyKey: ledgerKey(["support-credits", session.id]),
        sessionId: session.id,
        campaignId: support.campaignId,
        supportId: support.id,
        reason: "held support approved by moderator",
        metadata: { moderatorId: input.moderatorId, riskScore: session.riskScore },
      });
      if (credit.applied) creditsPaid = support.creditsAwarded;

      // The whole XP amount in one entry, from Support.xpAwarded — the permanent
      // copy of what settlement computed. Reconstructing the per-component
      // entries would re-derive amounts from config that may have changed since,
      // and the reversal path reverses by session anyway.
      const xp = await recordXp(tx, {
        userId: session.supporterId,
        type: "SUPPORT_COMPLETED",
        amount: support.xpAwarded,
        idempotencyKey: ledgerKey(["review-xp", session.id]),
        sessionId: session.id,
        supportId: support.id,
      });
      if (xp.applied) {
        xpPaid = support.xpAwarded;
        levelAfter = xp.level;
      }

      // Creator side: XP only, never credits — same rule as settlement.
      await recordXp(tx, {
        userId: session.creatorId,
        type: "SUPPORT_RECEIVED",
        amount: REWARDS.SUPPORT_RECEIVED.xp,
        idempotencyKey: ledgerKey(["received-xp", session.id]),
        sessionId: session.id,
        supportId: support.id,
      });

      // Settlement recorded a zero-delta reputation entry under its own key, so a
      // distinct key is required here to award the real value.
      const rep = await recordReputation(tx, {
        userId: session.supporterId,
        type: "SUPPORT_VERIFIED",
        delta: REPUTATION.SUPPORT_VERIFIED,
        idempotencyKey: ledgerKey(["review-reputation", session.id]),
        sessionId: session.id,
      });
      reputationAfter = rep.valueAfter;
    } else {
      // Return the transfer to the budget: the creator must not pay for a support
      // that was never credited. Clamped so no adjustment can drive it negative.
      if (support.creditsAwarded > 0) {
        await tx.$executeRaw`
          UPDATE public."Campaign"
          SET "spentCredits" = GREATEST(0, "spentCredits" - ${support.creditsAwarded})
          WHERE "id" = ${support.campaignId};
        `;
      }

      // Nothing was ever paid, so there is no ledger entry to reverse. The row is
      // kept and marked instead of deleted, so the decision stays auditable.
      if (support.status !== "REVERSED") {
        await tx.support.update({
          where: { id: support.id },
          data: {
            status: "REVERSED",
            reversedAt: new Date(),
            reversedById: input.moderatorId,
            reversalReason: reason || "پاداش پس از بررسی تأیید نشد.",
          },
        });
        await tx.user.update({
          where: { id: session.supporterId },
          data: { supportsCompleted: { decrement: 1 } },
        });
      }

      const rep = await recordReputation(tx, {
        userId: session.supporterId,
        type: "SUPPORT_REVERSED",
        delta: REPUTATION.SUPPORT_REVERSED,
        idempotencyKey: ledgerKey(["review-refusal-reputation", session.id]),
        sessionId: session.id,
        reason: reason.slice(0, 200),
      });
      reputationAfter = rep.valueAfter;
    }

    await tx.supportSession.update({
      where: { id: session.id },
      data: { rewardState: target },
    });

    if (input.decision === "APPROVE") {
      await evaluateBadges(tx, session.supporterId);
      await evaluateBadges(tx, session.creatorId);
    }

    const notification = await createNotificationTx(tx, {
      userId: session.supporterId,
      type: input.decision === "APPROVE" ? "SUPPORT_VERIFIED" : "SUPPORT_REVERSED",
      title: input.decision === "APPROVE" ? "پاداش حمایت شما تأیید شد 🎉" : "پاداش حمایت شما تأیید نشد",
      message:
        input.decision === "APPROVE"
          ? `بررسی انجام شد و ${creditsPaid} اعتبار به حساب شما اضافه شد.`
          : `دلیل: ${reason || "این حمایت در بررسی دستی تأیید نشد."}`,
      metadata: { sessionId: session.id, supportId: support.id },
      dedupeKey: ledgerKey(["review-notification", session.id, target]),
    });

    await writeAuditTx(tx, {
      userId: input.moderatorId,
      action: "SUPPORT_REVERSAL",
      entity: "SupportSession",
      entityId: session.id,
      metadata: {
        decision: input.decision,
        rewardState: target,
        supportId: support.id,
        riskScore: session.riskScore,
        credits: creditsPaid,
        xp: xpPaid,
        reason: reason.slice(0, 200),
      },
    });

    return {
      payload: {
        sessionId: session.id,
        supportId: support.id,
        rewardState: target as "CONFIRMED" | "DENIED",
        credits: creditsPaid,
        xp: xpPaid,
        level: { before: session.supporter.level, after: levelAfter },
        reputation: { before: session.supporter.reputation, after: reputationAfter },
      },
      notification,
    };
  });

  if (result.notification) await deliverNotification(result.notification);

  logger.info("resolved held support reward", {
    sessionId: input.sessionId,
    decision: input.decision,
    credits: result.payload.credits,
  });

  return result.payload;
}

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
      const reversed = await reverseSessionLedger(
        tx,
        support.session.id,
        `support reversed: ${input.reason.slice(0, 120)}`
      );

      // XpLedger is pruned after 7 days but a support can be reversed at any time.
      // For an older support there are no detail rows left to mirror, so the loop
      // above reverses nothing and the XP would stay on the balance while the
      // credits are clawed back. Support.xpAwarded is the permanent copy, so the
      // shortfall is charged from that instead.
      await compensateMissingXp(tx, {
        userId: support.supporterId,
        supportId: support.id,
        sessionId: support.session.id,
        awarded: support.xpAwarded,
        alreadyReversed: reversed.xpReversed,
        reason: `support reversed: ${input.reason.slice(0, 120)}`,
      });

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
        UPDATE public."Campaign"
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
 * Closes sessions that ran past their TTL, which frees the "one open session"
 * slot and feeds the completion-rate metric honestly.
 *
 * The old heartbeat-staleness arm is gone with the heartbeats: a supporter who
 * opens the video on YouTube and comes back twenty minutes later is behaving
 * normally, and closing that session early would fail an honest watch. The TTL
 * (WATCH_RULES.sessionTtlMinutes) is now the only bound.
 */
export async function expireStaleSessions() {
  const now = new Date();

  const stale = await prisma.supportSession.findMany({
    where: {
      state: { in: ["STARTED", "VIDEO_OPENED", "WATCHING", "WATCH_THRESHOLD_REACHED", "VERIFYING"] },
      expiresAt: { lt: now },
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

  logger.info("expired timed-out support sessions", { count: stale.length });
  return stale.length;
}


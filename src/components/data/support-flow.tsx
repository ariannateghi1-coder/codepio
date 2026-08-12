"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, ExternalLink, Link2, PlayCircle, RefreshCw, ShieldAlert, TrendingUp } from "lucide-react";
import { api, errorMessage } from "@/lib/client-api";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/states";
import { ProgressBar, Steps, type Step } from "@/components/ui/progress";
import { Pill, VerificationBadge } from "@/components/ui/badge";
import { formatDuration, formatNumber } from "@/lib/cn";
import { SUPPORT_TRANSFER_CREDITS } from "@/lib/gamification";
import { youtubeAppUrl } from "@/lib/youtube";

/**
 * Support session flow — a guided, five-stage experience.
 *
 *   1 تماشا → 2 سابسکرایب → 3 لایک → 4 کامنت (اختیاری) → 5 ثبت
 *
 * WATCH STAGE — the video is watched ON YOUTUBE, not here:
 *
 *   Pressing «تماشا در یوتیوب» tells the server "I am opening it now", and the
 *   server stamps an anchor. On mobile the YouTube app is attempted first via the
 *   `vnd.youtube:` scheme with the https URL as fallback; on desktop the canonical
 *   watch URL opens in a new tab. There is no iframe and no Player API, which is
 *   why the embed and the heartbeat loop are gone.
 *
 *   The countdown shown here is cosmetic: it ticks locally for feedback, but the
 *   only value that decides anything is what the server returns from its own
 *   clock. The client sends no elapsed time — it cannot, the request body is just
 *   the session id — so nothing displayed here can be forged into a reward.
 *
 * The honest verification model, made visible at every step:
 *
 *   Watch     — «ثبت‌شده توسط پلتفرم»: the required time elapsed after we sent you
 *               to YouTube. Never «تأییدشده توسط یوتیوب», because no YouTube API
 *               reports how much of a video a specific person watched, and with the
 *               player outside the page we observe even less than before.
 *   Subscribe — checked through the YouTube Data API with the user's own OAuth
 *               grant. Without that grant we say so and block the task rather than
 *               asking "did you subscribe?" and believing the answer.
 *   Like      — same, via videos.getRating.
 *   Comment   — optional; matched against the linked channel when possible. It can
 *               never block completion.
 *
 * Feedback rules:
 *  • Every task shows a real state. There is no indefinite spinner: a task is
 *    done, pending, failed-with-a-reason, or blocked-with-an-action.
 *  • A failure says what to do next, never a status code.
 *  • A temporary YouTube outage is shown as temporary, and does not mark the task
 *    failed — the server keeps it pending for exactly this reason.
 *  • The reward shown is the reward the server will pay, itemised after settlement.
 */

type SessionInfo = {
  sessionId: string;
  state: string;
  expiresAt: string;
  video: { id: string; youtubeVideoId: string; durationSec: number | null; watchUrl: string };
  requiredWatchSeconds: number;
  openedAt: string | null;
  remainingSeconds: number;
  estimatedSeconds: number;
  tasks: { type: string; required: boolean; rewardXp: number; verifiable: string }[];
  youtubeConnected: boolean;
  youtubeState?: string;
};

/** Server's view of the watch timer. Every field here is computed server-side. */
type WatchTimer = {
  watchUrl: string;
  requiredSec: number;
  remainingSec: number;
  elapsedSec: number;
  percent: number;
  satisfied: boolean;
  openedAt: string;
  state: string;
};

type TaskOutcome = "VERIFIED" | "NOT_VERIFIED" | "TEMPORARY_ERROR" | "REAUTH_REQUIRED" | "UNAVAILABLE";

type Verification = {
  tasks: { type: string; required: boolean; satisfied: boolean; method: string; outcome: TaskOutcome; note?: string }[];
  allRequiredSatisfied: boolean;
};

type Completion = {
  status: "COMPLETED" | "PENDING_REVIEW" | "DENIED";
  rewards: { credits: number; xp: number };
  breakdown: { label: string; credits: number; xp: number }[];
  mutual: boolean;
  reputation: { before: number; after: number };
  level: { before: number; after: number };
  badges: { code: string; name: string; icon: string }[];
  message: string;
};

const TASK_LABELS: Record<string, string> = {
  WATCH_VIDEO: "تماشای ویدیو",
  SUBSCRIBE_CHANNEL: "سابسکرایب کانال",
  LIKE_VIDEO: "لایک ویدیو",
  COMMENT_VIDEO: "کامنت (اختیاری)",
};

/** «۳ دقیقه و ۲۰ ثانیه» — Persian digits via the shared formatter. */
function formatRemaining(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(s / 60);
  const seconds = s % 60;
  if (minutes > 0 && seconds > 0) {
    return `${formatNumber(minutes)} دقیقه و ${formatNumber(seconds)} ثانیه`;
  }
  if (minutes > 0) return `${formatNumber(minutes)} دقیقه`;
  return `${formatNumber(seconds)} ثانیه`;
}

/**
 * Opens the video, preferring the YouTube app on mobile.
 *
 * The app scheme is attempted in a hidden way first and the https URL follows as a
 * fallback, because there is no reliable way to ask a browser "is this scheme
 * handled?" — if the app takes over, the page is already backgrounded when the
 * fallback fires and the browser ignores it. On desktop the scheme would do
 * nothing, so the https URL is used directly in a new tab.
 */
function openOnYoutube(watchUrl: string, videoId: string) {
  const isMobile = /android|iphone|ipad|ipod/i.test(navigator.userAgent);

  if (!isMobile) {
    window.open(watchUrl, "_blank", "noopener,noreferrer");
    return;
  }

  // rel=noopener matters even here: the opened context must not get a handle on
  // this window object.
  const fallback = window.setTimeout(() => {
    window.open(watchUrl, "_blank", "noopener,noreferrer");
  }, 700);

  // If the app takes over, the page is hidden before the timeout fires.
  const onHide = () => {
    if (document.hidden) window.clearTimeout(fallback);
    document.removeEventListener("visibilitychange", onHide);
  };
  document.addEventListener("visibilitychange", onHide);

  window.location.href = youtubeAppUrl(videoId);
}

export function SupportFlow({
  campaignId,
  open,
  onClose,
  onCompleted,
}: {
  campaignId: string | null;
  open: boolean;
  onClose: () => void;
  onCompleted?: () => void;
}) {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [timer, setTimer] = useState<WatchTimer | null>(null);
  const [opening, setOpening] = useState(false);
  const [checking, setChecking] = useState(false);
  /** Local countdown for feedback only; the server's value always overrides it. */
  const [localRemaining, setLocalRemaining] = useState<number | null>(null);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [completion, setCompletion] = useState<Completion | null>(null);
  const [completing, setCompleting] = useState(false);

  const tickRef = useRef<number | null>(null);

  const stopTick = useCallback(() => {
    if (tickRef.current !== null) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, []);

  // Start the session as soon as the modal opens with a campaign.
  useEffect(() => {
    if (!open || !campaignId) return;
    let cancelled = false;

    setStarting(true);
    setError("");
    setCompletion(null);
    setVerification(null);
    setTimer(null);
    setLocalRemaining(null);

    api
      .post<SessionInfo>("/api/v1/support/sessions", { campaignId })
      .then((data) => {
        if (cancelled) return;
        setSession(data);
        // Re-entering an already-open session must show the time already served,
        // not a fresh countdown: the anchor lives on the server, so it is reused.
        if (data.openedAt) {
          setLocalRemaining(data.remainingSeconds);
          void refreshTimer(data.sessionId, { silent: true });
        }
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setStarting(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, campaignId]);

  // Cosmetic countdown. It never decides anything — when it reaches zero the
  // server is asked, and the server's answer replaces whatever this showed.
  //
  // The effect depends on WHETHER a countdown should run, not on the current
  // value: depending on `localRemaining` itself would tear down and recreate the
  // interval every second.
  const shouldTick = open && localRemaining !== null && localRemaining > 0;
  useEffect(() => {
    if (!shouldTick) {
      stopTick();
      return;
    }
    tickRef.current = window.setInterval(() => {
      setLocalRemaining((value) => (value === null ? null : Math.max(0, value - 1)));
    }, 1000);
    return stopTick;
  }, [shouldTick, stopTick]);

  // When the local countdown hits zero, confirm with the server once.
  useEffect(() => {
    if (!session || localRemaining !== 0 || timer?.satisfied) return;
    void refreshTimer(session.sessionId, { silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localRemaining, session?.sessionId, timer?.satisfied]);

  // Coming back from the YouTube app/tab is the natural moment to re-check.
  useEffect(() => {
    if (!open || !session) return;
    function onVisibility() {
      if (!document.hidden && session && !timer?.satisfied) {
        void refreshTimer(session.sessionId, { silent: true });
      }
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, session?.sessionId, timer?.satisfied]);

  function applyTimer(result: WatchTimer) {
    setTimer(result);
    setLocalRemaining(result.remainingSec);
  }

  /** PATCH = "how long is left?". Server recomputes from its anchor. */
  async function refreshTimer(sessionId: string, opts?: { silent?: boolean }) {
    if (!opts?.silent) setChecking(true);
    try {
      applyTimer(await api.patch<WatchTimer>("/api/v1/support/watch", { sessionId }));
    } catch (e) {
      // A silent poll must not spray errors over the UI; the explicit button does.
      if (!opts?.silent) setError(errorMessage(e));
    } finally {
      if (!opts?.silent) setChecking(false);
    }
  }

  /** POST = "I am opening it now": stamps the anchor, then opens YouTube. */
  async function openVideo() {
    if (!session) return;
    setOpening(true);
    setError("");
    try {
      const result = await api.post<WatchTimer>("/api/v1/support/watch", { sessionId: session.sessionId });
      applyTimer(result);
      openOnYoutube(result.watchUrl, session.video.youtubeVideoId);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setOpening(false);
    }
  }

  async function runVerification() {
    if (!session) return;
    setVerifying(true);
    setError("");
    try {
      setVerification(await api.post<Verification>("/api/v1/support/verify", { sessionId: session.sessionId }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setVerifying(false);
    }
  }

  async function finish() {
    if (!session) return;
    setCompleting(true);
    setError("");
    try {
      const result = await api.post<Completion>("/api/v1/support/complete", { sessionId: session.sessionId });
      setCompletion(result);
      stopTick();
      onCompleted?.();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setCompleting(false);
    }
  }

  function close() {
    stopTick();
    setSession(null);
    setVerification(null);
    setCompletion(null);
    setTimer(null);
    setLocalRemaining(null);
    setError("");
    onClose();
  }

  /**
   * Live reward preview.
   *
   * Credits are NOT summed from tasks: a support pays one fixed transfer from the
   * campaign budget, the same for every campaign, so summing per-task amounts used
   * to display a number the server would never pay. XP is genuinely per-task and is
   * summed; the base XP is added by the server at settlement.
   */
  const liveReward = session
    ? {
        credits: SUPPORT_TRANSFER_CREDITS,
        xp: session.tasks.reduce((sum, task) => sum + task.rewardXp, 0),
      }
    : { credits: 0, xp: 0 };

  const watchSatisfied = Boolean(timer?.satisfied);
  const watchOpened = Boolean(timer?.openedAt ?? session?.openedAt);
  const requiredSec = timer?.requiredSec ?? session?.requiredWatchSeconds ?? 0;
  // Prefer the server's number; fall back to the local tick between polls.
  const remainingSec = watchSatisfied ? 0 : (localRemaining ?? timer?.remainingSec ?? requiredSec);
  const elapsedSec = Math.max(0, requiredSec - remainingSec);

  const steps: Step[] = session
    ? session.tasks.map((task) => {
        const result = verification?.tasks.find((t) => t.type === task.type);
        const isWatch = task.type === "WATCH_VIDEO";
        const satisfied = isWatch ? watchSatisfied : Boolean(result?.satisfied);

        // A temporary upstream failure is "still pending", not "failed" — the
        // server keeps the task open, and the UI must say the same thing.
        const pending = result?.outcome === "TEMPORARY_ERROR" || result?.outcome === "REAUTH_REQUIRED";

        const state: Step["state"] = satisfied
          ? "completed"
          : pending
            ? "current"
            : isWatch
              ? watchOpened
                ? "current"
                : "upcoming"
              : result && !result.satisfied
                ? "failed"
                : "upcoming";

        return {
          label: TASK_LABELS[task.type] ?? task.type,
          state,
          detail: isWatch
            ? watchSatisfied
              ? "زمان لازم سپری شد."
              : watchOpened
                ? `حدود ${formatRemaining(remainingSec)} تا تأیید باقی مانده.`
                : `${formatDuration(requiredSec)} از ${formatDuration(session.video.durationSec ?? 0)} — برای شروع، ویدیو را در یوتیوب باز کنید.`
            : (result?.note ??
              (task.verifiable === "REQUIRES_YOUTUBE_CONNECTION"
                ? "برای بررسی خودکار، حساب یوتیوب را متصل کنید."
                : undefined)),
        };
      })
    : [];

  const reauthNeeded =
    session?.youtubeState === "REAUTH_REQUIRED" ||
    session?.youtubeState === "EXPIRED" ||
    verification?.tasks.some((task) => task.outcome === "REAUTH_REQUIRED");

  return (
    <Modal
      open={open}
      onClose={close}
      title={completion ? "نتیجه حمایت" : "حمایت واقعی"}
      description={completion ? undefined : "ویدیو را در یوتیوب تماشا کنید؛ بررسی نهایی سمت سرور انجام می‌شود."}
      footer={
        completion ? (
          <Button onClick={close}>بستن</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              انصراف
            </Button>
            <Button variant="outline" onClick={runVerification} loading={verifying} icon={<RefreshCw aria-hidden size={15} />}>
              بررسی وضعیت
            </Button>
            <Button onClick={finish} loading={completing} disabled={!verification?.allRequiredSatisfied}>
              ثبت حمایت
            </Button>
          </>
        )
      }
    >
      {error && (
        <Alert tone="danger" live="alert" className="mb-4">
          {error}
        </Alert>
      )}

      {starting && <div className="skeleton h-24 w-full rounded-lg" />}

      {completion ? (
        <CompletionSummary completion={completion} />
      ) : (
        session && (
          <div className="space-y-4">
            {/* The watch target. No iframe: the video is opened on YouTube. */}
            <div className="rounded-lg border border-border p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-bold">{session.video.durationSec ? formatDuration(session.video.durationSec) : "—"}</p>
                  <p className="mt-1 text-xs text-fg-muted">
                    زمان لازم: <span className="numeric font-bold">{formatDuration(requiredSec)}</span>
                  </p>
                </div>
                <Button
                  onClick={openVideo}
                  loading={opening}
                  disabled={watchSatisfied}
                  icon={<PlayCircle aria-hidden size={16} />}
                >
                  {watchOpened ? "باز کردن دوباره در یوتیوب" : "تماشا در یوتیوب"}
                </Button>
              </div>

              {watchOpened && (
                <div className="mt-4 space-y-2">
                  <ProgressBar
                    label="پیشرفت زمان تماشا"
                    value={elapsedSec}
                    max={Math.max(1, requiredSec)}
                    tone={watchSatisfied ? "success" : "accent"}
                  />
                  <p className="numeric text-xs text-fg-muted" role="status" aria-live="polite">
                    {watchSatisfied
                      ? "زمان لازم سپری شد؛ اکنون «بررسی وضعیت» را بزنید."
                      : `حدود ${formatRemaining(remainingSec)} تا تأیید باقی مانده.`}
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void refreshTimer(session.sessionId)}
                    loading={checking}
                    icon={<RefreshCw aria-hidden size={14} />}
                  >
                    بررسی زمان
                  </Button>
                </div>
              )}
            </div>

            {/* Live reward, stated before anything is committed. */}
            <div className="flex items-center justify-between rounded-lg bg-accent-soft px-3 py-2">
              <span className="text-xs font-semibold text-accent">پاداش این حمایت</span>
              <span className="numeric text-sm font-black text-accent">
                +{formatNumber(liveReward.credits)} اعتبار{liveReward.xp > 0 ? ` · +${formatNumber(liveReward.xp)} XP` : ""}
              </span>
            </div>

            {reauthNeeded ? (
              <Alert tone="warning" title="اتصال یوتیوب باید تازه شود">
                دسترسی حساب یوتیوب شما منقضی یا لغو شده است، بنابراین سابسکرایب و لایک قابل بررسی نیستند. تا زمانی که دوباره متصل نشوید، این
                کارها را «انجام‌شده» ثبت نمی‌کنیم.
                <a href="/settings/youtube" className="mt-2 inline-flex items-center gap-1 font-bold text-accent">
                  <Link2 aria-hidden size={14} /> اتصال دوباره حساب یوتیوب
                </a>
              </Alert>
            ) : (
              !session.youtubeConnected && (
                <Alert tone="warning" title="اتصال یوتیوب لازم است">
                  برای تأیید سابسکرایب و لایک باید حساب یوتیوب خود را متصل کنید. بدون این اتصال، این کارها قابل تأیید نیستند و ما آن‌ها را
                  «انجام‌شده» ثبت نمی‌کنیم.
                  <a href="/settings/youtube" className="mt-2 inline-flex items-center gap-1 font-bold text-accent">
                    <Link2 aria-hidden size={14} /> اتصال حساب یوتیوب
                  </a>
                </Alert>
              )
            )}

            {/* aria-live so a screen-reader user hears each verification result
                as it lands, instead of having to re-read the list. */}
            <div role="status" aria-live="polite">
              <Steps steps={steps} />
            </div>

            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-sunken p-3 text-xs">
              <span className="font-semibold text-fg-muted">سطح تأیید هر کار:</span>
              <VerificationBadge method="PLATFORM_OBSERVED" />
              <span className="text-fg-subtle">تماشا</span>
              <VerificationBadge method="YOUTUBE_API" />
              <span className="text-fg-subtle">سابسکرایب و لایک</span>
            </div>

            {/* Stated plainly, because the alternative is implying YouTube told us. */}
            <p className="flex items-start gap-2 text-xs leading-6 text-fg-subtle">
              <ShieldAlert aria-hidden size={14} className="mt-1 shrink-0" />
              زمان تماشا از لحظه‌ای که ویدیو را باز می‌کنید، روی ساعت سرور اندازه‌گیری می‌شود. یوتیوب میزان تماشای شما را به ما گزارش نمی‌دهد،
              بنابراین این مورد «ثبت‌شده توسط پلتفرم» است و نه «تأییدشده توسط یوتیوب».
            </p>

            <a
              href={session.video.watchUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs font-semibold text-accent"
            >
              <ExternalLink aria-hidden size={13} /> باز کردن در یوتیوب برای سابسکرایب و لایک
            </a>
          </div>
        )
      )}
    </Modal>
  );
}

/**
 * Completion summary. Every figure comes from the server's actual settlement
 * result — there is no celebratory animation showing a number that wasn't really
 * awarded — and the itemised breakdown explains exactly how the total was reached.
 */
function CompletionSummary({ completion }: { completion: Completion }) {
  if (completion.status === "PENDING_REVIEW") {
    return (
      <Alert tone="warning" title="این حمایت در حال بررسی است" live="status">
        {completion.message} پاداش پس از تأیید نهایی به حساب شما اضافه می‌شود.
      </Alert>
    );
  }

  const reputationDelta = completion.reputation.after - completion.reputation.before;
  const leveledUp = completion.level.after > completion.level.before;

  return (
    <div className="space-y-4 text-center">
      <div className="animate-pop-in mx-auto grid size-14 place-items-center rounded-pill bg-success-soft text-success">
        <CheckCircle2 aria-hidden size={28} />
      </div>
      <p className="text-base font-bold">{completion.message}</p>

      <dl className="grid grid-cols-2 gap-2 text-start">
        <div className="rounded-lg bg-surface-sunken p-3">
          <dt className="text-xs text-fg-subtle">اعتبار</dt>
          <dd className="numeric text-lg font-black text-accent">+{formatNumber(completion.rewards.credits)}</dd>
        </div>
        <div className="rounded-lg bg-surface-sunken p-3">
          <dt className="text-xs text-fg-subtle">XP</dt>
          <dd className="numeric text-lg font-black">+{formatNumber(completion.rewards.xp)}</dd>
        </div>
        <div className="rounded-lg bg-surface-sunken p-3">
          <dt className="text-xs text-fg-subtle">اعتبار کیفی</dt>
          <dd className="numeric text-lg font-black">
            {formatNumber(completion.reputation.before)} → {formatNumber(completion.reputation.after)}
            {reputationDelta !== 0 && (
              <span className="ms-1 text-xs text-success">
                ({reputationDelta > 0 ? "+" : ""}
                {formatNumber(reputationDelta)})
              </span>
            )}
          </dd>
        </div>
        <div className="rounded-lg bg-surface-sunken p-3">
          <dt className="text-xs text-fg-subtle">سطح</dt>
          <dd className="numeric text-lg font-black">
            {formatNumber(completion.level.before)}
            {leveledUp && ` → ${formatNumber(completion.level.after)}`}
          </dd>
        </div>
      </dl>

      {/* Itemised: the user can see why the total is what it is, including a
          diminishing-returns multiplier when one applied. */}
      {completion.breakdown.length > 1 && (
        <ul className="space-y-1 rounded-lg border border-border p-3 text-start text-xs">
          {completion.breakdown.map((part) => (
            <li key={part.label} className="flex items-center justify-between gap-3">
              <span className="text-fg-muted">{part.label}</span>
              <span className="numeric font-bold">
                +{formatNumber(part.credits)} / +{formatNumber(part.xp)} XP
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap justify-center gap-2">
        {leveledUp && (
          <Pill tone="accent" icon={<TrendingUp aria-hidden size={12} />}>
            سطح {formatNumber(completion.level.after)}
          </Pill>
        )}
        {completion.mutual && <Pill tone="accent">حمایت متقابل ثبت شد</Pill>}
        {completion.badges.map((badge) => (
          <Pill key={badge.code} tone="success">
            {badge.icon} {badge.name}
          </Pill>
        ))}
      </div>
    </div>
  );
}

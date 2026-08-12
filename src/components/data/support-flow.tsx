"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, ExternalLink, Link2, RefreshCw, ShieldAlert, TrendingUp } from "lucide-react";
import { api, errorMessage } from "@/lib/client-api";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/states";
import { ProgressBar, Steps, type Step } from "@/components/ui/progress";
import { Pill, VerificationBadge } from "@/components/ui/badge";
import { formatDuration, formatNumber } from "@/lib/cn";
import { WATCH_RULES } from "@/lib/gamification";

/**
 * Support session flow — a guided, five-stage experience.
 *
 *   1 تماشا → 2 سابسکرایب → 3 لایک → 4 کامنت (اختیاری) → 5 ثبت
 *
 * The honest verification model, made visible at every step:
 *
 *   Watch     — tracked by us from IFrame Player events, credited server-side from
 *               the union of segments actually played. Labelled «ثبت‌شده توسط
 *               پلتفرم», never «تأییدشده توسط یوتیوب», because no YouTube API
 *               reports how much of a video a specific person watched.
 *   Subscribe — checked through the YouTube Data API with the user's own OAuth
 *               grant. Without that grant we say so and block the task rather than
 *               asking "did you subscribe?" and believing the answer.
 *   Like      — same, via videos.getRating.
 *   Comment   — optional; matched against the linked channel when possible. It can
 *               never block completion.
 *
 * The client only reports player positions and a monotonic sequence number. The
 * server decides what they are worth, so seeking to 90% credits nothing.
 *
 * Feedback rules:
 *  • Every task shows a real state. There is no indefinite spinner: a task is
 *    done, pending, failed-with-a-reason, or blocked-with-an-action.
 *  • A failure says what to do next ("کانال را سابسکرایب کنید و دوباره بررسی
 *    بزنید"), never a status code. Technical detail stays in the server log.
 *  • A temporary YouTube outage is shown as temporary, and does not mark the task
 *    failed — the server keeps it pending for exactly this reason.
 *  • The reward shown is the reward the server will pay, itemised after settlement.
 */

type SessionInfo = {
  sessionId: string;
  state: string;
  expiresAt: string;
  video: { id: string; youtubeVideoId: string; durationSec: number | null; embedUrl: string };
  requiredWatchSeconds: number;
  estimatedSeconds: number;
  heartbeatSeconds?: number;
  tasks: { type: string; required: boolean; rewardCredits: number; rewardXp: number; verifiable: string }[];
  youtubeConnected: boolean;
  youtubeState?: string;
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

/** Minimal typing for the parts of the YouTube IFrame API we use. */
type YTPlayer = {
  getCurrentTime: () => number;
  getPlayerState: () => number;
  destroy: () => void;
};

declare global {
  interface Window {
    YT?: {
      Player: new (element: HTMLElement, options: Record<string, unknown>) => YTPlayer;
      PlayerState: { PLAYING: number; PAUSED: number; BUFFERING: number; ENDED: number };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

function loadIframeApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  return new Promise((resolve) => {
    const existing = document.getElementById("youtube-iframe-api");
    if (!existing) {
      const script = document.createElement("script");
      script.id = "youtube-iframe-api";
      script.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(script);
    }
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve();
    };
  });
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
  const [watch, setWatch] = useState({ percent: 0, accumulatedSec: 0, requiredSec: 0, satisfied: false });
  const [verification, setVerification] = useState<Verification | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [completion, setCompletion] = useState<Completion | null>(null);
  const [completing, setCompleting] = useState(false);
  const [heartbeatStatus, setHeartbeatStatus] = useState<"online" | "degraded" | "recovered">("online");
  const [heartbeatFailures, setHeartbeatFailures] = useState(0);

  const playerRef = useRef<YTPlayer | null>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const heartbeatRef = useRef<number | null>(null);
  // Monotonic sequence, so the server can reject replayed/out-of-order beats.
  const sequenceRef = useRef(0);
  // Accumulated hidden time since the last beat (Page Visibility API).
  const hiddenSinceRef = useRef<number | null>(null);
  const hiddenAccumulatedRef = useRef(0);

  const stopHeartbeat = useCallback(() => {
    if (heartbeatRef.current !== null) {
      window.clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
  }, []);

  // Track background time honestly. A hostile client could simply not report it,
  // which is why the server treats it as a trust signal and not as proof.
  useEffect(() => {
    if (!open) return;
    function onVisibility() {
      if (document.hidden) {
        hiddenSinceRef.current = Date.now();
      } else if (hiddenSinceRef.current !== null) {
        hiddenAccumulatedRef.current += (Date.now() - hiddenSinceRef.current) / 1000;
        hiddenSinceRef.current = null;
      }
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [open]);

  // Start the session as soon as the modal opens with a campaign.
  useEffect(() => {
    if (!open || !campaignId) return;
    let cancelled = false;

    setStarting(true);
    setError("");
    setCompletion(null);
    setVerification(null);
    setHeartbeatStatus("online");
    setHeartbeatFailures(0);
    sequenceRef.current = 0;
    hiddenAccumulatedRef.current = 0;

    api
      .post<SessionInfo>("/api/v1/support/sessions", { campaignId })
      .then((data) => {
        if (cancelled) return;
        setSession(data);
        setWatch({ percent: 0, accumulatedSec: 0, requiredSec: data.requiredWatchSeconds, satisfied: false });
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
  }, [open, campaignId]);

  // Mount the player and begin heartbeats. The interval is the server's expected
  // cadence; the server independently measures the wall time between beats.
  useEffect(() => {
    if (!session || !open || !mountRef.current) return;
    let destroyed = false;
    const cadence = session.heartbeatSeconds ?? WATCH_RULES.heartbeatSeconds;

    loadIframeApi().then(() => {
      if (destroyed || !mountRef.current || !window.YT?.Player) return;

      playerRef.current = new window.YT.Player(mountRef.current, {
        videoId: session.video.youtubeVideoId,
        host: "https://www.youtube-nocookie.com",
        playerVars: { rel: 0, modestbranding: 1, playsinline: 1, enablejsapi: 1, origin: window.location.origin },
        events: {
          onStateChange: () => void sendHeartbeat(),
        },
      });

      heartbeatRef.current = window.setInterval(() => void sendHeartbeat(), cadence * 1000);
    });

    async function sendHeartbeat() {
      const player = playerRef.current;
      if (!player || !session) return;

      const states = window.YT?.PlayerState;
      const raw = player.getPlayerState?.();
      const playerState =
        raw === states?.PLAYING
          ? "PLAYING"
          : raw === states?.PAUSED
            ? "PAUSED"
            : raw === states?.BUFFERING
              ? "BUFFERING"
              : raw === states?.ENDED
                ? "ENDED"
                : "IDLE";

      // Fold in any time spent hidden while still counting the current stretch.
      let hidden = hiddenAccumulatedRef.current;
      if (hiddenSinceRef.current !== null) hidden += (Date.now() - hiddenSinceRef.current) / 1000;
      hiddenAccumulatedRef.current = 0;
      if (hiddenSinceRef.current !== null) hiddenSinceRef.current = Date.now();

      sequenceRef.current += 1;

      try {
        const result = await api.post<{
          accumulatedSec: number;
          requiredSec: number;
          percent: number;
          satisfied: boolean;
          rejected: boolean;
          acceptedSequence: number;
        }>("/api/v1/support/heartbeat", {
          sessionId: session.sessionId,
          position: Math.floor(player.getCurrentTime?.() ?? 0),
          playerState,
          sequence: sequenceRef.current,
          hiddenSec: Math.round(hidden),
        });
        // Resynchronise with the server's view, so a rejected beat cannot leave
        // the client permanently out of step.
        sequenceRef.current = Math.max(sequenceRef.current, result.acceptedSequence);
        setHeartbeatFailures((failures) => {
          if (failures > 0) setHeartbeatStatus("recovered");
          return 0;
        });
        if (!result.rejected) {
          setWatch({
            accumulatedSec: result.accumulatedSec,
            requiredSec: result.requiredSec,
            percent: result.percent,
            satisfied: result.satisfied,
          });
        }
      } catch {
        // Keep the support state machine untouched, but make the accounting gap
        // visible: the next scheduled beat retries automatically.
        setHeartbeatFailures((failures) => failures + 1);
        setHeartbeatStatus("degraded");
      }
    }

    return () => {
      destroyed = true;
      stopHeartbeat();
      playerRef.current?.destroy?.();
      playerRef.current = null;
    };
  }, [session, open, stopHeartbeat]);

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
      stopHeartbeat();
      onCompleted?.();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setCompleting(false);
    }
  }

  function close() {
    stopHeartbeat();
    setSession(null);
    setVerification(null);
    setCompletion(null);
    setError("");
    onClose();
  }

  /** Live reward preview: the base the campaign will pay for required tasks. */
  const liveReward = session
    ? session.tasks.reduce(
        (sum, task) => ({
          credits: sum.credits + task.rewardCredits,
          xp: sum.xp + task.rewardXp,
        }),
        { credits: 0, xp: 0 }
      )
    : { credits: 0, xp: 0 };

  const steps: Step[] = session
    ? session.tasks.map((task) => {
        const result = verification?.tasks.find((t) => t.type === task.type);
        const isWatch = task.type === "WATCH_VIDEO";
        const satisfied = isWatch ? watch.satisfied : Boolean(result?.satisfied);

        // A temporary upstream failure is "still pending", not "failed" — the
        // server keeps the task open, and the UI must say the same thing.
        const pending = result?.outcome === "TEMPORARY_ERROR" || result?.outcome === "REAUTH_REQUIRED";

        const state: Step["state"] = satisfied
          ? "completed"
          : pending
            ? "current"
            : result && !result.satisfied
              ? "failed"
              : isWatch && watch.percent > 0
                ? "current"
                : "upcoming";

        return {
          label: TASK_LABELS[task.type] ?? task.type,
          state,
          detail: isWatch
            ? `${formatNumber(watch.percent)}٪ از ${formatDuration(session.video.durationSec ?? 0)} — نیاز: ${formatDuration(watch.requiredSec)}`
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
      description={completion ? undefined : "کارهای زیر پس از انجام، سمت سرور بررسی می‌شوند."}
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

      {starting && <div className="skeleton aspect-video w-full rounded-lg" />}

      {completion ? (
        <CompletionSummary completion={completion} />
      ) : (
        session && (
          <div className="space-y-4">
            <div className="overflow-hidden rounded-lg bg-black">
              {/* youtube-nocookie only, matching the CSP frame-src allow-list. */}
              <div ref={mountRef} className="aspect-video w-full" />
            </div>

            {/* Live reward, stated before anything is committed. */}
            <div className="flex items-center justify-between rounded-lg bg-accent-soft px-3 py-2">
              <span className="text-xs font-semibold text-accent">پاداش این حمایت</span>
              <span className="numeric text-sm font-black text-accent">
                +{formatNumber(liveReward.credits)} اعتبار · +{formatNumber(liveReward.xp)} XP
              </span>
            </div>

            <ProgressBar
              label="پیشرفت تماشا"
              value={watch.accumulatedSec}
              max={Math.max(1, watch.requiredSec)}
              tone={watch.satisfied ? "success" : "accent"}
            />

            {heartbeatStatus === "degraded" && (
              <Alert tone="warning" live="status" title="ارتباط ثبت تماشا قطع شده است">
                تلاش برای اتصال دوباره ادامه دارد ({formatNumber(heartbeatFailures)} تلاش ناموفق). تا بازیابی ارتباط، بخشی از زمان تماشا ممکن است ثبت و اعتباردهی نشود.
              </Alert>
            )}
            {heartbeatStatus === "recovered" && (
              <Alert tone="success" live="status" title="ارتباط ثبت تماشا بازیابی شد">
                ثبت تماشا دوباره فعال است. زمانِ هنگام قطعی ممکن است اعتباردهی نشده باشد؛ پیشرفت نمایش‌داده‌شده، مقدار تأییدشده سرور است.
              </Alert>
            )}

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

            <p className="flex items-start gap-2 text-xs leading-6 text-fg-subtle">
              <ShieldAlert aria-hidden size={14} className="mt-1 shrink-0" />
              جابه‌جایی سریع در تایم‌لاین به‌عنوان تماشا حساب نمی‌شود؛ فقط بخش‌هایی که واقعاً پخش شده‌اند شمارش می‌شوند. حداکثر سرعت قابل قبول ۱٫۲۵× است.
            </p>

            <a
              href={`https://www.youtube.com/watch?v=${session.video.youtubeVideoId}`}
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

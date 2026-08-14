"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";
import { api, errorMessage } from "@/lib/client-api";
import { Alert } from "@/components/ui/states";
import { Button } from "@/components/ui/button";

/**
 * Subscription-compliance banner.
 *
 * SHOWS NOTHING when the user is compliant or has no obligations, so a healthy
 * account never sees a warning about a rule it is keeping.
 *
 * COSTS NO QUOTA TO DISPLAY. Mount reads GET /api/v1/compliance, which is served
 * from the database. There is no polling, no interval and no refetch on focus —
 * a live YouTube check happens only when the user presses «بررسی مجدد». That is
 * the difference between a banner that is free to render and one that would spend
 * a quota unit every time someone opens a tab.
 *
 * DISPLAY ONLY. Every decision is the server's: this component cannot mark itself
 * compliant, and sending `{ compliant: true }` from a console would change nothing
 * because no endpoint accepts such a field. What is rendered here is a report.
 *
 * The three outcomes are worded differently on purpose. A failed check is never
 * phrased as an accusation — being told "you unsubscribed" because Google timed
 * out is the specific failure this copy exists to avoid.
 */

type Snapshot = {
  compliant: boolean;
  status: "OK" | "VIOLATED" | "NO_OBLIGATIONS";
  violations: { supportId: string; channelId: string; detectedAt: string | null; lastCheckedAt: string | null }[];
  totalObligations: number;
  lastCheckedAt: string | null;
  stale: boolean;
  message: string | null;
};

type RecheckResult = {
  compliant: boolean;
  apiOutcome: "VERIFIED" | "TEMPORARY_ERROR" | "REAUTH_REQUIRED" | "UNAVAILABLE" | null;
  consultedApi: boolean;
  checked: number;
  restored: string[];
  newViolations: string[];
  message: string | null;
  snapshot: Snapshot;
};

export function ComplianceBanner({ onRestored }: { onRestored?: () => void }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [checking, setChecking] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "success" | "warning" | "danger"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setSnapshot(await api.get<Snapshot>("/api/v1/compliance"));
    } catch {
      // A failed status read must not push an error banner onto an unrelated page:
      // the banner's job is to warn about a violation, and "we could not check"
      // is not a violation.
      setSnapshot(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const recheck = useCallback(async () => {
    setChecking(true);
    setFeedback(null);
    try {
      const result = await api.post<RecheckResult>("/api/v1/compliance/recheck");
      setSnapshot(result.snapshot);

      if (result.apiOutcome === "REAUTH_REQUIRED") {
        setFeedback({
          tone: "warning",
          text: result.message ?? "دسترسی حساب یوتیوب شما منقضی شده است. حساب را دوباره متصل کنید.",
        });
      } else if (result.apiOutcome && result.apiOutcome !== "VERIFIED") {
        // Explicitly not "danger": nothing is wrong with the user's account.
        setFeedback({
          tone: "warning",
          text: result.message ?? "فعلاً امکان بررسی وضعیت اشتراک وجود ندارد. لطفاً کمی بعد دوباره تلاش کنید.",
        });
      } else if (result.compliant) {
        setFeedback({ tone: "success", text: result.message ?? "اشتراک شما تأیید شد و دسترسی شما برگشت." });
        if (result.restored.length > 0) onRestored?.();
      } else {
        setFeedback({
          tone: "danger",
          text: result.message ?? "برای ادامه فعالیت باید کانال موردنظر را سابسکرایب کنید.",
        });
      }
    } catch (e) {
      setFeedback({ tone: "warning", text: errorMessage(e) });
    } finally {
      setChecking(false);
    }
  }, [onRestored]);

  // Nothing to say: compliant, or no obligations on record.
  if (!snapshot || snapshot.status !== "VIOLATED") {
    // One exception — after a successful restore the confirmation stays visible
    // for the rest of the page's life, so the action visibly did something.
    if (feedback?.tone === "success") {
      return (
        <Alert tone="success" live="status" title="وضعیت اشتراک">
          <span className="inline-flex items-center gap-2">
            <ShieldCheck aria-hidden size={16} />
            {feedback.text}
          </span>
        </Alert>
      );
    }
    return null;
  }

  return (
    <Alert tone="danger" live="alert" title="فعالیت شما موقتاً محدود شده است">
      <div className="flex flex-col gap-3">
        <p className="flex items-start gap-2">
          <ShieldAlert aria-hidden size={16} className="mt-1 shrink-0" />
          <span>{snapshot.message}</span>
        </p>

        <p className="text-xs opacity-80">
          {`تعداد اشتراک‌های لغوشده: ${snapshot.violations.length} از ${snapshot.totalObligations}`}
        </p>

        {/* Stated plainly so the user knows this is reversible and how. */}
        <p className="text-xs opacity-80">
          این محدودیت دائمی نیست. پس از سابسکرایب مجدد و تأیید یوتیوب، دسترسی شما بدون هیچ جریمه‌ای برمی‌گردد و
          حمایت‌ها، اعتبار و XP قبلی شما دست‌نخورده باقی می‌مانند.
        </p>

        {feedback && feedback.tone !== "success" && (
          <p className={feedback.tone === "warning" ? "text-xs font-semibold opacity-90" : "text-xs font-semibold"}>
            {feedback.text}
          </p>
        )}
        {feedback?.tone === "success" && <p className="text-xs font-semibold">{feedback.text}</p>}

        <div>
          <Button variant="outline" onClick={recheck} loading={checking} icon={<RefreshCw aria-hidden size={16} />}>
            {checking ? "در حال بررسی…" : "بررسی مجدد"}
          </Button>
        </div>
      </div>
    </Alert>
  );
}

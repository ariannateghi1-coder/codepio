"use client";

import { useCallback, useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { api, errorMessage } from "@/lib/client-api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Textarea } from "@/components/ui/field";
import { ToggleGroup } from "@/components/ui/toggle-group";
import { Pill } from "@/components/ui/badge";
import { Modal } from "@/components/ui/modal";
import { Alert, EmptyState, ErrorState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { formatDuration, formatNumber, formatRelativeTime } from "@/lib/cn";

/**
 * Support moderation.
 *
 * The PENDING_REVIEW queue is where held rewards land: the anti-abuse layer never
 * silently denies or silently pays a risky session, so a human sees the evidence
 * (watch coverage, seek count, heartbeat count, risk reasons) and decides.
 *
 * Reversal goes through the service, which reverses every ledger entry, adjusts
 * reputation and returns the campaign budget — not a bare status flip.
 */

type PendingRow = {
  id: string;
  state: string;
  riskScore: number;
  riskReasons: { type: string; severity: number; note: string }[] | null;
  createdAt: string;
  supportId: string | null;
  supporter: { username: string; name: string; reputation: number; trustScore: number };
  creator: { username: string; name: string };
  campaign: { id: string; title: string; rewardCredits: number };
  watchSession: { accumulatedSec: number; requiredSec: number; seekCount: number; heartbeats: number } | null;
};

type SupportRow = {
  id: string;
  status: string;
  mutual: boolean;
  creditsAwarded: number;
  xpAwarded: number;
  createdAt: string;
  reversedAt: string | null;
  reversalReason: string | null;
  supporter: { username: string; name: string; reputation: number };
  receiver: { username: string; name: string };
  campaign: { id: string; title: string } | null;
  session: { id: string; riskScore: number; rewardState: string } | null;
};

const FILTERS = [
  { value: "PENDING_REVIEW", label: "در انتظار بررسی" },
  { value: "ALL", label: "همه" },
  { value: "ACTIVE", label: "فعال" },
  { value: "REVERSED", label: "برگشت‌خورده" },
] as const;

type Filter = (typeof FILTERS)[number]["value"];

export function AdminSupportsTable({ initialFilter = "PENDING_REVIEW" }: { initialFilter?: Filter }) {
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>(initialFilter);
  const [pending, setPending] = useState<PendingRow[]>([]);
  const [supports, setSupports] = useState<SupportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reverseTarget, setReverseTarget] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api.get<{ mode: string; items: PendingRow[] | SupportRow[] }>(
        `/api/v1/admin/supports?status=${filter}&limit=20`
      );
      if (data.mode === "PENDING_REVIEW") {
        setPending(data.items as PendingRow[]);
        setSupports([]);
      } else {
        setSupports(data.items as SupportRow[]);
        setPending([]);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <ToggleGroup<Filter> label="فیلتر حمایت‌ها" options={[...FILTERS]} value={filter} onChange={setFilter} size="sm" className="mb-5 w-fit" />

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : loading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="skeleton h-24 rounded-xl" />
          ))}
        </div>
      ) : filter === "PENDING_REVIEW" ? (
        pending.length === 0 ? (
          <EmptyState title="صف بررسی خالی است" description="هیچ حمایتی در انتظار تصمیم نیست." />
        ) : (
          <ul className="space-y-3">
            {pending.map((row) => (
              <li key={row.id}>
                <Card className="border-warning/30 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-bold">
                        <span className="latin" dir="ltr">
                          @{row.supporter.username}
                        </span>{" "}
                        → <span className="latin" dir="ltr">@{row.creator.username}</span>
                      </p>
                      <p className="clamp-2 mt-1 text-xs text-fg-muted">{row.campaign.title}</p>
                    </div>
                    <Pill tone={row.riskScore >= 60 ? "danger" : "warning"} className="numeric">
                      ریسک {formatNumber(row.riskScore)}
                    </Pill>
                  </div>

                  {row.watchSession && (
                    <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {[
                        { label: "تماشا", value: formatDuration(row.watchSession.accumulatedSec) },
                        { label: "لازم", value: formatDuration(row.watchSession.requiredSec) },
                        { label: "پرش", value: formatNumber(row.watchSession.seekCount) },
                        { label: "ضربان", value: formatNumber(row.watchSession.heartbeats) },
                      ].map((item) => (
                        <div key={item.label} className="rounded-lg bg-surface-sunken p-2 text-center">
                          <dt className="text-[0.625rem] text-fg-subtle">{item.label}</dt>
                          <dd className="numeric text-sm font-bold">{item.value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}

                  {row.riskReasons && row.riskReasons.length > 0 && (
                    <ul className="mt-3 space-y-1 text-xs leading-6 text-fg-muted">
                      {row.riskReasons.map((reason, index) => (
                        <li key={index} className="flex gap-2">
                          <Pill tone="warning" className="numeric shrink-0">
                            {formatNumber(reason.severity)}
                          </Pill>
                          <span className="latin" dir="ltr">
                            {reason.note}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="mt-3 flex items-center gap-2">
                    <span className="text-xs text-fg-subtle">{formatRelativeTime(row.createdAt)}</span>
                    {row.supportId && (
                      <Button
                        variant="danger"
                        size="sm"
                        className="ms-auto"
                        onClick={() => setReverseTarget(row.supportId)}
                        icon={<RotateCcw aria-hidden size={14} />}
                      >
                        برگشت حمایت
                      </Button>
                    )}
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )
      ) : supports.length === 0 ? (
        <EmptyState title="حمایتی یافت نشد" description="فیلتر دیگری را امتحان کنید." />
      ) : (
        <ul className="space-y-2">
          {supports.map((row) => (
            <li key={row.id}>
              <Card className={row.status === "REVERSED" ? "border-warning/30 p-3" : "p-3"}>
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold">
                      <span className="latin" dir="ltr">
                        @{row.supporter.username}
                      </span>{" "}
                      → <span className="latin" dir="ltr">@{row.receiver.username}</span>
                    </p>
                    {row.campaign && <p className="clamp-2 mt-0.5 text-xs text-fg-muted">{row.campaign.title}</p>}
                    {row.reversalReason && (
                      <p className="mt-1 rounded-md bg-warning-soft px-2 py-1 text-xs leading-6 text-warning">
                        دلیل برگشت: {row.reversalReason}
                      </p>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {row.mutual && <Pill tone="success">متقابل</Pill>}
                    {row.status === "REVERSED" ? (
                      <Pill tone="warning">برگشت‌خورده</Pill>
                    ) : (
                      <Pill tone="success">فعال</Pill>
                    )}
                    {row.session && (
                      <Pill tone={row.session.riskScore >= 40 ? "warning" : "neutral"} className="numeric">
                        ریسک {formatNumber(row.session.riskScore)}
                      </Pill>
                    )}
                    <span className="numeric text-sm font-bold text-accent">+{formatNumber(row.creditsAwarded)}</span>
                    {row.status === "ACTIVE" && (
                      <Button variant="ghost" size="sm" onClick={() => setReverseTarget(row.id)}>
                        برگشت
                      </Button>
                    )}
                  </div>
                </div>
                <p className="mt-2 text-[0.6875rem] text-fg-subtle">{formatRelativeTime(row.createdAt)}</p>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <ReverseModal
        supportId={reverseTarget}
        open={reverseTarget !== null}
        onClose={() => setReverseTarget(null)}
        onDone={async () => {
          toast.push({ tone: "success", message: "حمایت برگشت خورد و پاداش‌ها اصلاح شد." });
          await load();
        }}
      />
    </div>
  );
}

function ReverseModal({
  supportId,
  open,
  onClose,
  onDone,
}: {
  supportId: string | null;
  open: boolean;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supportId) return;
    const form = new FormData(event.currentTarget);
    setLoading(true);
    setError("");
    try {
      await api.post("/api/v1/admin/supports", { supportId, reason: String(form.get("reason") ?? "") });
      await onDone();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="برگشت حمایت"
      description="تمام اعتبار و XP این حمایت در دفتر حساب معکوس می‌شود و اعتبار کیفی حامی کاهش می‌یابد."
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && (
          <Alert tone="danger" live="alert">
            {error}
          </Alert>
        )}
        <Alert tone="warning" title="این عملیات قابل بازگشت نیست">
          برای شفافیت، رکورد حمایت حذف نمی‌شود و با وضعیت «برگشت‌خورده» و همین دلیل باقی می‌ماند.
        </Alert>
        <Field label="دلیل برگشت" htmlFor="reason" required hint="برای کاربر نمایش داده می‌شود.">
          <Textarea id="reason" name="reason" required minLength={5} />
        </Field>
        <Button type="submit" variant="danger" loading={loading} fullWidth>
          تأیید برگشت
        </Button>
      </form>
    </Modal>
  );
}

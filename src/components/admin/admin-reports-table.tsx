"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/client-api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Select, Textarea } from "@/components/ui/field";
import { ToggleGroup } from "@/components/ui/toggle-group";
import { Pill } from "@/components/ui/badge";
import { Modal } from "@/components/ui/modal";
import { Alert, EmptyState, ErrorState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { formatNumber, formatRelativeTime } from "@/lib/cn";

/**
 * Report moderation queue.
 *
 * Each row carries a preview of the reported target, so a decision can be made
 * without leaving the queue. Resolving a report has real consequences (reputation
 * penalty, content hidden), which is why a resolution note is required.
 */

type Report = {
  id: string;
  targetType: string;
  targetId: string;
  reason: string;
  description: string | null;
  status: string;
  severity: number;
  resolutionNote: string | null;
  createdAt: string;
  resolvedAt: string | null;
  reporter: { username: string; name: string; reputation: number };
  resolvedBy: { username: string; name: string } | null;
  preview: Record<string, unknown> | null;
};

const FILTERS = [
  { value: "OPEN", label: "باز" },
  { value: "UNDER_REVIEW", label: "در بررسی" },
  { value: "RESOLVED", label: "تأییدشده" },
  { value: "DISMISSED", label: "رد‌شده" },
  { value: "ALL", label: "همه" },
] as const;

type Filter = (typeof FILTERS)[number]["value"];

const TARGET_LABELS: Record<string, string> = {
  USER: "کاربر",
  VIDEO: "ویدیو",
  SUPPORT: "حمایت",
  CAMPAIGN: "کمپین",
};

export function AdminReportsTable() {
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>("OPEN");
  const [items, setItems] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [target, setTarget] = useState<Report | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api.get<{ items: Report[] }>(`/api/v1/admin/reports?status=${filter}&limit=20`);
      setItems(data.items);
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
      <ToggleGroup<Filter> label="فیلتر گزارش‌ها" options={[...FILTERS]} value={filter} onChange={setFilter} size="sm" className="mb-5 w-fit" />

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : loading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="skeleton h-24 rounded-xl" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState title="گزارشی در این وضعیت نیست" description="صف بررسی خالی است." />
      ) : (
        <ul className="space-y-3">
          {items.map((report) => (
            <li key={report.id}>
              <Card className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Pill tone="info">{TARGET_LABELS[report.targetType] ?? report.targetType}</Pill>
                      <p className="text-sm font-bold">{report.reason}</p>
                      <Pill
                        tone={
                          report.status === "OPEN"
                            ? "warning"
                            : report.status === "UNDER_REVIEW"
                              ? "info"
                              : report.status === "RESOLVED"
                                ? "danger"
                                : "neutral"
                        }
                      >
                        {FILTERS.find((f) => f.value === report.status)?.label ?? report.status}
                      </Pill>
                    </div>
                    {report.description && <p className="mt-1.5 text-sm leading-7 text-fg-muted">{report.description}</p>}
                    <p className="latin mt-1.5 text-xs text-fg-subtle" dir="ltr">
                      by @{report.reporter.username}
                    </p>
                  </div>

                  {report.status !== "RESOLVED" && report.status !== "DISMISSED" && (
                    <Button variant="outline" size="sm" onClick={() => setTarget(report)}>
                      بررسی
                    </Button>
                  )}
                </div>

                {report.preview && (
                  <pre
                    dir="ltr"
                    className="latin mt-3 max-h-32 overflow-auto rounded-lg bg-surface-sunken p-2.5 text-[0.6875rem] leading-5 text-fg-muted"
                  >
                    {JSON.stringify(report.preview, null, 2)}
                  </pre>
                )}

                {report.resolutionNote && (
                  <p className="mt-2 rounded-md bg-surface-sunken px-2 py-1.5 text-xs leading-6">
                    یادداشت بررسی: {report.resolutionNote}
                    {report.resolvedBy && ` — ${report.resolvedBy.name}`}
                  </p>
                )}

                <p className="mt-2 text-[0.6875rem] text-fg-subtle">
                  {formatRelativeTime(report.createdAt)} · شدت <span className="numeric">{formatNumber(report.severity)}</span>
                </p>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <ResolveModal
        report={target}
        open={target !== null}
        onClose={() => setTarget(null)}
        onDone={async () => {
          toast.push({ tone: "success", message: "گزارش بروزرسانی شد." });
          await load();
        }}
      />
    </div>
  );
}

function ResolveModal({
  report,
  open,
  onClose,
  onDone,
}: {
  report: Report | null;
  open: boolean;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!report) return;
    const form = new FormData(event.currentTarget);
    setLoading(true);
    setError("");
    try {
      await api.post("/api/v1/admin/reports", {
        reportId: report.id,
        status: String(form.get("status") ?? "UNDER_REVIEW"),
        resolutionNote: String(form.get("resolutionNote") ?? ""),
      });
      await onDone();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  if (!report) return null;

  return (
    <Modal open={open} onClose={onClose} title="بررسی گزارش" description="تأیید گزارش، اعتبار کیفی هدف را کاهش می‌دهد و محتوا را پنهان می‌کند.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && (
          <Alert tone="danger" live="alert">
            {error}
          </Alert>
        )}

        <Field label="نتیجه بررسی" htmlFor="status" required>
          <Select id="status" name="status" defaultValue="UNDER_REVIEW">
            <option value="UNDER_REVIEW">در حال بررسی</option>
            <option value="RESOLVED">تأیید تخلف</option>
            <option value="DISMISSED">رد گزارش</option>
          </Select>
        </Field>

        <Field label="یادداشت بررسی" htmlFor="resolutionNote">
          <Textarea id="resolutionNote" name="resolutionNote" />
        </Field>

        <Button type="submit" loading={loading} fullWidth>
          ثبت نتیجه
        </Button>
      </form>
    </Modal>
  );
}

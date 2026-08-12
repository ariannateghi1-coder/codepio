"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/client-api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ToggleGroup } from "@/components/ui/toggle-group";
import { Pill } from "@/components/ui/badge";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { formatDuration, formatNumber, formatRelativeTime } from "@/lib/cn";

/**
 * Platform-wide campaign oversight. Distinct from the creator studio: this view
 * spans every owner and is gated on campaign:manage_any.
 */

type Campaign = {
  id: string;
  title: string;
  status: string;
  startAt: string;
  endAt: string;
  rewardCredits: number;
  budgetCredits: number;
  spentCredits: number;
  requiredWatchPercent: number;
  creator: { username: string; name: string; reputation: number } | null;
  video: { title: string; youtubeVideoId: string; durationSec: number | null } | null;
  _count: { supports: number; sessions: number };
};

const FILTERS = [
  { value: "ALL", label: "همه" },
  { value: "ACTIVE", label: "فعال" },
  { value: "PAUSED", label: "متوقف" },
  { value: "ENDED", label: "پایان‌یافته" },
] as const;

type Filter = (typeof FILTERS)[number]["value"];

export function AdminCampaignsTable() {
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>("ACTIVE");
  const [items, setItems] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api.get<{ items: Campaign[] }>(`/api/v1/admin/campaigns?status=${filter}&limit=20`);
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

  async function act(campaignId: string, action: "PAUSE" | "END" | "ACTIVATE") {
    const reason = window.prompt("دلیل این اقدام را وارد کنید:");
    if (!reason || reason.trim().length < 3) return;
    try {
      await api.post("/api/v1/admin/campaigns", { campaignId, action, reason: reason.trim() });
      toast.push({ tone: "success", message: "وضعیت کمپین بروزرسانی شد." });
      await load();
    } catch (e) {
      toast.push({ tone: "error", message: errorMessage(e) });
    }
  }

  return (
    <div>
      <ToggleGroup<Filter> label="فیلتر کمپین‌ها" options={[...FILTERS]} value={filter} onChange={setFilter} size="sm" className="mb-5 w-fit" />

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : loading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="skeleton h-24 rounded-xl" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState title="کمپینی یافت نشد" description="فیلتر دیگری را امتحان کنید." />
      ) : (
        <ul className="space-y-3">
          {items.map((campaign) => (
            <li key={campaign.id}>
              <Card className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-bold">{campaign.title}</h3>
                      <Pill
                        tone={campaign.status === "ACTIVE" ? "success" : campaign.status === "PAUSED" ? "warning" : "neutral"}
                      >
                        {FILTERS.find((f) => f.value === campaign.status)?.label ?? campaign.status}
                      </Pill>
                    </div>
                    {campaign.creator && (
                      <p className="latin mt-1 text-xs text-fg-subtle" dir="ltr">
                        @{campaign.creator.username}
                      </p>
                    )}
                    {campaign.video && (
                      <p className="clamp-2 mt-1 text-xs text-fg-muted">
                        {campaign.video.title}
                        {campaign.video.durationSec != null && ` · ${formatDuration(campaign.video.durationSec)}`}
                      </p>
                    )}
                  </div>

                  <div className="flex gap-1.5">
                    {campaign.status === "ACTIVE" && (
                      <Button size="sm" variant="outline" onClick={() => act(campaign.id, "PAUSE")}>
                        توقف
                      </Button>
                    )}
                    {campaign.status === "PAUSED" && (
                      <Button size="sm" variant="outline" onClick={() => act(campaign.id, "ACTIVATE")}>
                        فعال‌سازی
                      </Button>
                    )}
                    {campaign.status !== "ENDED" && (
                      <Button size="sm" variant="ghost" onClick={() => act(campaign.id, "END")}>
                        پایان
                      </Button>
                    )}
                  </div>
                </div>

                <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {[
                    { label: "حمایت", value: formatNumber(campaign._count.supports) },
                    { label: "نشست", value: formatNumber(campaign._count.sessions) },
                    { label: "پاداش", value: formatNumber(campaign.rewardCredits) },
                    {
                      label: "بودجه",
                      value:
                        campaign.budgetCredits === 0
                          ? "بی‌نهایت"
                          : `${formatNumber(campaign.spentCredits)}/${formatNumber(campaign.budgetCredits)}`,
                    },
                  ].map((item) => (
                    <div key={item.label} className="rounded-lg bg-surface-sunken p-2 text-center">
                      <dt className="text-[0.625rem] text-fg-subtle">{item.label}</dt>
                      <dd className="numeric text-sm font-bold">{item.value}</dd>
                    </div>
                  ))}
                </dl>

                <p className="mt-2 text-[0.6875rem] text-fg-subtle">پایان {formatRelativeTime(campaign.endAt)}</p>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

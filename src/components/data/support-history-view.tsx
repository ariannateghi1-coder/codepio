"use client";

import { useCallback, useEffect, useState } from "react";
import { Heart, RotateCcw } from "lucide-react";
import { api, errorMessage } from "@/lib/client-api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Avatar } from "@/components/ui/avatar";
import { Pill } from "@/components/ui/badge";
import { ToggleGroup } from "@/components/ui/toggle-group";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Metric } from "@/components/layout/page";
import { formatNumber, formatRelativeTime } from "@/lib/cn";

/**
 * Support history.
 *
 * A reversed support stays visible with its reason — hiding it would make the
 * record less honest — but it is excluded from the totals, which count only ACTIVE
 * rows. That distinction is the whole point of the status column.
 */

type SupportRow = {
  id: string;
  status: "ACTIVE" | "REVERSED";
  mutual: boolean;
  creditsAwarded: number;
  xpAwarded: number;
  createdAt: string;
  reversedAt: string | null;
  reversalReason: string | null;
  direction: "given" | "received";
  supporter: { username: string; name: string; avatarUrl: string | null; level: number };
  receiver: { username: string; name: string; avatarUrl: string | null; level: number };
  campaign: { id: string; title: string } | null;
  video: { id: string; title: string; thumbnailUrl: string | null } | null;
};

const DIRECTIONS = [
  { value: "all", label: "همه" },
  { value: "given", label: "انجام‌شده" },
  { value: "received", label: "دریافتی" },
] as const;

type Direction = (typeof DIRECTIONS)[number]["value"];

export function SupportHistoryView() {
  const [direction, setDirection] = useState<Direction>("all");
  const [items, setItems] = useState<SupportRow[]>([]);
  const [totals, setTotals] = useState({ given: 0, received: 0, reversed: 0 });
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api.get<{
        items: SupportRow[];
        nextCursor: string | null;
        totals: { given: number; received: number; reversed: number };
      }>(`/api/v1/support/history?direction=${direction}&limit=20`);
      setItems(data.items);
      setTotals(data.totals);
      setCursor(data.nextCursor);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [direction]);

  useEffect(() => {
    void load();
  }, [load]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const data = await api.get<{ items: SupportRow[]; nextCursor: string | null }>(
        `/api/v1/support/history?direction=${direction}&limit=20&cursor=${cursor}`
      );
      setItems((current) => [...current, ...data.items]);
      setCursor(data.nextCursor);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div>
      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <Metric label="حمایت انجام‌شده" value={formatNumber(totals.given)} />
        <Metric label="حمایت دریافتی" value={formatNumber(totals.received)} />
        <Metric
          label="برگشت‌خورده"
          value={formatNumber(totals.reversed)}
          tone={totals.reversed > 0 ? "warning" : "neutral"}
          hint={totals.reversed > 0 ? "در آمار محاسبه نمی‌شوند" : undefined}
        />
      </div>

      <ToggleGroup<Direction>
        label="جهت حمایت"
        options={[...DIRECTIONS]}
        value={direction}
        onChange={setDirection}
        size="sm"
        className="mb-5 w-fit"
      />

      {error && items.length === 0 ? (
        <ErrorState message={error} onRetry={load} />
      ) : loading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="skeleton h-20 rounded-xl" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          title="حمایتی ثبت نشده"
          description="اولین حمایت تأییدشده شما همین‌جا با جزئیات پاداش نمایش داده می‌شود."
          action={{ label: "شروع از کاوش", href: "/explore" }}
        />
      ) : (
        <>
          <ul className="space-y-2">
            {items.map((row) => {
              const counterpart = row.direction === "given" ? row.receiver : row.supporter;
              return (
                <li key={row.id}>
                  <Card className={row.status === "REVERSED" ? "border-warning/30 p-3" : "p-3"}>
                    <div className="flex items-start gap-3">
                      <Avatar src={counterpart.avatarUrl} name={counterpart.name} size="sm" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-bold">{counterpart.name}</p>
                          <Pill tone={row.direction === "given" ? "accent" : "info"}>
                            {row.direction === "given" ? "حمایت کردید" : "حمایت شدید"}
                          </Pill>
                          {row.mutual && <Pill tone="success">متقابل</Pill>}
                          {row.status === "REVERSED" && (
                            <Pill tone="warning" icon={<RotateCcw aria-hidden size={11} />}>
                              برگشت‌خورده
                            </Pill>
                          )}
                        </div>

                        {row.campaign && <p className="clamp-2 mt-1 text-xs leading-6 text-fg-muted">{row.campaign.title}</p>}

                        {row.status === "REVERSED" && row.reversalReason && (
                          <p className="mt-1.5 rounded-md bg-warning-soft px-2 py-1 text-xs leading-6 text-warning">
                            دلیل برگشت: {row.reversalReason}
                          </p>
                        )}

                        <time className="mt-1.5 block text-xs text-fg-subtle" dateTime={row.createdAt}>
                          {formatRelativeTime(row.createdAt)}
                        </time>
                      </div>

                      <div className="text-end">
                        <p
                          className={`numeric text-sm font-black ${row.status === "REVERSED" ? "text-fg-subtle line-through" : "text-accent"}`}
                        >
                          +{formatNumber(row.creditsAwarded)}
                        </p>
                        <p className="text-[0.6875rem] text-fg-subtle">اعتبار</p>
                      </div>
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>

          {cursor && (
            <div className="mt-6 flex justify-center">
              <Button variant="outline" onClick={loadMore} loading={loadingMore} icon={<Heart aria-hidden size={15} />}>
                نمایش بیشتر
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

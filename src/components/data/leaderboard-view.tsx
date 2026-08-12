"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Crown, Medal, Trophy } from "lucide-react";
import { api, errorMessage } from "@/lib/client-api";
import { ToggleGroup } from "@/components/ui/toggle-group";
import { Card } from "@/components/ui/card";
import { Avatar } from "@/components/ui/avatar";
import { Pill, TierBadge } from "@/components/ui/badge";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { cn, formatNumber } from "@/lib/cn";

/**
 * Leaderboard.
 *
 * Period figures come from the ledger, so "XP this week" is literally the sum of
 * this week's ledger entries — and because a reversal writes a negative entry,
 * reversed supports cancel out instead of needing to be filtered.
 *
 * The viewer's own standing is always shown, including when they're outside the
 * visible top N, so the board is useful rather than aspirational.
 */

type Row = {
  rank: number;
  userId: string;
  username: string;
  name: string;
  avatarUrl: string | null;
  level: number;
  reputation: number;
  rankTier: string;
  rankTierLabel: string;
  score: number;
  credits: number;
  xp: number;
  supports: number;
  badges: { code: string; name: string; icon: string }[];
  growth?: number;
};

type Response = {
  period: string;
  mode: string;
  items: Row[];
  viewer: { rank: number | null; score: number; inTop: boolean } | null;
};

const PERIODS = [
  { value: "WEEKLY", label: "هفتگی" },
  { value: "MONTHLY", label: "ماهانه" },
  { value: "ALL_TIME", label: "کل" },
] as const;

const MODES = [
  { value: "TOP_SUPPORTERS", label: "حامیان برتر" },
  { value: "TOP_CREATORS", label: "سازندگان برتر" },
  { value: "HIGHEST_REPUTATION", label: "بالاترین اعتبار" },
  { value: "RISING", label: "در حال رشد" },
] as const;

type Period = (typeof PERIODS)[number]["value"];
type Mode = (typeof MODES)[number]["value"];

export function LeaderboardView() {
  const [period, setPeriod] = useState<Period>("WEEKLY");
  const [mode, setMode] = useState<Mode>("TOP_SUPPORTERS");
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await api.get<Response>(`/api/v1/leaderboard?period=${period}&mode=${mode}&limit=50`));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [period, mode]);

  useEffect(() => {
    void load();
  }, [load]);

  const podium = data?.items.slice(0, 3) ?? [];
  const rest = data?.items.slice(3) ?? [];

  return (
    <div>
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <ToggleGroup<Mode> label="نوع رتبه‌بندی" options={[...MODES]} value={mode} onChange={setMode} size="sm" />
        <ToggleGroup<Period> label="بازه زمانی" options={[...PERIODS]} value={period} onChange={setPeriod} size="sm" />
      </div>

      {data?.viewer && (
        <Card variant="sunken" className="mb-5 flex flex-wrap items-center justify-between gap-3 p-4">
          <span className="text-sm font-semibold">جایگاه شما</span>
          <span className="flex items-center gap-3 text-sm">
            <span className="numeric font-black">
              {data.viewer.rank ? `#${formatNumber(data.viewer.rank)}` : "خارج از ۱۰۰ نفر برتر"}
            </span>
            <span className="text-fg-muted">
              امتیاز دوره: <span className="numeric font-bold text-fg">{formatNumber(data.viewer.score)}</span>
            </span>
          </span>
        </Card>
      )}

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : loading ? (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="skeleton h-40 rounded-xl" />
            ))}
          </div>
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="skeleton h-16 rounded-xl" />
          ))}
        </div>
      ) : (data?.items.length ?? 0) === 0 ? (
        <EmptyState
          title="رتبه‌ای برای این بازه ثبت نشده"
          description="با انجام حمایت تأییدشده، امتیاز دوره شما ثبت و در همین جدول نمایش داده می‌شود."
          action={{ label: "شروع از کاوش", href: "/explore" }}
        />
      ) : (
        <>
          {/* Top three get a distinct treatment; the rest is a dense scannable list. */}
          <ol className="mb-5 grid gap-3 sm:grid-cols-3">
            {podium.map((row, index) => (
              <li key={row.userId}>
                <Card
                  variant="raised"
                  className={cn(
                    "items-center p-5 text-center",
                    index === 0 && "border-tier-gold/40",
                    index === 1 && "border-tier-silver/40",
                    index === 2 && "border-tier-bronze/40"
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "mb-3 grid size-9 place-items-center rounded-pill",
                      index === 0 && "bg-tier-gold/15 text-tier-gold",
                      index === 1 && "bg-tier-silver/15 text-tier-silver",
                      index === 2 && "bg-tier-bronze/15 text-tier-bronze"
                    )}
                  >
                    {index === 0 ? <Crown size={18} /> : index === 1 ? <Trophy size={17} /> : <Medal size={17} />}
                  </span>
                  <Avatar src={row.avatarUrl} name={row.name} size="lg" />
                  <Link href={`/members/${row.username}`} className="mt-3 font-bold hover:text-accent">
                    {row.name}
                  </Link>
                  <p className="latin text-xs text-fg-subtle" dir="ltr">
                    @{row.username}
                  </p>
                  <p className="numeric mt-3 text-2xl font-black text-accent">{formatNumber(row.score)}</p>
                  <p className="text-xs text-fg-subtle">امتیاز دوره</p>
                  <TierBadge tier={row.rankTier} label={row.rankTierLabel} className="mt-3" />
                </Card>
              </li>
            ))}
          </ol>

          <ol className="space-y-2">
            {rest.map((row) => (
              <li key={row.userId}>
                <Card className="flex-row items-center gap-3 p-3">
                  <span className="numeric w-9 shrink-0 text-center text-sm font-black text-fg-subtle">#{formatNumber(row.rank)}</span>
                  <Avatar src={row.avatarUrl} name={row.name} size="sm" />
                  <div className="min-w-0 flex-1">
                    <Link href={`/members/${row.username}`} className="truncate-1 text-sm font-bold hover:text-accent">
                      {row.name}
                    </Link>
                    <p className="latin truncate-1 text-xs text-fg-subtle" dir="ltr">
                      @{row.username}
                    </p>
                  </div>
                  <div className="hidden gap-1.5 sm:flex">
                    {row.badges.slice(0, 3).map((badge) => (
                      <span key={badge.code} title={badge.name} aria-hidden className="text-base">
                        {badge.icon}
                      </span>
                    ))}
                  </div>
                  {row.growth !== undefined && (
                    <Pill tone="success" className="numeric">
                      +{formatNumber(row.growth)}
                    </Pill>
                  )}
                  <div className="text-end">
                    <p className="numeric text-sm font-black">{formatNumber(row.score)}</p>
                    <p className="text-[0.6875rem] text-fg-subtle">امتیاز</p>
                  </div>
                </Card>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

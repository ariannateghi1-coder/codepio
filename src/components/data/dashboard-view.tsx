"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Award, Bell, Flame, Heart, TrendingUp, Trophy } from "lucide-react";
import { api, errorMessage } from "@/lib/client-api";
import { Metric, Section } from "@/components/layout/page";
import { Card, CardBody, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Pill, TierBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ProgressBar } from "@/components/ui/progress";
import { Alert, EmptyState, ErrorState, SkeletonCard } from "@/components/ui/states";
import { ExploreCard, type ExploreCardData } from "./cards";
import { SupportFlow } from "./support-flow";
import { ComplianceBanner } from "./compliance-banner";
import { formatNumber, formatRelativeTime } from "@/lib/cn";
import { rankTierLabel } from "@/lib/gamification";
import type { RankTier } from "@prisma/client";

/**
 * Dashboard.
 *
 * One request populates the whole view, because the API composes it server-side in
 * a single parallel batch instead of the page issuing several dependent calls.
 * Every figure shown maps to a real aggregate; where history is insufficient (e.g.
 * a week-over-week trend with no prior week) the UI says so rather than printing 0%.
 */

type Dashboard = {
  user: {
    username: string;
    name: string;
    avatarUrl: string | null;
    credits: number;
    points: number;
    level: number;
    reputation: number;
    rankTier: string;
    rankTierLabel: string;
    currentStreakDays: number;
    longestStreakDays: number;
    progress: { current: number; next: number | null; progress: number; nextXp: number | null };
  };
  stats: {
    given: number;
    received: number;
    reversed: number;
    unread: number;
    pendingRewards: number;
    completionRate: number | null;
    weeklyXp: number;
    weeklyTrend: number | null;
    weeklyRank: number | null;
  };
  wallet: {
    balance: number;
    granted: number;
    earned: number;
    spentOnExposure: number;
    /** Credits currently reserved in the user's own running campaigns. */
    escrowed: number;
    reversed: number;
    adjustments: number;
    pending: number;
  };
  recentNotifications: { id: string; title: string; message: string; read: boolean; createdAt: string }[];
  badges: { code: string; name: string; icon: string; earnedAt: string }[];
  activeCampaigns: {
    id: string;
    title: string;
    rewardCredits: number;
    budgetRemaining: number | null;
    endAt: string;
    _count: { supports: number };
  }[];
  exploreHighlights: ExploreCardData[];
};

export function DashboardView() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [activeCampaign, setActiveCampaign] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await api.get<Dashboard>("/api/v1/dashboard"));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="skeleton h-32 w-full rounded-xl" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="skeleton h-24 rounded-xl" />
          ))}
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <SkeletonCard key={index} />
          ))}
        </div>
      </div>
    );
  }

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return null;

  const { user, stats } = data;

  return (
    <div>
      {/*
        Subscription compliance, ABOVE everything else: while it is violated the
        user cannot start a support at all, so burying it under the stats would
        leave them clicking «شروع حمایت» into an error with no explanation.
        Renders nothing when there is nothing wrong, and costs no YouTube quota to
        display — see compliance-banner.tsx.

        onRestored reloads the dashboard because a restore changes what the user
        may do next, and the figures here should reflect it immediately.
      */}
      <div className="mb-6">
        <ComplianceBanner onRestored={load} />
      </div>

      {/* Level + progress: the single most important status block. */}
      <Card variant="raised" className="mb-6 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm text-fg-muted">سلام {user.name}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-black">سطح {formatNumber(user.level)}</h2>
              <TierBadge tier={user.rankTier} label={user.rankTierLabel} />
              {user.currentStreakDays > 0 && (
                <Pill tone="warning" icon={<Flame aria-hidden size={12} />}>
                  {formatNumber(user.currentStreakDays)} روز پیوسته
                </Pill>
              )}
            </div>
          </div>
          <div className="flex gap-2">
            <Link href="/explore">
              <Button icon={<Heart aria-hidden size={16} />}>شروع حمایت</Button>
            </Link>
            <Link href="/studio">
              <Button variant="outline">استودیو</Button>
            </Link>
          </div>
        </div>

        <ProgressBar
          className="mt-5"
          label={user.progress.next ? `پیشرفت تا سطح ${formatNumber(user.progress.next)}` : "بالاترین سطح"}
          value={user.progress.progress}
          max={100}
        />
      </Card>

      {stats.pendingRewards > 0 && (
        <Alert tone="warning" title="پاداش در انتظار بررسی" className="mb-6">
          {formatNumber(stats.pendingRewards)} حمایت شما برای بررسی نهایی علامت‌گذاری شده است. پاداش پس از تأیید اعمال می‌شود.
        </Alert>
      )}

      <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="اعتبار" value={formatNumber(user.credits)} tone="accent" />
        <Metric
          label="XP این هفته"
          value={formatNumber(stats.weeklyXp)}
          trend={stats.weeklyTrend}
          hint={stats.weeklyTrend === null ? "بدون سابقه هفته قبل" : "نسبت به هفته گذشته"}
        />
        <Metric
          label="نرخ تکمیل"
          value={stats.completionRate === null ? "—" : `${formatNumber(stats.completionRate)}٪`}
          hint={stats.completionRate === null ? "هنوز حمایتی ثبت نشده" : undefined}
        />
        <Metric
          label="رتبه هفتگی"
          value={stats.weeklyRank ? `#${formatNumber(stats.weeklyRank)}` : "—"}
          hint={stats.weeklyRank ? undefined : "خارج از ۱۰۰ نفر برتر"}
          tone="success"
        />
      </div>

      <div className="mb-8 grid gap-3 sm:grid-cols-3">
        <Metric label="حمایت انجام‌شده" value={formatNumber(stats.given)} />
        <Metric label="حمایت دریافتی" value={formatNumber(stats.received)} />
        <Metric
          label="حمایت برگشتی"
          value={formatNumber(stats.reversed)}
          tone={stats.reversed > 0 ? "warning" : "neutral"}
          hint={stats.reversed > 0 ? "در آمار محاسبه نمی‌شوند" : undefined}
        />
      </div>

      {/* Credit wallet: credits are a currency, so the loop earn → spend on
          exposure → receive support has to be legible. Every figure is a sum of
          real ledger entries, not a derived guess. */}
      <Section
        title="کیف اعتبار"
        description="اعتبار بین کاربران جابه‌جا می‌شود: بودجه کمپین شما به حامیان پرداخت می‌شود و حمایت شما از دیگران، اعتبار آن‌ها را به شما می‌رساند. مقدار هر حمایت برای همه یکسان و ثابت است."
        actions={
          <Link href="/support/history" className="text-sm font-bold text-accent">
            تاریخچه
          </Link>
        }
      >
        <Card variant="raised" className="p-5">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-xs font-semibold text-fg-subtle">موجودی فعلی</p>
              <p className="numeric mt-1 text-3xl font-black text-accent">{formatNumber(data.wallet.balance)}</p>
            </div>
            <Link href="/studio">
              <Button variant="outline" size="sm">
                خرج برای دیده‌شدن
              </Button>
            </Link>
          </div>

          <dl className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { label: "هدیه ثبت‌نام", value: data.wallet.granted, tone: "text-fg" },
              { label: "کسب‌شده از حمایت", value: data.wallet.earned, tone: "text-success" },
              {
                label: "در بودجه کمپین",
                value: data.wallet.escrowed,
                tone: data.wallet.escrowed > 0 ? "text-accent" : "text-fg-subtle",
              },
              { label: "برگشت‌خورده", value: data.wallet.reversed, tone: data.wallet.reversed > 0 ? "text-warning" : "text-fg-subtle" },
            ].map((item) => (
              <div key={item.label} className="rounded-lg bg-surface-sunken p-3">
                <dt className="text-[0.6875rem] leading-5 text-fg-subtle">{item.label}</dt>
                <dd className={`numeric mt-0.5 text-base font-bold ${item.tone}`}>{formatNumber(item.value)}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </Section>

      <Section
        title="پیشنهاد برای شما"
        description="بر اساس اعتبار، تازگی و ت��وع انتخاب شده‌اند."
        actions={
          <Link href="/explore" className="text-sm font-bold text-accent">
            همه کاوش
          </Link>
        }
      >
        {data.exploreHighlights.length === 0 ? (
          <EmptyState
            title="کمپین فعالی برای شما نیست"
            description="به‌محض انتشار کمپین تازه، همین‌جا نمایش داده می‌شود."
            action={{ label: "رفتن به کاوش", href: "/explore" }}
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {data.exploreHighlights.map((item) => (
              <ExploreCard
                key={item.campaignId}
                data={item}
                tierLabel={rankTierLabel(item.creator.rankTier as RankTier)}
                onStart={setActiveCampaign}
              />
            ))}
          </div>
        )}
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="کمپین‌های من">
          {data.activeCampaigns.length === 0 ? (
            <EmptyState
              title="کمپین فعالی ندارید"
              description="یک ویدیو اضافه کنید و کمپین بسازید تا در کاوش دیده شود."
              action={{ label: "ساخت کم��ین", href: "/studio" }}
            />
          ) : (
            <div className="space-y-3">
              {data.activeCampaigns.map((campaign) => (
                <Card key={campaign.id} className="p-4">
                  <CardHeader className="p-0">
                    <CardTitle className="text-sm">{campaign.title}</CardTitle>
                  </CardHeader>
                  <CardBody className="px-0 py-2 text-xs">
                    <span className="numeric">{formatNumber(campaign._count.supports)}</span> حمایت ·{" "}
                    پاداش <span className="numeric">{formatNumber(campaign.rewardCredits)}</span> اعتبار
                    {campaign.budgetRemaining !== null && (
                      <>
                        {" "}· باقی‌مانده بودجه <span className="numeric">{formatNumber(campaign.budgetRemaining)}</span>
                      </>
                    )}
                  </CardBody>
                  <CardFooter className="px-0 pb-0 pt-1">
                    <span className="text-xs text-fg-subtle">پایان {formatRelativeTime(campaign.endAt)}</span>
                    <Link href="/studio" className="ms-auto">
                      <Button variant="ghost" size="sm">
                        مدیریت
                      </Button>
                    </Link>
                  </CardFooter>
                </Card>
              ))}
            </div>
          )}
        </Section>

        <Section
          title="آخرین اعلان‌ها"
          actions={
            <Link href="/notifications" className="text-sm font-bold text-accent">
              همه
            </Link>
          }
        >
          {data.recentNotifications.length === 0 ? (
            <EmptyState title="اعلانی ندارید" description="حمایت‌ها و رویدادهای حساب شما اینجا نمایش داده می‌شوند." />
          ) : (
            <ul className="space-y-2">
              {data.recentNotifications.map((notification) => (
                <li
                  key={notification.id}
                  className={`rounded-xl border p-3 ${notification.read ? "border-border bg-surface" : "border-accent/30 bg-accent-soft"}`}
                >
                  <div className="flex items-start gap-2.5">
                    <Bell aria-hidden size={16} className="mt-1 shrink-0 text-fg-subtle" />
                    <div className="min-w-0">
                      <p className="text-sm font-bold">{notification.title}</p>
                      <p className="mt-0.5 text-xs leading-6 text-fg-muted">{notification.message}</p>
                      <time className="mt-1 block text-[0.6875rem] text-fg-subtle" dateTime={notification.createdAt}>
                        {formatRelativeTime(notification.createdAt)}
                      </time>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <Section title="نشان‌های من" description="از تاریخچه واقعی حمایت‌ها محاسبه می‌شوند.">
        {data.badges.length === 0 ? (
          <EmptyState
            title="هنوز نشانی نگرفته‌اید"
            description="اولین حمایت تأییدشده، اولین نشان شما را باز می‌کند."
            action={{ label: "شروع از کاوش", href: "/explore" }}
          />
        ) : (
          <ul className="flex flex-wrap gap-2">
            {data.badges.map((badge) => (
              <li key={badge.code}>
                <Pill tone="success" icon={<Award aria-hidden size={12} />}>
                  {badge.icon} {badge.name}
                </Pill>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <div className="flex flex-wrap gap-3">
        <Link href="/leaderboard">
          <Button variant="outline" icon={<Trophy aria-hidden size={16} />}>
            جدول رتبه‌بندی
          </Button>
        </Link>
        <Link href="/support/history">
          <Button variant="ghost" icon={<TrendingUp aria-hidden size={16} />}>
            تاریخچه حمایت‌ها
          </Button>
        </Link>
      </div>

      <SupportFlow
        campaignId={activeCampaign}
        open={activeCampaign !== null}
        onClose={() => setActiveCampaign(null)}
        onCompleted={load}
      />
    </div>
  );
}

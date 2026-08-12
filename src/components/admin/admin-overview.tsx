"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Flag, Megaphone, ScrollText, ShieldCheck, Users } from "lucide-react";
import { api, errorMessage } from "@/lib/client-api";
import { Card } from "@/components/ui/card";
import { Metric } from "@/components/layout/page";
import { Alert, ErrorState } from "@/components/ui/states";
import { Pill } from "@/components/ui/badge";
import { formatNumber } from "@/lib/cn";

/**
 * Admin console overview.
 *
 * Data-dense by design, and it surfaces two things an ops dashboard usually
 * hides: the moderation backlog (open reports + rewards held for review) and a
 * ledger consistency check comparing cached balances against ledger sums, so
 * accounting drift is observable instead of assumed impossible.
 */

type Overview = {
  users: { byStatus: Record<string, number>; total: number; activeToday: number };
  supports: { today: number; week: number; reversedWeek: number };
  moderation: { openReports: number; pendingReviews: number; abuseSignalsWeek: number };
  campaigns: { active: number };
  economy: {
    creditsIssuedWeek: number;
    cachedCredits: number;
    ledgerCredits: number;
    cachedXp: number;
    ledgerXp: number;
    consistent: boolean;
  };
  systemHealth: { ready: boolean; missing: string[] };
};

const LINKS = [
  { href: "/admin/users", title: "کاربران", description: "وضعیت، نقش‌ها و بررسی حساب‌ها", icon: Users },
  { href: "/admin/supports", title: "حمایت‌ها", description: "صف بررسی و برگشت حمایت", icon: ShieldCheck },
  { href: "/admin/reports", title: "گزارش‌ها", description: "گردش‌کار بررسی تخلف", icon: Flag },
  { href: "/admin/campaigns", title: "کمپین‌ها", description: "نظارت بر کمپین‌های پلتفرم", icon: Megaphone },
  { href: "/admin/audit", title: "گزارش عملیات", description: "ردگیری اقدامات حساس", icon: ScrollText },
] as const;

export function AdminOverview() {
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await api.get<Overview>("/api/v1/admin/overview"));
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
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, index) => (
          <div key={index} className="skeleton h-24 rounded-xl" />
        ))}
      </div>
    );
  }

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return null;

  return (
    <div className="space-y-6">
      {!data.economy.consistent && (
        <Alert tone="danger" title="اختلاف در دفتر حساب" live="alert">
          مجموع موجودی کش‌شده با مجموع دفتر حساب برابر نیست. این یک هشدار جدی است و باید بررسی شود.
          <span className="numeric mt-1 block text-xs">
            اعتبار: {formatNumber(data.economy.cachedCredits)} / {formatNumber(data.economy.ledgerCredits)} — XP:{" "}
            {formatNumber(data.economy.cachedXp)} / {formatNumber(data.economy.ledgerXp)}
          </span>
        </Alert>
      )}

      {!data.systemHealth.ready && (
        <Alert tone="warning" title="پیکربندی ناقص سرویس‌ها">
          <ul className="mt-1 list-inside list-disc text-xs leading-7">
            {data.systemHealth.missing.map((item) => (
              <li key={item} className="latin" dir="ltr">
                {item}
              </li>
            ))}
          </ul>
        </Alert>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="کل کاربران" value={formatNumber(data.users.total)} hint={`${formatNumber(data.users.activeToday)} فعال امروز`} />
        <Metric label="حمایت امروز" value={formatNumber(data.supports.today)} hint={`${formatNumber(data.supports.week)} در هفته`} />
        <Metric
          label="در انتظار بررسی"
          value={formatNumber(data.moderation.pendingReviews)}
          tone={data.moderation.pendingReviews > 0 ? "warning" : "neutral"}
        />
        <Metric
          label="گزارش باز"
          value={formatNumber(data.moderation.openReports)}
          tone={data.moderation.openReports > 0 ? "warning" : "neutral"}
        />
        <Metric label="کمپین فعال" value={formatNumber(data.campaigns.active)} />
        <Metric label="اعتبار صادرشده (هفته)" value={formatNumber(data.economy.creditsIssuedWeek)} tone="accent" />
        <Metric
          label="حمایت برگشتی (هفته)"
          value={formatNumber(data.supports.reversedWeek)}
          tone={data.supports.reversedWeek > 0 ? "warning" : "neutral"}
        />
        <Metric
          label="سیگنال سوءاستفاده (هفته)"
          value={formatNumber(data.moderation.abuseSignalsWeek)}
          tone={data.moderation.abuseSignalsWeek > 0 ? "warning" : "neutral"}
        />
      </div>

      <Card className="p-4">
        <h2 className="mb-3 text-sm font-bold">وضعیت حساب‌ها</h2>
        <ul className="flex flex-wrap gap-2">
          {Object.entries(data.users.byStatus).map(([status, count]) => (
            <li key={status}>
              <Pill tone={status === "BANNED" ? "danger" : status === "SUSPENDED" ? "warning" : "success"}>
                {status === "ACTIVE" ? "فعال" : status === "SUSPENDED" ? "معلق" : "مسدود"}:{" "}
                <span className="numeric">{formatNumber(count)}</span>
              </Pill>
            </li>
          ))}
        </ul>
      </Card>

      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {LINKS.map((link) => {
          const Icon = link.icon;
          return (
            <li key={link.href}>
              <Link href={link.href}>
                <Card interactive className="h-full p-4">
                  <span aria-hidden className="mb-3 grid size-10 place-items-center rounded-lg bg-accent-soft text-accent">
                    <Icon size={18} />
                  </span>
                  <h3 className="text-sm font-bold">{link.title}</h3>
                  <p className="mt-1 text-xs leading-6 text-fg-muted">{link.description}</p>
                </Card>
              </Link>
            </li>
          );
        })}
      </ul>

      {data.moderation.pendingReviews > 0 && (
        <Alert tone="info" title="صف بررسی">
          <span className="inline-flex items-center gap-2">
            <AlertTriangle aria-hidden size={14} />
            {formatNumber(data.moderation.pendingReviews)} حمایت در انتظار تصمیم است.
            <Link href="/admin/supports?status=PENDING_REVIEW" className="font-bold text-accent">
              بررسی
            </Link>
          </span>
        </Alert>
      )}
    </div>
  );
}

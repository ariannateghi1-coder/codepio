import type { Metadata } from "next";
import { unstable_cache } from "next/cache";
import { AppShell } from "@/components/layout/app-shell";
import { PageHeader } from "@/components/layout/page";
import { Card } from "@/components/ui/card";
import { Pill } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/states";
import { prisma } from "@/lib/prisma";
import { formatNumber } from "@/lib/cn";

export const metadata: Metadata = {
  title: "نشان‌ها",
  description: "نشان‌های قابل کسب و شرایط واقعی هرکدام.",
};

/**
 * Badge catalogue.
 *
 * Holder counts are real aggregates, and each badge shows the reward it actually
 * pays — the same values the badge engine reads, since both come from the Badge
 * table seeded from the requirement definitions.
 *
 * Rendered per request with the query cached for 10 minutes, so a production build
 * does not require a reachable database (`next build` would otherwise try to
 * prerender this page and fail).
 */
export const dynamic = "force-dynamic";

const getBadgeCatalogue = unstable_cache(
  async () =>
    prisma.badge.findMany({
      orderBy: { rewardXp: "asc" },
      select: {
        code: true,
        name: true,
        description: true,
        icon: true,
        rewardCredits: true,
        rewardXp: true,
        _count: { select: { users: true } },
      },
    }),
  ["badge-catalogue"],
  { revalidate: 600, tags: ["badges"] }
);

export default async function BadgesPage() {
  const badges = await getBadgeCatalogue();

  return (
    <AppShell>
      <PageHeader title="نشان‌ها" description="هر نشان از تاریخچه واقعی حمایت‌ها محاسبه می‌شود و پاداش آن در دفتر حساب ثبت می‌گردد." />

      {badges.length === 0 ? (
        <EmptyState title="نشانی تعریف نشده" description="فهرست نشان‌ها هنوز مقداردهی نشده است." />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {badges.map((badge) => (
            <li key={badge.code}>
              <Card className="h-full p-5">
                <span aria-hidden className="mb-3 text-3xl">
                  {badge.icon}
                </span>
                <h2 className="text-sm font-bold">{badge.name}</h2>
                <p className="mt-1.5 flex-1 text-sm leading-7 text-fg-muted">{badge.description}</p>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {badge.rewardCredits > 0 && (
                    <Pill tone="accent" className="numeric">
                      +{formatNumber(badge.rewardCredits)} اعتبار
                    </Pill>
                  )}
                  {badge.rewardXp > 0 && (
                    <Pill className="numeric">+{formatNumber(badge.rewardXp)} XP</Pill>
                  )}
                  <span className="numeric ms-auto text-xs text-fg-subtle">
                    {formatNumber(badge._count.users)} نفر
                  </span>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </AppShell>
  );
}

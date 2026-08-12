import { prisma } from "@/lib/prisma";
import { moderator } from "@/lib/handler";
import { productionReadiness } from "@/lib/env";

/**
 * Admin overview.
 *
 * Every figure is a real aggregate. `systemHealth` reports which optional
 * subsystems are actually configured, so a half-configured deployment is visible
 * to operators instead of silently degraded.
 */
export const GET = moderator(
  "admin.overview",
  async () => {
    const now = Date.now();
    const dayAgo = new Date(now - 86_400_000);
    const weekAgo = new Date(now - 7 * 86_400_000);

    const [
      usersByStatus,
      activeToday,
      supportsToday,
      supportsWeek,
      reversedWeek,
      openReports,
      pendingReviews,
      activeCampaigns,
      creditsIssuedWeek,
      abuseSignalsWeek,
      ledgerDrift,
    ] = await Promise.all([
      prisma.user.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.user.count({ where: { lastActiveAt: { gte: dayAgo } } }),
      prisma.support.count({ where: { status: "ACTIVE", createdAt: { gte: dayAgo } } }),
      prisma.support.count({ where: { status: "ACTIVE", createdAt: { gte: weekAgo } } }),
      prisma.support.count({ where: { status: "REVERSED", reversedAt: { gte: weekAgo } } }),
      prisma.report.count({ where: { status: { in: ["OPEN", "UNDER_REVIEW"] } } }),
      prisma.supportSession.count({ where: { rewardState: "PENDING_REVIEW" } }),
      prisma.campaign.count({ where: { status: "ACTIVE", endAt: { gte: new Date() } } }),
      prisma.creditLedger.aggregate({ where: { createdAt: { gte: weekAgo }, amount: { gt: 0 } }, _sum: { amount: true } }),
      prisma.abuseSignal.count({ where: { createdAt: { gte: weekAgo } } }),
      // Cheap invariant check: cached balances vs. ledger sums across the platform.
      Promise.all([
        prisma.user.aggregate({ _sum: { credits: true, points: true } }),
        prisma.creditLedger.aggregate({ _sum: { amount: true } }),
        prisma.xpLedger.aggregate({ _sum: { amount: true } }),
      ]),
    ]);

    const [userTotals, creditTotals, xpTotals] = ledgerDrift;

    return {
      users: {
        byStatus: Object.fromEntries(usersByStatus.map((row) => [row.status, row._count._all])),
        total: usersByStatus.reduce((sum, row) => sum + row._count._all, 0),
        activeToday,
      },
      supports: { today: supportsToday, week: supportsWeek, reversedWeek },
      moderation: { openReports, pendingReviews, abuseSignalsWeek },
      campaigns: { active: activeCampaigns },
      economy: {
        creditsIssuedWeek: creditsIssuedWeek._sum.amount ?? 0,
        cachedCredits: userTotals._sum.credits ?? 0,
        ledgerCredits: creditTotals._sum.amount ?? 0,
        cachedXp: userTotals._sum.points ?? 0,
        ledgerXp: xpTotals._sum.amount ?? 0,
        consistent:
          (userTotals._sum.credits ?? 0) === (creditTotals._sum.amount ?? 0) &&
          (userTotals._sum.points ?? 0) === (xpTotals._sum.amount ?? 0),
      },
      systemHealth: productionReadiness(),
    };
  },
  { csrf: false }
);

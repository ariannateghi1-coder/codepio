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
      // True issuance: only SIGNUP_GRANT creates credits. Summing all positive
      // entries would count the receiving half of every transfer and report a
      // growing supply that does not exist.
      prisma.creditLedger.aggregate({
        where: { createdAt: { gte: weekAgo }, type: "SIGNUP_GRANT" },
        _sum: { amount: true },
      }),
      prisma.abuseSignal.count({ where: { createdAt: { gte: weekAgo } } }),
      // Cheap invariant check: cached balances vs. ledger sums across the platform.
      Promise.all([
        prisma.user.aggregate({ _sum: { credits: true, points: true } }),
        prisma.creditLedger.aggregate({ _sum: { amount: true } }),
        // UserDailyRollup, not XpLedger: the detail table is pruned after 7 days, so
        // comparing it against User.points would report platform-wide XP "drift"
        // that grows with every cleanup run and would keep the alarm permanently on.
        prisma.userDailyRollup.aggregate({ _sum: { xp: true } }),
        // Credits sitting in campaign escrow: debited from creators, not yet
        // transferred to supporters. Needed to state total supply correctly.
        prisma.campaign.aggregate({
          where: { status: { in: ["DRAFT", "ACTIVE", "PAUSED"] } },
          _sum: { budgetCredits: true, spentCredits: true },
        }),
      ]),
    ]);

    const [userTotals, creditTotals, xpTotals, escrowTotals] = ledgerDrift;
    const escrowed = Math.max(
      0,
      (escrowTotals._sum.budgetCredits ?? 0) - (escrowTotals._sum.spentCredits ?? 0)
    );

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
        /** Newly created credits (signup grants only), not transfer volume. */
        creditsIssuedWeek: creditsIssuedWeek._sum.amount ?? 0,
        cachedCredits: userTotals._sum.credits ?? 0,
        ledgerCredits: creditTotals._sum.amount ?? 0,
        cachedXp: userTotals._sum.points ?? 0,
        ledgerXp: xpTotals._sum.xp ?? 0,
        /** Credits held in campaign budgets, i.e. debited but not yet transferred. */
        escrowedCredits: escrowed,
        /**
         * Total credits in existence: user balances plus what is parked in escrow.
         * Should only ever move when an account is created.
         */
        totalSupply: (userTotals._sum.credits ?? 0) + escrowed,
        consistent:
          (userTotals._sum.credits ?? 0) === (creditTotals._sum.amount ?? 0) &&
          (userTotals._sum.points ?? 0) === (xpTotals._sum.xp ?? 0),
      },
      systemHealth: productionReadiness(),
    };
  },
  { csrf: false }
);

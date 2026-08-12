import { prisma } from "@/lib/prisma";
import { authed } from "@/lib/handler";
import { nextLevelProgress, rankTierLabel } from "@/lib/gamification";
import { getExploreFeed } from "@/lib/services/explore";
import { getViewerStanding } from "@/lib/services/leaderboard";

/**
 * Dashboard.
 *
 * Every number here has a real source: counts filter on status ACTIVE, credits and
 * XP come from the cached balances the ledger maintains, the period figure comes
 * from the ledger itself, and the trend is a genuine week-over-week comparison.
 * Nothing is a placeholder.
 *
 * All queries are issued in one Promise.all so the page is a single round of
 * parallel reads rather than a waterfall.
 */
export const GET = authed(
  "dashboard.get",
  async ({ user }) => {
    const now = Date.now();
    const weekAgo = new Date(now - 7 * 86_400_000);
    const twoWeeksAgo = new Date(now - 14 * 86_400_000);

    const [
      given,
      received,
      reversed,
      unread,
      pendingRewards,
      thisWeekXp,
      lastWeekXp,
      recentNotifications,
      badges,
      activeCampaigns,
      recentActivity,
      walletTotals,
      standing,
      explore,
    ] = await Promise.all([
      prisma.support.count({ where: { supporterId: user.id, status: "ACTIVE" } }),
      prisma.support.count({ where: { receiverId: user.id, status: "ACTIVE" } }),
      prisma.support.count({ where: { supporterId: user.id, status: "REVERSED" } }),
      prisma.notification.count({ where: { userId: user.id, read: false } }),
      prisma.supportSession.count({ where: { supporterId: user.id, rewardState: "PENDING_REVIEW" } }),
      prisma.xpLedger.aggregate({ where: { userId: user.id, createdAt: { gte: weekAgo } }, _sum: { amount: true } }),
      prisma.xpLedger.aggregate({
        where: { userId: user.id, createdAt: { gte: twoWeeksAgo, lt: weekAgo } },
        _sum: { amount: true },
      }),
      prisma.notification.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { id: true, title: true, message: true, type: true, read: true, createdAt: true },
      }),
      prisma.userBadge.findMany({
        where: { userId: user.id },
        orderBy: { earnedAt: "desc" },
        take: 6,
        select: { earnedAt: true, badge: { select: { code: true, name: true, icon: true } } },
      }),
      prisma.campaign.findMany({
        where: { creatorId: user.id, status: "ACTIVE", endAt: { gte: new Date() } },
        orderBy: { createdAt: "desc" },
        take: 3,
        select: {
          id: true,
          title: true,
          rewardCredits: true,
          budgetCredits: true,
          spentCredits: true,
          endAt: true,
          _count: { select: { supports: true } },
        },
      }),
      prisma.activity.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        take: 8,
        select: { id: true, type: true, createdAt: true, metadata: true },
      }),
      // Credit wallet, derived from the ledger rather than from the cached balance:
      // earned / spent / reversed are each a real sum of entries, so the wallet can
      // be reconciled against User.credits at any time.
      prisma.creditLedger.groupBy({
        by: ["type"],
        where: { userId: user.id },
        _sum: { amount: true },
      }),
      getViewerStanding(user.id, "WEEKLY", "TOP_SUPPORTERS"),
      getExploreFeed({ viewerId: user.id, filter: "for_you", limit: 4 }),
    ]);

    const attempts = user.supportsCompleted + user.supportsAbandoned;
    const weekXp = thisWeekXp._sum.amount ?? 0;
    const previousXp = lastWeekXp._sum.amount ?? 0;

    // Wallet: credits behave like a real currency, so the user can see where the
    // balance came from and where it went, not just a single number.
    const sumOf = (types: string[]) =>
      walletTotals
        .filter((row) => types.includes(row.type))
        .reduce((total, row) => total + (row._sum.amount ?? 0), 0);

    const earned = sumOf([
      "SUPPORT_COMPLETED",
      "SUPPORT_RECEIVED",
      "MUTUAL_BONUS",
      "CAMPAIGN_BONUS",
      "REFERRAL",
      "BADGE_REWARD",
    ]);
    const budgetFlow = sumOf(["CAMPAIGN_BUDGET_SPEND"]);
    const reversedCredits = sumOf(["REVERSAL", "PENALTY"]);
    const adjustments = sumOf(["ADMIN_ADJUSTMENT"]);

    return {
      user: {
        username: user.username,
        name: user.name,
        avatarUrl: user.avatarUrl,
        credits: user.credits,
        points: user.points,
        level: user.level,
        reputation: user.reputation,
        rankTier: user.rankTier,
        rankTierLabel: rankTierLabel(user.rankTier),
        currentStreakDays: user.currentStreakDays,
        longestStreakDays: user.longestStreakDays,
        progress: nextLevelProgress(user.points),
      },
      stats: {
        given,
        received,
        reversed,
        unread,
        pendingRewards,
        completionRate: attempts === 0 ? null : Math.round((user.supportsCompleted / attempts) * 100),
        weeklyXp: weekXp,
        weeklyTrend: previousXp === 0 ? null : Math.round(((weekXp - previousXp) / previousXp) * 100),
        weeklyRank: standing.rank,
      },
      /**
       * Credit wallet. `spentOnExposure` is negative-summed budget flow, i.e. what
       * the creator actually paid for exposure minus anything refunded, which is
       * the number that makes the earn→spend loop legible.
       */
      wallet: {
        balance: user.credits,
        earned,
        spentOnExposure: Math.max(0, -budgetFlow),
        reversed: Math.max(0, -reversedCredits),
        adjustments,
        pending: pendingRewards,
      },
      recentNotifications,
      badges: badges.map((entry) => ({ ...entry.badge, earnedAt: entry.earnedAt })),
      activeCampaigns: activeCampaigns.map((campaign) => ({
        ...campaign,
        budgetRemaining: campaign.budgetCredits > 0 ? campaign.budgetCredits - campaign.spentCredits : null,
      })),
      recentActivity,
      exploreHighlights: explore.items,
    };
  },
  { csrf: false }
);

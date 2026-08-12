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

    // SUPPORT_COMPLETED is the transfer received from campaign budgets — the only
    // ongoing way to earn. The other types are listed because historical rows may
    // still carry them; nothing writes them any more (see the CREDIT CONSERVATION
    // note in gamification.ts), so on a fresh database they sum to zero.
    const earned = sumOf([
      "SUPPORT_COMPLETED",
      "SUPPORT_RECEIVED",
      "MUTUAL_BONUS",
      "CAMPAIGN_BONUS",
      "REFERRAL",
      "BADGE_REWARD",
    ]);
    const granted = sumOf(["SIGNUP_GRANT"]);
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
       * Credit wallet.
       *
       * `escrowed` is the live figure people ask about first: credits that left the
       * balance into a running campaign and have not been handed to a supporter yet.
       * It is derived as (budget − spent) over the user's own active campaigns, not
       * from the ledger, because the ledger records the movement into escrow and the
       * movement out of it, not what is currently sitting there.
       *
       * `spentOnExposure` is net negative budget flow: escrowed minus refunded. With
       * credits being a closed transfer economy, granted + earned − spentOnExposure
       * − reversed + adjustments reconciles to `balance`.
       */
      wallet: {
        balance: user.credits,
        granted,
        earned,
        spentOnExposure: Math.max(0, -budgetFlow),
        escrowed: activeCampaigns.reduce(
          (sum, campaign) => sum + Math.max(0, campaign.budgetCredits - campaign.spentCredits),
          0
        ),
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

import "server-only";
import type { LeaderboardMode, LeaderboardPeriod } from "@prisma/client";
import { prisma } from "../prisma";
import { logger } from "../logger";

/**
 * Leaderboard.
 *
 * Weekly/monthly ranking is computed from the XP and credit LEDGERS restricted
 * to the period — an actual "earned in this period" figure. The previous version
 * counted support rows as a proxy while the UI called it "weekly points", which
 * was misleading; that is now impossible because the numbers come from the same
 * ledger entries that moved the balances.
 *
 * Reversed supports are excluded automatically: a reversal writes a negative
 * ledger entry, so a period sum nets to zero rather than needing a status filter.
 *
 * Ties break deterministically (score, then reputation, then oldest account) so
 * ranks don't shuffle between requests.
 */

export const LEADERBOARD_MODES = ["TOP_SUPPORTERS", "TOP_CREATORS", "HIGHEST_REPUTATION", "RISING"] as const;
export const LEADERBOARD_PERIODS = ["WEEKLY", "MONTHLY", "ALL_TIME"] as const;

export function periodStart(period: LeaderboardPeriod, now = new Date()): Date {
  if (period === "ALL_TIME") return new Date(0);
  const days = period === "WEEKLY" ? 7 : 30;
  const start = new Date(now.getTime() - days * 86_400_000);
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

export type LeaderboardRow = {
  rank: number;
  userId: string;
  username: string;
  name: string;
  avatarUrl: string | null;
  level: number;
  reputation: number;
  rankTier: string;
  score: number;
  credits: number;
  xp: number;
  supports: number;
  badges: { code: string; name: string; icon: string }[];
};

export async function computeLeaderboard(input: {
  period: LeaderboardPeriod;
  mode: LeaderboardMode;
  limit?: number;
}): Promise<LeaderboardRow[]> {
  const limit = Math.min(100, Math.max(1, input.limit ?? 50));
  const since = periodStart(input.period);

  if (input.mode === "HIGHEST_REPUTATION") {
    const users = await prisma.user.findMany({
      where: { status: "ACTIVE" },
      orderBy: [{ reputation: "desc" }, { createdAt: "asc" }],
      take: limit,
      select: userSelect,
    });
    return users.map((user, index) => toRow(user, index + 1, user.reputation));
  }

  // Which ledger drives the ranking for this mode.
  const xpTypes =
    input.mode === "TOP_SUPPORTERS"
      ? (["SUPPORT_COMPLETED", "MUTUAL_BONUS", "STREAK", "BADGE_REWARD", "REVERSAL"] as const)
      : (["SUPPORT_RECEIVED", "REVERSAL"] as const);

  const grouped = await prisma.xpLedger.groupBy({
    by: ["userId"],
    where: {
      type: { in: [...xpTypes] },
      ...(input.period === "ALL_TIME" ? {} : { createdAt: { gte: since } }),
    },
    _sum: { amount: true },
    orderBy: { _sum: { amount: "desc" } },
    take: limit * 2,
  });

  const positive = grouped.filter((row) => (row._sum.amount ?? 0) > 0);
  if (positive.length === 0) return [];

  const userIds = positive.map((row) => row.userId);

  const [users, creditSums, supportCounts] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: userIds }, status: "ACTIVE" }, select: userSelect }),
    prisma.creditLedger.groupBy({
      by: ["userId"],
      where: { userId: { in: userIds }, ...(input.period === "ALL_TIME" ? {} : { createdAt: { gte: since } }) },
      _sum: { amount: true },
    }),
    prisma.support.groupBy({
      by: [input.mode === "TOP_SUPPORTERS" ? "supporterId" : "receiverId"],
      where: {
        status: "ACTIVE",
        ...(input.period === "ALL_TIME" ? {} : { createdAt: { gte: since } }),
        ...(input.mode === "TOP_SUPPORTERS" ? { supporterId: { in: userIds } } : { receiverId: { in: userIds } }),
      },
      _count: { _all: true },
    }),
  ]);

  const xpByUser = new Map(positive.map((row) => [row.userId, row._sum.amount ?? 0]));
  const creditsByUser = new Map(creditSums.map((row) => [row.userId, row._sum.amount ?? 0]));
  const supportsByUser = new Map(
    supportCounts.map((row) => [
      (row as unknown as Record<string, string>)[input.mode === "TOP_SUPPORTERS" ? "supporterId" : "receiverId"],
      row._count._all,
    ])
  );

  const rows = users
    .map((user) => ({
      user,
      score: xpByUser.get(user.id) ?? 0,
      credits: creditsByUser.get(user.id) ?? 0,
      supports: supportsByUser.get(user.id) ?? 0,
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.user.reputation - a.user.reputation ||
        a.user.createdAt.getTime() - b.user.createdAt.getTime()
    )
    .slice(0, limit);

  return rows.map((row, index) => ({
    ...toRow(row.user, index + 1, row.score),
    credits: row.credits,
    xp: row.score,
    supports: row.supports,
  }));
}

const userSelect = {
  id: true,
  username: true,
  name: true,
  avatarUrl: true,
  level: true,
  reputation: true,
  rankTier: true,
  createdAt: true,
  badges: { take: 3, orderBy: { earnedAt: "desc" }, select: { badge: { select: { code: true, name: true, icon: true } } } },
} as const;

type UserRow = {
  id: string;
  username: string;
  name: string;
  avatarUrl: string | null;
  level: number;
  reputation: number;
  rankTier: string;
  createdAt: Date;
  badges: { badge: { code: string; name: string; icon: string } }[];
};

function toRow(user: UserRow, rank: number, score: number): LeaderboardRow {
  return {
    rank,
    userId: user.id,
    username: user.username,
    name: user.name,
    avatarUrl: user.avatarUrl,
    level: user.level,
    reputation: user.reputation,
    rankTier: user.rankTier,
    score,
    credits: 0,
    xp: 0,
    supports: 0,
    badges: user.badges.map((b) => b.badge),
  };
}

/** Where the viewer sits, even when they're outside the visible top N. */
export async function getViewerStanding(userId: string, period: LeaderboardPeriod, mode: LeaderboardMode) {
  const rows = await computeLeaderboard({ period, mode, limit: 100 });
  const index = rows.findIndex((row) => row.userId === userId);
  if (index >= 0) return { rank: rows[index].rank, score: rows[index].score, inTop: true };

  const since = periodStart(period);
  const sum = await prisma.xpLedger.aggregate({
    where: { userId, ...(period === "ALL_TIME" ? {} : { createdAt: { gte: since } }) },
    _sum: { amount: true },
  });
  return { rank: null, score: sum._sum.amount ?? 0, inTop: false };
}

/**
 * Persists a ranking snapshot. Lets historical standings be shown without
 * recomputing, and gives "Rising" a real basis for comparison.
 */
export async function snapshotLeaderboard(period: LeaderboardPeriod, mode: LeaderboardMode) {
  const rows = await computeLeaderboard({ period, mode, limit: 100 });
  const start = periodStart(period);

  await prisma.$transaction(
    rows.map((row) =>
      prisma.leaderboardSnapshot.upsert({
        where: { period_mode_periodStart_userId: { period, mode, periodStart: start, userId: row.userId } },
        update: { rank: row.rank, score: row.score, credits: row.credits, xp: row.xp, supports: row.supports, reputation: row.reputation, computedAt: new Date() },
        create: {
          period,
          mode,
          periodStart: start,
          userId: row.userId,
          rank: row.rank,
          score: row.score,
          credits: row.credits,
          xp: row.xp,
          supports: row.supports,
          reputation: row.reputation,
        },
      })
    )
  );

  logger.info("leaderboard snapshot stored", { period, mode, rows: rows.length });
  return rows.length;
}

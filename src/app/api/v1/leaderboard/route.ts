import { prisma } from "@/lib/prisma";
import { parseQuery } from "@/lib/api";
import { publicRoute } from "@/lib/handler";
import { leaderboardQuerySchema } from "@/lib/validators";
import { computeLeaderboard, getViewerStanding } from "@/lib/services/leaderboard";
import { rankTierLabel } from "@/lib/gamification";

/**
 * Leaderboard.
 *
 * Period ranking is computed from the XP/credit ledgers restricted to the period —
 * a genuine "earned this week" figure. Because a reversal writes a negative ledger
 * entry, reversed supports drop out of the period total automatically.
 *
 * "Rising" compares the current period against the previous snapshot, so it means
 * actual growth rather than raw volume.
 */
export const GET = publicRoute(
  "leaderboard.get",
  async ({ url, viewer }) => {
    const query = parseQuery(url, leaderboardQuerySchema);

    if (query.mode === "RISING") {
      const [current, previous] = await Promise.all([
        computeLeaderboard({ period: query.period, mode: "TOP_SUPPORTERS", limit: 100 }),
        prisma.leaderboardSnapshot.findMany({
          where: { period: query.period, mode: "TOP_SUPPORTERS" },
          orderBy: { periodStart: "desc" },
          take: 100,
          select: { userId: true, score: true },
        }),
      ]);

      const previousByUser = new Map(previous.map((row) => [row.userId, row.score]));
      const rising = current
        .map((row) => ({ ...row, growth: row.score - (previousByUser.get(row.userId) ?? 0) }))
        .filter((row) => row.growth > 0)
        .sort((a, b) => b.growth - a.growth || b.score - a.score)
        .slice(0, query.limit)
        .map((row, index) => ({ ...row, rank: index + 1, rankTierLabel: rankTierLabel(row.rankTier as never) }));

      return {
        period: query.period,
        mode: query.mode,
        items: rising,
        viewer: viewer ? await getViewerStanding(viewer.id, query.period, "TOP_SUPPORTERS") : null,
      };
    }

    const items = await computeLeaderboard(query);

    return {
      period: query.period,
      mode: query.mode,
      items: items.map((row) => ({ ...row, rankTierLabel: rankTierLabel(row.rankTier as never) })),
      viewer: viewer ? await getViewerStanding(viewer.id, query.period, query.mode) : null,
    };
  },
  { rateLimit: "publicSearch", csrf: false }
);

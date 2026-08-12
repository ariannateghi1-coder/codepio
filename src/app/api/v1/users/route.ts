import { prisma } from "@/lib/prisma";
import { parseQuery } from "@/lib/api";
import { publicRoute } from "@/lib/handler";
import { searchSchema } from "@/lib/validators";
import { rankTierLabel } from "@/lib/gamification";
import type { Prisma } from "@prisma/client";

/**
 * Public member directory.
 *
 * Privacy: the select list is explicit and contains no email, session, ledger,
 * trustScore or audit data. Counts are restricted to ACTIVE supports so a
 * reversed support never inflates a public profile.
 *
 * Abuse: paginated with a hard cap, query length bounded by the schema, and
 * sorting limited to an allow-list so no caller can pick an unindexed column.
 */
export const GET = publicRoute(
  "users.list",
  async ({ url }) => {
    const query = parseQuery(url, searchSchema);

    const where: Prisma.UserWhereInput = {
      status: "ACTIVE",
      ...(query.q
        ? {
            OR: [
              { username: { contains: query.q, mode: "insensitive" } },
              { name: { contains: query.q, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const orderBy: Prisma.UserOrderByWithRelationInput[] =
      query.sort === "credits"
        ? [{ credits: "desc" }, { createdAt: "asc" }]
        : query.sort === "recent"
          ? [{ createdAt: "desc" }]
          : query.sort === "supports"
            ? [{ supportsCompleted: "desc" }, { createdAt: "asc" }]
            : [{ reputation: "desc" }, { createdAt: "asc" }];

    const [items, total] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy,
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          id: true,
          username: true,
          name: true,
          avatarUrl: true,
          bio: true,
          country: true,
          level: true,
          reputation: true,
          rankTier: true,
          youtubeVerified: true,
          createdAt: true,
          badges: { take: 3, orderBy: { earnedAt: "desc" }, select: { badge: { select: { code: true, name: true, icon: true } } } },
          _count: { select: { supportsGiven: { where: { status: "ACTIVE" } }, supportsReceived: { where: { status: "ACTIVE" } } } },
        },
      }),
      prisma.user.count({ where }),
    ]);

    return {
      items: items.map((user) => ({
        ...user,
        rankTierLabel: rankTierLabel(user.rankTier),
        badges: user.badges.map((b) => b.badge),
      })),
      total,
      page: query.page,
      limit: query.limit,
      hasMore: query.page * query.limit < total,
    };
  },
  { rateLimit: "publicSearch", csrf: false }
);

import { prisma } from "@/lib/prisma";
import { publicRoute } from "@/lib/handler";

/** Public badge catalogue with real holder counts. */
export const GET = publicRoute(
  "badges.list",
  async () => ({
    items: await prisma.badge.findMany({
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
  }),
  { rateLimit: "publicSearch", csrf: false }
);

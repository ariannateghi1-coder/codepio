import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { parseQuery } from "@/lib/api";
import { authed } from "@/lib/handler";

/**
 * The viewer's own support history.
 *
 * Cursor pagination (id-based) rather than OFFSET: histories grow without bound
 * and deep offsets get progressively more expensive.
 *
 * `status` is always selected and returned, and the aggregate counters count only
 * ACTIVE rows — a reversed support must never inflate anyone's statistics.
 */
const querySchema = z.object({
  direction: z.enum(["given", "received", "all"]).default("all"),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const GET = authed(
  "support.history",
  async ({ url, user }) => {
    const query = parseQuery(url, querySchema);

    const where =
      query.direction === "given"
        ? { supporterId: user.id }
        : query.direction === "received"
          ? { receiverId: user.id }
          : { OR: [{ supporterId: user.id }, { receiverId: user.id }] };

    const rows = await prisma.support.findMany({
      where,
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        status: true,
        mutual: true,
        creditsAwarded: true,
        xpAwarded: true,
        createdAt: true,
        reversedAt: true,
        reversalReason: true,
        supporter: { select: { username: true, name: true, avatarUrl: true, level: true } },
        receiver: { select: { username: true, name: true, avatarUrl: true, level: true } },
        campaign: { select: { id: true, title: true } },
        video: { select: { id: true, title: true, thumbnailUrl: true, youtubeVideoId: true } },
      },
    });

    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;

    const [givenActive, receivedActive, reversed] = await Promise.all([
      prisma.support.count({ where: { supporterId: user.id, status: "ACTIVE" } }),
      prisma.support.count({ where: { receiverId: user.id, status: "ACTIVE" } }),
      prisma.support.count({ where: { supporterId: user.id, status: "REVERSED" } }),
    ]);

    return {
      items: items.map((row) => ({
        ...row,
        direction: row.supporter.username === user.username ? "given" : "received",
      })),
      nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null,
      totals: { given: givenActive, received: receivedActive, reversed },
    };
  },
  { csrf: false }
);

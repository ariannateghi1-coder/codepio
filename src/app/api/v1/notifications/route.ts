import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { parseBody, parseQuery } from "@/lib/api";
import { authed } from "@/lib/handler";
import { cursorSchema } from "@/lib/validators";

/**
 * Notifications list + read-state mutations.
 *
 * Every query is scoped to the viewer's own userId, so an id from another account
 * matches nothing — ownership is structural, not a separate check that could be
 * forgotten.
 *
 * `read-all` is a single atomic updateMany, and the unread count is derived from
 * the same predicate, so the badge can't drift from the list.
 */
export const GET = authed(
  "notifications.list",
  async ({ url, user }) => {
    const { cursor, limit } = parseQuery(url, cursorSchema);

    const rows = await prisma.notification.findMany({
      where: { userId: user.id },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        title: true,
        message: true,
        type: true,
        read: true,
        metadata: true,
        createdAt: true,
        actor: { select: { username: true, name: true, avatarUrl: true } },
      },
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const unread = await prisma.notification.count({ where: { userId: user.id, read: false } });

    return { items, unread, nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null };
  },
  { csrf: false }
);

const patchSchema = z.object({ id: z.string().min(10).optional(), all: z.boolean().optional() });

export const PATCH = authed(
  "notifications.markRead",
  async ({ req, user }) => {
    const body = await parseBody(req, patchSchema);

    if (body.all) {
      const result = await prisma.notification.updateMany({
        where: { userId: user.id, read: false },
        data: { read: true, deliveryStatus: "READ" },
      });
      return { updated: result.count, unread: 0 };
    }

    if (body.id) {
      await prisma.notification.updateMany({
        where: { id: body.id, userId: user.id },
        data: { read: true, deliveryStatus: "READ" },
      });
    }

    const unread = await prisma.notification.count({ where: { userId: user.id, read: false } });
    return { updated: body.id ? 1 : 0, unread };
  },
  { rateLimit: "notificationWrite" }
);

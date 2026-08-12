import { prisma } from "@/lib/prisma";
import { authed } from "@/lib/handler";

/** Unread badge count. Cheap, indexed, and derived from the same predicate the list uses. */
export const GET = authed(
  "notifications.unreadCount",
  async ({ user }) => ({ unread: await prisma.notification.count({ where: { userId: user.id, read: false } }) }),
  { csrf: false }
);

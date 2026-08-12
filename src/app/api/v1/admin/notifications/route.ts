import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { parseBody } from "@/lib/api";
import { admin } from "@/lib/handler";
import { broadcastSchema } from "@/lib/validators";
import { assertCan } from "@/lib/authz";
import { writeAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { sendPushToUser } from "@/lib/push";
import { publishUserNotification } from "@/lib/services/realtime";

/**
 * Announcement broadcast.
 *
 * Rows are written in bounded batches (createMany) rather than one transaction
 * over the whole user table, so a large audience cannot hold a long transaction
 * open. Fan-out to realtime/push is best effort and never fails the request.
 */
const BATCH_SIZE = 500;

export const POST = admin(
  "admin.broadcast",
  async ({ req, actor }) => {
    assertCan(actor, "notification:broadcast");
    const data = await parseBody(req, broadcastSchema);

    const where: Prisma.UserWhereInput =
      data.audience === "ALL"
        ? {}
        : data.audience === "STAFF"
          ? { role: { in: ["MODERATOR", "ADMIN", "SUPER_ADMIN"] } }
          : { status: "ACTIVE" };

    let created = 0;
    let cursor: string | undefined;

    for (;;) {
      const batch = await prisma.user.findMany({
        where,
        select: { id: true },
        orderBy: { id: "asc" },
        take: BATCH_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (batch.length === 0) break;

      const result = await prisma.notification.createMany({
        data: batch.map((user) => ({
          userId: user.id,
          actorId: actor.id,
          type: "ANNOUNCEMENT" as const,
          title: data.title,
          message: data.message,
        })),
      });
      created += result.count;
      cursor = batch[batch.length - 1].id;

      // Best effort real-time nudge; a failure here must not abort the broadcast.
      await Promise.allSettled(
        batch.map((user) =>
          Promise.allSettled([
            publishUserNotification(user.id, { type: "ANNOUNCEMENT", title: data.title, message: data.message }),
            sendPushToUser(user.id, { title: data.title, body: data.message, url: "/notifications" }),
          ])
        )
      );

      if (batch.length < BATCH_SIZE) break;
    }

    logger.info("broadcast sent", { audience: data.audience, created, actorId: actor.id });
    await writeAudit({
      userId: actor.id,
      action: "NOTIFICATION",
      entity: "Broadcast",
      req,
      metadata: { audience: data.audience, recipients: created },
    });

    return { recipients: created, message: `اعلان برای ${created} کاربر ارسال شد.` };
  },
  { rateLimit: "adminMutation" }
);

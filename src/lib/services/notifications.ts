import "server-only";
import type { NotificationType, Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { logger } from "../logger";
import { publishUserNotification } from "./realtime";
import { sendPushToUser } from "../push";

/**
 * Notification pipeline: persist → (best effort) realtime → (best effort) push.
 *
 * Ordering matters. The database row is the source of truth, so a failure in
 * Ably or Web Push can never roll back the user's action or turn into a 500 —
 * the client simply picks the notification up on its next load.
 *
 * `dedupeKey` makes creation idempotent for notifications that must never be
 * duplicated (badge awards, reward confirmations) even if the producing code is
 * retried.
 */

export type NotificationInput = {
  userId: string;
  actorId?: string | null;
  type: NotificationType;
  title: string;
  message: string;
  metadata?: Prisma.InputJsonValue;
  dedupeKey?: string;
};

/** Creates inside an existing transaction. Returns null when deduped away. */
export async function createNotificationTx(tx: Prisma.TransactionClient, input: NotificationInput) {
  try {
    return await tx.notification.create({
      data: {
        userId: input.userId,
        actorId: input.actorId ?? null,
        type: input.type,
        title: input.title,
        message: input.message,
        metadata: input.metadata,
        dedupeKey: input.dedupeKey,
      },
    });
  } catch (e) {
    if (typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002" && input.dedupeKey) {
      // Already delivered once — this is the idempotency guard doing its job,
      // not an error to swallow blindly.
      logger.debug("notification deduped", { dedupeKey: input.dedupeKey, userId: input.userId });
      return null;
    }
    throw e;
  }
}

/**
 * Fans a persisted notification out to realtime + push. Call AFTER the
 * transaction commits, so subscribers never see an event for rolled-back data.
 */
export async function deliverNotification(notification: {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  createdAt: Date;
  actor?: { id: string; username: string; name: string; avatarUrl: string | null } | null;
}) {
  const payload = {
    id: notification.id,
    type: notification.type,
    title: notification.title,
    message: notification.message,
    actor: notification.actor ?? null,
    createdAt: notification.createdAt.toISOString(),
  };

  const [realtime, push] = await Promise.allSettled([
    publishUserNotification(notification.userId, payload),
    sendPushToUser(notification.userId, {
      title: notification.title,
      body: notification.message,
      url: "/notifications",
    }),
  ]);

  if (realtime.status === "rejected") {
    logger.warn("realtime notification delivery failed", { userId: notification.userId, error: realtime.reason });
  }
  if (push.status === "rejected") {
    logger.warn("push notification delivery failed", { userId: notification.userId, error: push.reason });
  }

  const delivered = realtime.status === "fulfilled" || push.status === "fulfilled";
  await prisma.notification
    .update({ where: { id: notification.id }, data: { deliveryStatus: delivered ? "SENT" : "FAILED" } })
    .catch((e: unknown) => logger.warn("failed to update notification delivery status", { error: e }));
}

/** Convenience path for notifications created outside a transaction. */
export async function notify(input: NotificationInput) {
  const notification = await createNotificationTx(prisma, input);
  if (!notification) return null;

  const actor = input.actorId
    ? await prisma.user.findUnique({
        where: { id: input.actorId },
        select: { id: true, username: true, name: true, avatarUrl: true },
      })
    : null;

  await deliverNotification({ ...notification, actor });
  return notification;
}

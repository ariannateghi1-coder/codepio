import "server-only";
import webpush, { WebPushError } from "web-push";
import { prisma } from "./prisma";
import { env, features } from "./env";
import { logger } from "./logger";

/**
 * Web Push delivery.
 *
 * Per-subscription failure isolation: one dead endpoint must not block the user's
 * other devices. A 404/410 means the browser dropped the subscription, so the row
 * is deleted; other failures increment a counter and are retired after repeated
 * failures instead of being retried forever.
 */

let configured = false;

function ensureConfigured() {
  if (configured) return true;
  if (!features.webPush) return false;
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY!, env.VAPID_PRIVATE_KEY!);
  configured = true;
  return true;
}

const MAX_FAILURES = 5;

export async function sendPushToUser(userId: string, payload: { title: string; body: string; url?: string }) {
  if (!ensureConfigured()) return;

  const subs = await prisma.pushSubscription.findMany({ where: { userId } });
  if (subs.length === 0) return;

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload)
        );
        await prisma.pushSubscription.update({
          where: { endpoint: sub.endpoint },
          data: { failureCount: 0, lastSuccessAt: new Date() },
        });
      } catch (e) {
        const status = e instanceof WebPushError ? e.statusCode : undefined;
        if (status === 404 || status === 410) {
          await prisma.pushSubscription.delete({ where: { endpoint: sub.endpoint } }).catch(() => null);
          logger.debug("removed expired push subscription", { userId });
          return;
        }
        const next = sub.failureCount + 1;
        if (next >= MAX_FAILURES) {
          await prisma.pushSubscription.delete({ where: { endpoint: sub.endpoint } }).catch(() => null);
          logger.warn("retired push subscription after repeated failures", { userId, failures: next });
        } else {
          await prisma.pushSubscription
            .update({ where: { endpoint: sub.endpoint }, data: { failureCount: next } })
            .catch(() => null);
          logger.warn("push delivery failed", { userId, status, failures: next });
        }
      }
    })
  );
}

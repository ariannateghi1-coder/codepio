import { prisma } from "@/lib/prisma";
import { parseBody } from "@/lib/api";
import { authed } from "@/lib/handler";
import { pushSubscriptionSchema } from "@/lib/validators";
import { env, features } from "@/lib/env";
import { BusinessRuleError } from "@/lib/errors";
import { z } from "zod";

/**
 * Web Push subscription management.
 *
 * Ownership: `endpoint` is globally unique, and the upsert always sets userId to
 * the caller — so a device that changes accounts is re-bound rather than leaving
 * another user's notifications going to it.
 */
export const GET = authed(
  "push.status",
  async ({ user }) => ({
    enabled: features.webPush,
    publicKey: features.webPush ? (env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? env.VAPID_PUBLIC_KEY ?? null) : null,
    subscriptions: await prisma.pushSubscription.count({ where: { userId: user.id } }),
  }),
  { csrf: false }
);

export const POST = authed(
  "push.subscribe",
  async ({ req, user }) => {
    if (!features.webPush) throw new BusinessRuleError("اعلان مرورگر در این سرور پیکربندی نشده است.");

    const data = await parseBody(req, pushSubscriptionSchema);
    const subscription = await prisma.pushSubscription.upsert({
      where: { endpoint: data.endpoint },
      update: {
        userId: user.id,
        p256dh: data.keys.p256dh,
        auth: data.keys.auth,
        failureCount: 0,
        userAgent: req.headers.get("user-agent")?.slice(0, 300) ?? null,
      },
      create: {
        userId: user.id,
        endpoint: data.endpoint,
        p256dh: data.keys.p256dh,
        auth: data.keys.auth,
        userAgent: req.headers.get("user-agent")?.slice(0, 300) ?? null,
      },
      select: { id: true, createdAt: true },
    });

    return { subscription, message: "اعلان‌های مرورگر فعال شد." };
  },
  { rateLimit: "pushSubscribe" }
);

const deleteSchema = z.object({ endpoint: z.string().url() });

export const DELETE = authed("push.unsubscribe", async ({ req, user }) => {
  const { endpoint } = await parseBody(req, deleteSchema);
  const result = await prisma.pushSubscription.deleteMany({ where: { userId: user.id, endpoint } });
  return { removed: result.count, message: "اعلان‌های مرورگر غیرفعال شد." };
});

import { authed } from "@/lib/handler";
import { createAblyTokenRequest } from "@/lib/services/realtime";
import { features } from "@/lib/env";
import { BusinessRuleError } from "@/lib/errors";

/**
 * Mints a short-lived Ably token for the CALLER only.
 *
 * The capability is derived server-side from the authenticated user id, so there
 * is no request parameter a client could tamper with to subscribe to someone
 * else's channel.
 */
export const POST = authed(
  "realtime.token",
  async ({ user }) => {
    if (!features.realtime) throw new BusinessRuleError("سرویس realtime پیکربندی نشده است.");
    return { token: await createAblyTokenRequest(user.id), channel: `user:${user.id}:notifications` };
  },
  { rateLimit: "realtimeToken" }
);

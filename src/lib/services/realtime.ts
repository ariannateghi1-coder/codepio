import "server-only";
import Ably from "ably";
import { env, features } from "../env";
import { logger } from "../logger";
import { UpstreamError } from "../errors";

/**
 * Realtime (Ably).
 *
 * Channel naming is per-user (`user:<id>:notifications`) and token capability is
 * scoped to exactly that one channel with subscribe-only rights, so a token can
 * never be used to read someone else's stream. Tokens are short-lived (30 min)
 * and minted server-side after authentication.
 *
 * The whole layer is optional: without ABLY_API_KEY the app falls back to
 * database reads, and a publish failure is never allowed to fail a mutation.
 */

function client() {
  if (!features.realtime) return null;
  return new Ably.Rest(env.ABLY_API_KEY!);
}

export function userChannel(userId: string) {
  return `user:${userId}:notifications`;
}

export async function publishUserNotification(userId: string, payload: unknown) {
  const ably = client();
  if (!ably) return;
  try {
    await ably.channels.get(userChannel(userId)).publish("notification.created", payload);
  } catch (e) {
    // Rethrow so the caller's Promise.allSettled records it; callers never let
    // this break the request.
    logger.warn("ably publish failed", { userId, error: e });
    throw e;
  }
}

export async function createAblyTokenRequest(userId: string) {
  const ably = client();
  if (!ably) throw new UpstreamError("ably", "realtime is not configured");
  return ably.auth.createTokenRequest({
    clientId: userId,
    ttl: 1000 * 60 * 30,
    capability: JSON.stringify({ [userChannel(userId)]: ["subscribe"] }),
  });
}

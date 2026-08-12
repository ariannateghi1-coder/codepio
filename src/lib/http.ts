import "server-only";
import crypto from "crypto";
import { env } from "./env";

/**
 * Client IP extraction.
 *
 * x-forwarded-for is client-controlled for every hop the attacker can prepend,
 * so `xff.split(",")[0]` is trivially spoofable — a request with
 * `X-Forwarded-For: 1.2.3.4` gets a fresh rate-limit bucket every time.
 *
 * Correct rule: with N trusted proxies in front of the app, the real client is
 * the Nth entry counted FROM THE RIGHT (each trusted proxy appends the address
 * it saw). TRUSTED_PROXY_HOPS makes N explicit per deployment instead of guessed.
 */
export function getClientIp(req: Request): string {
  const hops = env.TRUSTED_PROXY_HOPS;

  if (hops > 0) {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) {
      const chain = xff
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
      const candidate = chain[chain.length - hops];
      if (candidate && isIpLike(candidate)) return candidate;
    }
    // Platform-specific single-value headers are set by the edge itself and
    // cannot be injected by the client, so they beat a parsed xff chain.
    const platform =
      req.headers.get("cf-connecting-ip") ||
      req.headers.get("x-nf-client-connection-ip") ||
      req.headers.get("x-real-ip");
    if (platform && isIpLike(platform)) return platform;
  }

  return "0.0.0.0";
}

function isIpLike(value: string) {
  return /^[0-9a-fA-F:.]{3,45}$/.test(value);
}

/**
 * Hashed IP for storage. Audit logs and abuse signals need to correlate
 * requests, but keeping raw IPs is a privacy liability, so we store a keyed
 * (SESSION_SECRET) digest instead — correlatable, not reversible.
 */
export function hashIp(ip: string): string {
  return crypto.createHmac("sha256", env.SESSION_SECRET).update(ip).digest("hex").slice(0, 32);
}

export function hashUserAgent(userAgent: string | null): string | null {
  if (!userAgent) return null;
  return crypto.createHmac("sha256", env.SESSION_SECRET).update(userAgent).digest("hex").slice(0, 32);
}

/** Correlation id for one request, echoed back in the response envelope. */
export function requestId(req: Request): string {
  return req.headers.get("x-request-id") || crypto.randomUUID();
}

/**
 * Human-readable device label for the session manager UI ("Chrome on Windows").
 * Deliberately coarse — enough to recognize your own devices, not a fingerprint.
 */
export function describeDevice(userAgent: string | null): string {
  if (!userAgent) return "دستگاه ناشناس";
  const ua = userAgent.toLowerCase();
  const browser = ua.includes("edg/")
    ? "Edge"
    : ua.includes("opr/") || ua.includes("opera")
      ? "Opera"
      : ua.includes("chrome") && !ua.includes("chromium")
        ? "Chrome"
        : ua.includes("firefox")
          ? "Firefox"
          : ua.includes("safari")
            ? "Safari"
            : "مرورگر";
  const os = ua.includes("windows")
    ? "Windows"
    : ua.includes("android")
      ? "Android"
      : ua.includes("iphone") || ua.includes("ipad")
        ? "iOS"
        : ua.includes("mac os")
          ? "macOS"
          : ua.includes("linux")
            ? "Linux"
            : "سیستم ناشناس";
  return `${browser} روی ${os}`;
}

/**
 * Same-origin check for state-changing requests: defense in depth alongside the
 * CSRF token, and the reason a cross-site form POST fails even before token
 * comparison.
 */
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // Non-browser client or same-origin navigation.
  try {
    const allowed = new URL(env.NEXT_PUBLIC_APP_URL).origin;
    return new URL(origin).origin === allowed;
  } catch {
    return false;
  }
}

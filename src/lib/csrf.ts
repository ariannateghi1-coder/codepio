"use client";

import { CSRF_COOKIE } from "./security-constants";

/**
 * Reads the CSRF cookie in the browser.
 *
 * The cookie is intentionally non-httpOnly so this code can mirror it into the
 * x-csrf-token header. It is not the secret: a cross-site attacker can send the
 * cookie but cannot read it, and the server additionally compares its hash with
 * the value bound to the session row.
 */
export function getCsrfHeader(): string | null {
  const match = document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(`${CSRF_COOKIE}=`));
  if (!match) return null;
  const raw = match.slice(CSRF_COOKIE.length + 1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

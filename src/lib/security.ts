import "server-only";
import crypto from "crypto";
import argon2 from "argon2";
import { cookies } from "next/headers";
import type { Role, User, UserStatus } from "@prisma/client";
import { prisma } from "./prisma";
import { isProduction } from "./env";
import { sha256, randomToken, safeEqual } from "./crypto";
import { CsrfError, ForbiddenError, UnauthorizedError } from "./errors";
import { getClientIp, hashIp, isSameOrigin } from "./http";
import { logger } from "./logger";
import { SESSION_COOKIE, CSRF_COOKIE } from "./security-constants";
import { type Actor } from "./authz";

export { SESSION_COOKIE, CSRF_COOKIE };
export { sha256, randomToken };

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
/** Sessions idle longer than this are treated as dead even if not expired. */
const SESSION_IDLE_TTL_MS = 1000 * 60 * 60 * 24 * 14;
/** lastSeenAt is only rewritten this often, to avoid a write on every request. */
const LAST_SEEN_THROTTLE_MS = 1000 * 60 * 5;

export async function hashPassword(password: string) {
  return argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
}

export async function verifyPassword(hash: string, password: string) {
  try {
    return await argon2.verify(hash, password);
  } catch {
    // A malformed/legacy hash must read as "wrong password", never as a 500.
    return false;
  }
}

/**
 * Collision-resistant referral code: 40 bits of randomness in Crockford-ish
 * base32, plus a username hint for human recognizability. The caller retries on
 * the unique-constraint violation, so a collision costs one extra insert rather
 * than producing a duplicate.
 */
export function referralCode(username: string) {
  const hint = username.replace(/[^a-z0-9]/gi, "").slice(0, 4).toUpperCase() || "USER";
  const random = crypto.randomBytes(5).toString("hex").toUpperCase();
  return `AS-${hint}-${random}`;
}

export type SessionContext = {
  user: User;
  sessionId: string;
};

function cookieOptions(expires: Date, httpOnly: boolean) {
  return {
    httpOnly,
    secure: isProduction,
    sameSite: "lax" as const,
    path: "/",
    expires,
  };
}

/**
 * Issues a fresh session. Always call this AFTER a successful credential check
 * (login, password change, password reset) and never reuse a pre-auth session
 * id — that is what prevents session fixation.
 */
export async function createSession(userId: string, req?: Request) {
  const token = randomToken(48);
  const csrf = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await prisma.session.create({
    data: {
      userId,
      tokenHash: sha256(token),
      csrfTokenHash: sha256(csrf),
      expiresAt,
      userAgent: req?.headers.get("user-agent")?.slice(0, 300) ?? null,
      ipHash: req ? hashIp(getClientIp(req)) : null,
    },
  });

  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, cookieOptions(expiresAt, true));
  // Readable by JS on purpose: the client mirrors it into the x-csrf-token
  // header (double-submit). It is NOT the secret — the server compares the
  // header against the hash bound to the session row.
  jar.set(CSRF_COOKIE, csrf, cookieOptions(expiresAt, false));

  return { expiresAt };
}

/** Loads the session + user, enforcing expiry, revocation and idle timeout. */
export async function getSessionContext(): Promise<SessionContext | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: true },
  });
  if (!session) return null;

  const now = Date.now();
  if (session.revokedAt || session.expiresAt.getTime() < now) return null;
  if (now - session.lastSeenAt.getTime() > SESSION_IDLE_TTL_MS) {
    await prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } }).catch(() => null);
    return null;
  }

  if (now - session.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS) {
    await prisma.session
      .update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
      .catch((e) => logger.warn("failed to refresh session lastSeenAt", { error: e }));
  }

  return { user: session.user, sessionId: session.id };
}

export async function getSessionUser(): Promise<User | null> {
  return (await getSessionContext())?.user ?? null;
}

const BLOCKED_STATUSES: UserStatus[] = ["BANNED", "SUSPENDED"];

/**
 * Authenticated and allowed-to-act user. Accounts can read their own
 * settings but are blocked from participating, which is enforced by
 * requireActiveUser below rather than by hiding UI.
 */
export async function requireUser(): Promise<User> {
  const ctx = await getSessionContext();
  if (!ctx) throw new UnauthorizedError();
  if (BLOCKED_STATUSES.includes(ctx.user.status)) {
    throw new ForbiddenError(
      ctx.user.status === "BANNED"
        ? "حساب شما مسدود شده است. برای بررسی با پشتیبانی تماس بگیرید."
        : "حساب شما موقتاً معلق است."
    );
  }
  return ctx.user;
}

export async function requireSession(): Promise<SessionContext> {
  const ctx = await getSessionContext();
  if (!ctx) throw new UnauthorizedError();
  if (BLOCKED_STATUSES.includes(ctx.user.status)) throw new ForbiddenError();
  return ctx;
}

/** For actions that require a fully onboarded account (support, campaigns). */
export async function requireActiveUser(): Promise<User> {
  const user = await requireUser();
  if (user.status !== "ACTIVE") {
    throw new ForbiddenError("برای استفاده از این بخش ابتدا ایمیل خود را تأیید کنید.");
  }
  return user;
}

export function toActor(user: Pick<User, "id" | "role" | "status">): Actor {
  return { id: user.id, role: user.role, status: user.status };
}

async function requireRole(minimum: Role[]): Promise<User> {
  const user = await requireUser();
  if (!minimum.includes(user.role)) throw new ForbiddenError();
  return user;
}

export async function requireAdmin() {
  return requireRole(["ADMIN", "SUPER_ADMIN"]);
}

export async function requireSuperAdmin() {
  return requireRole(["SUPER_ADMIN"]);
}

export async function requireModerator() {
  return requireRole(["MODERATOR", "ADMIN", "SUPER_ADMIN"]);
}

export async function logout() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    await prisma.session.updateMany({
      where: { tokenHash: sha256(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
  jar.delete(SESSION_COOKIE);
  jar.delete(CSRF_COOKIE);
}

/** Revokes every session for a user, optionally keeping one (the current one). */
export async function revokeAllSessions(userId: string, exceptSessionId?: string) {
  await prisma.session.updateMany({
    where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
    data: { revokedAt: new Date() },
  });
}

export async function revokeSession(userId: string, sessionId: string) {
  const result = await prisma.session.updateMany({
    where: { id: sessionId, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count > 0;
}

/** Housekeeping so the Session table doesn't grow without bound. */
export async function purgeExpiredSessions(olderThanDays = 30) {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const { count } = await prisma.session.deleteMany({
    where: { OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] },
  });
  return count;
}

export { CsrfError };

/**
 * CSRF validation for state-changing requests.
 *
 * Double-submit cookie bound to server state:
 *   1. Origin must match (cheap, blocks classic cross-site form posts).
 *   2. The x-csrf-token header must equal the CSRF cookie — an attacker on
 *      another origin can send the cookie but cannot read it to set the header.
 *   3. Its hash must equal the csrfTokenHash stored on the session row, so a
 *      token from a different/older session is rejected.
 *
 * The session cookie is used only to find the session; it is never itself
 * compared against the CSRF token. Comparisons are timing-safe.
 */
export async function assertCsrf(req: Request) {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;

  if (!isSameOrigin(req)) throw new CsrfError();

  const header = req.headers.get("x-csrf-token");
  const jar = await cookies();
  const csrfCookie = jar.get(CSRF_COOKIE)?.value;
  const sessionToken = jar.get(SESSION_COOKIE)?.value;
  if (!header || !csrfCookie || !sessionToken) throw new CsrfError();

  if (!safeEqual(header, csrfCookie)) throw new CsrfError();

  const session = await prisma.session.findUnique({
    where: { tokenHash: sha256(sessionToken) },
    select: { csrfTokenHash: true, revokedAt: true, expiresAt: true },
  });
  if (!session || session.revokedAt || session.expiresAt < new Date()) throw new CsrfError();
  if (!safeEqual(session.csrfTokenHash, sha256(header))) throw new CsrfError();
}

/**
 * Page-level guard for Server Components. requireUser() throws typed errors,
 * which Next cannot render — so pages get a redirect instead.
 */
export async function requireUserForPage() {
  const { redirect } = await import("next/navigation");
  const ctx = await getSessionContext();
  if (!ctx) return redirect("/auth/login");
  if (BLOCKED_STATUSES.includes(ctx.user.status)) return redirect("/account-blocked");
  return ctx.user;
}

export async function requireStaffForPage(roles: Role[] = ["MODERATOR", "ADMIN", "SUPER_ADMIN"]) {
  const { redirect } = await import("next/navigation");
  const user = await requireUserForPage();
  if (!roles.includes(user.role)) redirect("/dashboard");
  return user;
}

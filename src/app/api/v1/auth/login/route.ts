import { prisma } from "@/lib/prisma";
import { ok, parseBody, route } from "@/lib/api";
import { loginSchema } from "@/lib/validators";
import { createSession, verifyPassword } from "@/lib/security";
import { enforceRateLimit } from "@/lib/rate-limit";
import { getClientIp, hashIp } from "@/lib/http";
import { writeAudit } from "@/lib/audit";
import { AppError, ForbiddenError, UnauthorizedError } from "@/lib/errors";

/**
 * Login.
 *
 * Anti-enumeration: wrong-email and wrong-password produce the identical error,
 * and a missing user still incurs a password verification against a dummy hash so
 * response timing doesn't reveal whether the account exists.
 *
 * Brute force: limited per IP and per account, so one IP can't spray many
 * accounts and one account can't be hammered from many IPs.
 *
 * Session fixation: createSession() always issues a brand-new token after the
 * credential check; no pre-auth session is ever upgraded.
 */
const DUMMY_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$c29tZS1zYWx0LXZhbHVlcw$b3BlbnNzbC1kdW1teS1oYXNoLXZhbHVlLWZvci10aW1pbmc";

export const POST = route("auth.login", async (req) => {
  const ipHash = hashIp(getClientIp(req));
  await enforceRateLimit("login", ipHash);

  const data = await parseBody(req, loginSchema);
  const identifier = data.emailOrUsername.trim().toLowerCase();
  await enforceRateLimit("login", `id:${identifier}`);

  const user = await prisma.user.findFirst({
    where: { OR: [{ email: identifier }, { username: identifier }] },
  });

  const passwordMatches = user
    ? await verifyPassword(user.passwordHash, data.password)
    : await verifyPassword(DUMMY_HASH, data.password).then(() => false);

  if (!user || !passwordMatches) {
    await writeAudit({ userId: user?.id ?? null, action: "SECURITY", entity: "Login", req, metadata: { outcome: "FAILED" } });
    throw new UnauthorizedError("ایمیل/نام کاربری یا رمز عبور اشتباه است.");
  }

  if (user.status === "BANNED") {
    await writeAudit({ userId: user.id, action: "SECURITY", entity: "Login", req, metadata: { outcome: "BANNED" } });
    throw new ForbiddenError("حساب شما مسدود شده است.");
  }
  if (user.status === "SUSPENDED") {
    throw new ForbiddenError("حساب شما موقتاً معلق است.");
  }

  await createSession(user.id, req);
  await prisma.user.update({ where: { id: user.id }, data: { lastActiveAt: new Date() } });
  await writeAudit({ userId: user.id, action: "LOGIN", entity: "User", entityId: user.id, req });

  return ok({
    user: {
      id: user.id,
      username: user.username,
      name: user.name,
      email: user.email,
      role: user.role,
      credits: user.credits,
      points: user.points,
      level: user.level,
      reputation: user.reputation,
      rankTier: user.rankTier,
    },
  });
});

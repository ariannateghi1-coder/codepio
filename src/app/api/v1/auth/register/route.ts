import { prisma } from "@/lib/prisma";
import { ok, parseBody, route } from "@/lib/api";
import { registerSchema } from "@/lib/validators";
import { createSession, hashPassword, referralCode } from "@/lib/security";
import { enforceRateLimit } from "@/lib/rate-limit";
import { getClientIp, hashIp } from "@/lib/http";
import { writeAudit } from "@/lib/audit";
import { ConflictError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { Prisma } from "@prisma/client";

/** Registration creates an ACTIVE account and signs it in immediately. */
export const POST = route("auth.register", async (req) => {
  const ip = getClientIp(req);
  await enforceRateLimit("register", hashIp(ip));

  const data = await parseBody(req, registerSchema);

  const [emailTaken, usernameTaken] = await Promise.all([
    prisma.user.findUnique({ where: { email: data.email }, select: { id: true } }),
    prisma.user.findUnique({ where: { username: data.username }, select: { id: true } }),
  ]);
  if (emailTaken) throw new ConflictError("این ایمیل قبلاً ثبت شده است.");
  if (usernameTaken) throw new ConflictError("این نام کاربری قبلاً گرفته شده است.");

  const referrer = data.referralCode
    ? await prisma.user.findUnique({ where: { referralCode: data.referralCode }, select: { id: true, status: true } })
    : null;

  const passwordHash = await hashPassword(data.password);

  // Retry only on a referralCode collision — 40 bits of randomness makes this
  // effectively never happen, but a duplicate must not surface as a 500.
  let user: { id: string; username: string; name: string; email: string; role: string } | null = null;
  for (let attempt = 0; attempt < 3 && !user; attempt++) {
    try {
      user = await prisma.user.create({
        data: {
          name: data.name,
          username: data.username,
          email: data.email,
          passwordHash,
          status: "ACTIVE",
          referralCode: referralCode(data.username),
        },
        select: { id: true, username: true, name: true, email: true, role: true },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        const target = String(e.meta?.target ?? "");
        if (target.includes("referralCode")) continue;
        if (target.includes("email")) throw new ConflictError("این ایمیل قبلاً ثبت شده است.");
        throw new ConflictError("این نام کاربری قبلاً گرفته شده است.");
      }
      throw e;
    }
  }
  if (!user) throw new ConflictError("ثبت‌نام ناموفق بود. دوباره تلاش کنید.");

  // Referral is recorded now but PAID only after the referred user completes a
  // verified support (see support service), which is what makes throwaway
  // accounts unprofitable.
  if (referrer && referrer.status === "ACTIVE" && referrer.id !== user.id) {
    await prisma.referral
      .create({
        data: { referrerId: referrer.id, referredId: user.id, code: data.referralCode!, ipHash: hashIp(ip) },
      })
      .catch((e) => logger.warn("failed to record referral", { error: e }));
  }

  await createSession(user.id, req);

  await writeAudit({ userId: user.id, action: "CREATE", entity: "User", entityId: user.id, req, metadata: { status: "ACTIVE" } });

  return ok({
    user: { id: user.id, username: user.username, name: user.name, email: user.email, role: user.role },
  });
});

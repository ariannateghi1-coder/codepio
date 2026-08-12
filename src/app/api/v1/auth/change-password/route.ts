import { prisma } from "@/lib/prisma";
import { ok, parseBody, route } from "@/lib/api";
import { changePasswordSchema } from "@/lib/validators";
import { assertCsrf, createSession, hashPassword, requireSession, revokeAllSessions, verifyPassword } from "@/lib/security";
import { enforceRateLimit } from "@/lib/rate-limit";
import { AppError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";

/**
 * Change password (authenticated).
 *
 * Requires the current password, so a stolen session alone cannot lock the owner
 * out. All other sessions are revoked and the current one is re-issued, which
 * rotates the session id — the same protection as at login.
 */
export const POST = route("auth.changePassword", async (req) => {
  const { user } = await requireSession();
  await assertCsrf(req);
  await enforceRateLimit("changePassword", user.id);

  const data = await parseBody(req, changePasswordSchema);

  if (!(await verifyPassword(user.passwordHash, data.currentPassword))) {
    await writeAudit({ userId: user.id, action: "SECURITY", entity: "PasswordChange", req, metadata: { outcome: "WRONG_CURRENT" } });
    throw new AppError({ code: "UNAUTHORIZED", status: 401, publicMessage: "رمز عبور فعلی درست نیست." });
  }

  const passwordHash = await hashPassword(data.password);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });

  // Revoke everything (including the current session), then mint a fresh one so
  // the user stays signed in on this device with a rotated token.
  await revokeAllSessions(user.id);
  await createSession(user.id, req);

  await writeAudit({ userId: user.id, action: "SECURITY", entity: "PasswordChange", entityId: user.id, req, metadata: { outcome: "COMPLETED" } });
  // NOTE: no email provider is wired into this project yet (see src/lib/env.ts),
  // so there is nothing to actually send a "password changed" notice through.
  // Once an email service is added, send it here.

  return ok({ message: "رمز عبور شما تغییر کرد و سایر نشست‌ها بسته شدند." });
});

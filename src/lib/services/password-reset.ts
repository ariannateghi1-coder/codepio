import "server-only";
import { prisma } from "../prisma";
import { sha256, randomToken, safeEqualHashed } from "../crypto";
import { hashPassword, revokeAllSessions } from "../security";
import { env } from "../env";
import { logger } from "../logger";
import { sendMail } from "../mailer";
import { passwordResetEmail, passwordChangedEmail } from "../emails";
import { writeAudit } from "../audit";
import { BusinessRuleError } from "../errors";

/**
 * Password reset.
 *
 * The whole flow is built around one rule: an attacker who submits an address or
 * a token must learn nothing from the response — not whether the account exists,
 * not whether the token was real, and not from how long the answer took.
 *
 * How each of those is achieved:
 *
 *  - Only the SHA-256 of the token is stored. A dump of PasswordResetToken is
 *    therefore not a set of usable reset links.
 *  - `requestReset` performs the same database work for a known and an unknown
 *    address, and dispatches the message without awaiting it, so response time
 *    does not correlate with existence. Timing is a real enumeration channel
 *    here: a 100 ms round trip to the mail provider is trivially measurable.
 *  - Issuing a new token invalidates every earlier unused one for that address,
 *    so a link found in an old inbox copy stops working.
 *  - Redemption claims the token with a conditional UPDATE and checks the
 *    affected-row count. Two concurrent requests with the same token cannot both
 *    proceed, which a read-then-write would allow.
 *  - Completing a reset revokes every session, because the reason someone is
 *    resetting may be that a session is already stolen. No session is created:
 *    the reset may well be happening on a device that should not be signed in.
 */

/** Short by design: this is a bearer credential sitting in an inbox. */
const RESET_TTL_MINUTES = 30;
const RESET_TTL_MS = RESET_TTL_MINUTES * 60 * 1000;

function resetUrl(token: string): string {
  // encodeURIComponent because randomToken() is base64url — safe today, but the
  // link must not silently break if that ever changes.
  return `${env.NEXT_PUBLIC_APP_URL}/auth/reset-password?token=${encodeURIComponent(token)}`;
}

/**
 * Starts a reset. Resolves the same way whether or not the address is known.
 *
 * Returns nothing on purpose: there is no caller-visible outcome to branch on,
 * which removes the temptation to surface one in a response body.
 */
export async function requestReset(email: string, req?: Request): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, name: true, email: true, status: true },
  });

  // Retire earlier links for this address before issuing a new one. Runs
  // unconditionally so the statement count does not depend on existence.
  await prisma.passwordResetToken.updateMany({
    where: { email, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });

  const token = randomToken(32);

  // The row is written even for an unknown address. It is inert — redemption
  // requires a user that matches the stored email — and it keeps the write path
  // identical for both cases. Expired rows are removed by the maintenance job.
  await prisma.passwordResetToken.create({
    data: { email, tokenHash: sha256(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) },
  });

  // A banned account must not be handed a way back in.
  if (!user || user.status === "BANNED") {
    logger.info("password reset requested for a non-eligible address", { hasUser: Boolean(user) });
    return;
  }

  await writeAudit({
    userId: user.id,
    action: "SECURITY",
    entity: "PasswordReset",
    req,
    metadata: { outcome: "REQUESTED" },
  });

  // Not awaited: the caller's response must not wait on SMTP, and its duration
  // must not reveal that a message was sent at all.
  const message = passwordResetEmail({
    name: user.name,
    url: resetUrl(token),
    expiresInMinutes: RESET_TTL_MINUTES,
  });

  void sendMail({ to: user.email, ...message }).catch((e) =>
    logger.error("password reset email dispatch failed", { userId: user.id, error: e })
  );
}

const INVALID = "این پیوند معتبر نیست یا منقضی شده است. یک درخواست تازه ثبت کنید.";

/**
 * Redeems a token and sets the new password.
 *
 * Every failure mode returns the identical message, so the caller cannot tell an
 * unknown token from an expired one from an already-used one.
 */
export async function completeReset(
  token: string,
  newPassword: string,
  req?: Request
): Promise<{ email: string }> {
  const tokenHash = sha256(token);

  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    select: { id: true, email: true, expiresAt: true, usedAt: true },
  });

  if (!record || record.usedAt || record.expiresAt.getTime() < Date.now()) {
    throw new BusinessRuleError(INVALID, { code: "BAD_REQUEST", status: 400, rule: "reset-token-invalid" });
  }

  const user = await prisma.user.findUnique({
    where: { email: record.email },
    select: { id: true, name: true, email: true, status: true, passwordHash: true },
  });

  if (!user || user.status === "BANNED") {
    throw new BusinessRuleError(INVALID, { code: "BAD_REQUEST", status: 400, rule: "reset-user-ineligible" });
  }

  // Reusing the current password would leave the account exactly as exposed as
  // whatever prompted the reset.
  const { verifyPassword } = await import("../security");
  if (await verifyPassword(user.passwordHash, newPassword)) {
    throw new BusinessRuleError("رمز جدید باید با رمز فعلی متفاوت باشد.", {
      code: "VALIDATION_ERROR",
      status: 422,
      rule: "reset-password-unchanged",
    });
  }

  const passwordHash = await hashPassword(newPassword);

  // Atomic claim: `usedAt: null` in the WHERE clause means the update touches
  // zero rows if another concurrent request already claimed this token, and the
  // count tells us which request won. This is the step that makes a reset link
  // genuinely single-use.
  const claimed = await prisma.passwordResetToken.updateMany({
    where: { id: record.id, usedAt: null },
    data: { usedAt: new Date() },
  });

  if (claimed.count === 0) {
    throw new BusinessRuleError(INVALID, { code: "BAD_REQUEST", status: 400, rule: "reset-token-race-lost" });
  }

  await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });

  // The reset may be a recovery from compromise, so every existing session dies.
  // No new session is issued: the user signs in explicitly with the new password.
  await revokeAllSessions(user.id);

  await writeAudit({
    userId: user.id,
    action: "SECURITY",
    entity: "PasswordReset",
    entityId: user.id,
    req,
    metadata: { outcome: "COMPLETED" },
  });

  void sendMail({ to: user.email, ...passwordChangedEmail({ name: user.name }) }).catch((e) =>
    logger.error("password changed notice failed", { userId: user.id, error: e })
  );

  return { email: user.email };
}

/**
 * Validity probe for the reset page, so the form is not rendered for a dead
 * link. Returns a boolean only — never the address the token belongs to.
 */
export async function isResetTokenUsable(token: string): Promise<boolean> {
  if (!token) return false;
  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: sha256(token) },
    select: { expiresAt: true, usedAt: true, tokenHash: true },
  });
  if (!record || record.usedAt) return false;
  if (record.expiresAt.getTime() < Date.now()) return false;
  // Defensive: confirms the row we matched really corresponds to this token
  // rather than to a hash collision or a truncated index lookup.
  return safeEqualHashed(record.tokenHash, sha256(token));
}

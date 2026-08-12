import { prisma } from "@/lib/prisma";
import { parseBody } from "@/lib/api";
import { authed } from "@/lib/handler";
import { profileSchema } from "@/lib/validators";
import { writeAudit } from "@/lib/audit";
import { logout } from "@/lib/security";

/**
 * Own profile read/update/deactivate.
 *
 * The update whitelist comes from the schema, so a client cannot smuggle
 * `role`, `credits`, `reputation` or `status` into the patch — the classic
 * mass-assignment escalation.
 */
export const GET = authed(
  "users.me.get",
  async ({ user }) => ({
    user: {
      id: user.id,
      username: user.username,
      name: user.name,
      email: user.email,
      avatarUrl: user.avatarUrl,
      bio: user.bio,
      country: user.country,
      language: user.language,
      role: user.role,
      status: user.status,
      credits: user.credits,
      points: user.points,
      level: user.level,
      reputation: user.reputation,
      rankTier: user.rankTier,
      referralCode: user.referralCode,
      currentStreakDays: user.currentStreakDays,
      createdAt: user.createdAt,
    },
  }),
  { csrf: false }
);

export const PATCH = authed("users.me.update", async ({ req, user }) => {
  const data = await parseBody(req, profileSchema);

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.bio !== undefined ? { bio: data.bio } : {}),
      ...(data.avatarUrl !== undefined ? { avatarUrl: data.avatarUrl } : {}),
      ...(data.country !== undefined ? { country: data.country } : {}),
      ...(data.language !== undefined ? { language: data.language } : {}),
    },
    select: { username: true, name: true, bio: true, avatarUrl: true, country: true, language: true },
  });

  await writeAudit({ userId: user.id, action: "UPDATE", entity: "User", entityId: user.id, req, metadata: { fields: Object.keys(data) } });
  return { user: updated };
});

/**
 * Self-deactivation. Suspends the account, revokes every session, and ends the
 * user's active campaigns so their content leaves Explore immediately. Not a hard
 * delete: ledger and support history must remain auditable.
 */
export const DELETE = authed("users.me.deactivate", async ({ req, user }) => {
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { status: "SUSPENDED" } }),
    prisma.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
    prisma.campaign.updateMany({
      where: { creatorId: user.id, status: { in: ["DRAFT", "ACTIVE", "PAUSED"] } },
      data: { status: "ENDED" },
    }),
  ]);

  await logout();
  await writeAudit({ userId: user.id, action: "DELETE", entity: "User", entityId: user.id, req, metadata: { selfService: true } });
  return { message: "حساب شما غیرفعال شد." };
});

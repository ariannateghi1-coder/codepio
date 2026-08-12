import { prisma } from "@/lib/prisma";
import { ok, route } from "@/lib/api";
import { getSessionContext } from "@/lib/security";
import { nextLevelProgress, rankTierLabel } from "@/lib/gamification";
import { UnauthorizedError } from "@/lib/errors";

/**
 * Current viewer. Returns only what the shell needs to render — never the email
 * hash, session data, or internal trustScore.
 */
export const GET = route("auth.me", async () => {
  const ctx = await getSessionContext();
  if (!ctx) throw new UnauthorizedError();

  const unread = await prisma.notification.count({ where: { userId: ctx.user.id, read: false } });
  const progress = nextLevelProgress(ctx.user.points);

  return ok({
    user: {
      id: ctx.user.id,
      username: ctx.user.username,
      name: ctx.user.name,
      avatarUrl: ctx.user.avatarUrl,
      role: ctx.user.role,
      status: ctx.user.status,
      youtubeVerified: ctx.user.youtubeVerified,
      credits: ctx.user.credits,
      points: ctx.user.points,
      level: ctx.user.level,
      reputation: ctx.user.reputation,
      rankTier: ctx.user.rankTier,
      rankTierLabel: rankTierLabel(ctx.user.rankTier),
      currentStreakDays: ctx.user.currentStreakDays,
      progress,
    },
    unreadNotifications: unread,
  });
});

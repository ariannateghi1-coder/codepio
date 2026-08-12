import { prisma } from "@/lib/prisma";
import { publicRoute } from "@/lib/handler";
import { NotFoundError } from "@/lib/errors";
import { rankTierLabel, nextLevelProgress } from "@/lib/gamification";

/**
 * Public profile.
 *
 * Everything returned here is intentionally public. Private fields (email,
 * sessions, ledgers, trustScore, audit log, notifications) are simply not
 * selected, so a future schema change can't leak them by accident.
 *
 * The channel is reported with its verification method, so the UI can show
 * "تأییدشده توسط یوتیوب" only when ownership was actually proven.
 */
export const GET = publicRoute<unknown, { username: string }>(
  "users.detail",
  async ({ params }) => {
    const { username } = await params();

    const user = await prisma.user.findFirst({
      where: { username: username.toLowerCase(), status: "ACTIVE" },
      select: {
        id: true,
        username: true,
        name: true,
        avatarUrl: true,
        bio: true,
        country: true,
        level: true,
        points: true,
        reputation: true,
        rankTier: true,
        youtubeVerified: true,
        currentStreakDays: true,
        longestStreakDays: true,
        createdAt: true,
        youtubeConnection: {
          select: { channelTitle: true, channelUrl: true, thumbnailUrl: true, verified: true, verificationMethod: true },
        },
        badges: { orderBy: { earnedAt: "desc" }, select: { earnedAt: true, badge: { select: { code: true, name: true, icon: true, description: true } } } },
        videos: {
          where: { status: "ACTIVE" },
          orderBy: { createdAt: "desc" },
          take: 6,
          select: { id: true, title: true, thumbnailUrl: true, youtubeVideoId: true, durationSec: true },
        },
        campaigns: {
          where: { status: "ACTIVE", endAt: { gte: new Date() } },
          orderBy: { createdAt: "desc" },
          take: 3,
          select: { id: true, title: true, rewardCredits: true, requiredWatchPercent: true, endAt: true },
        },
        _count: {
          select: {
            supportsGiven: { where: { status: "ACTIVE" } },
            supportsReceived: { where: { status: "ACTIVE" } },
          },
        },
      },
    });

    if (!user) throw new NotFoundError("این کاربر پیدا نشد.");

    return {
      user: {
        ...user,
        rankTierLabel: rankTierLabel(user.rankTier),
        progress: nextLevelProgress(user.points),
        badges: user.badges.map((entry) => ({ ...entry.badge, earnedAt: entry.earnedAt })),
      },
    };
  },
  { rateLimit: "publicSearch", csrf: false }
);

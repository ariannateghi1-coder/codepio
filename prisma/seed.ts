import { PrismaClient } from "@prisma/client";
import { hashPassword, referralCode } from "../src/lib/security";
import { BADGE_DEFINITIONS, BADGE_REQUIREMENTS, REPUTATION } from "../src/lib/gamification";

/**
 * Development seed.
 *
 * Creates the badge catalogue (the source of truth for requirements), a
 * super-admin, a few members with verified-looking channels, real videos with
 * durations, and one active campaign per creator so Explore has content to rank.
 *
 * Idempotent: every write is an upsert keyed on a natural unique column, so
 * re-running it never duplicates data.
 */
const prisma = new PrismaClient();

const SAMPLE_VIDEOS = [
  { id: "aqz-KE-bpKQ", title: "Big Buck Bunny — نمونه", duration: 635 },
  { id: "jNQXAC9IVRw", title: "اولین ویدیوی یوتیوب", duration: 19 },
  { id: "9bZkp7q19f0", title: "نمونه موسیقی", duration: 253 },
  { id: "dQw4w9WgXcQ", title: "نمونه کلاسیک", duration: 213 },
];

async function main() {
  for (const definition of BADGE_DEFINITIONS) {
    const requirement = BADGE_REQUIREMENTS[definition.code];
    await prisma.badge.upsert({
      where: { code: definition.code },
      update: {
        name: definition.name,
        description: definition.description,
        icon: definition.icon,
        requirements: requirement,
        rewardCredits: definition.credits,
        rewardXp: definition.xp,
      },
      create: {
        code: definition.code,
        name: definition.name,
        description: definition.description,
        icon: definition.icon,
        requirements: requirement,
        rewardCredits: definition.credits,
        rewardXp: definition.xp,
      },
    });
  }

  await prisma.user.upsert({
    where: { email: "admin@academy.local" },
    update: {},
    create: {
      email: "admin@academy.local",
      username: "admin",
      name: "مدیر آکادمی",
      passwordHash: await hashPassword("AdminPass2026!"),
      role: "SUPER_ADMIN",
      status: "ACTIVE",
      reputation: REPUTATION.MAX / 2,
      trustScore: 90,
      referralCode: referralCode("admin"),
    },
  });

  for (let index = 0; index < SAMPLE_VIDEOS.length; index += 1) {
    const sample = SAMPLE_VIDEOS[index];
    const number = index + 1;

    const creator = await prisma.user.upsert({
      where: { username: `creator_${number}` },
      update: {},
      create: {
        email: `creator${number}@academy.local`,
        username: `creator_${number}`,
        name: `سازنده ${number}`,
        passwordHash: await hashPassword("MemberPass2026!"),
        status: "ACTIVE",
        reputation: 120 + number * 40,
        trustScore: 55 + number * 5,
        credits: number * 15,
        points: number * 90,
        level: Math.min(10, 1 + number),
        supportsCompleted: number * 3,
        referralCode: referralCode(`creator${number}`),
      },
    });

    const video = await prisma.video.upsert({
      where: { userId_youtubeVideoId: { userId: creator.id, youtubeVideoId: sample.id } },
      update: { durationSec: sample.duration },
      create: {
        userId: creator.id,
        youtubeVideoId: sample.id,
        youtubeUrl: `https://www.youtube.com/watch?v=${sample.id}`,
        title: sample.title,
        description: "ویدیوی نمونه برای محیط توسعه",
        thumbnailUrl: `https://i.ytimg.com/vi/${sample.id}/hqdefault.jpg`,
        durationSec: sample.duration,
        metadataSyncedAt: new Date(),
        status: "ACTIVE",
      },
    });

    const campaignId = `seed_campaign_${number}`;
    await prisma.campaign.upsert({
      where: { id: campaignId },
      update: {},
      create: {
        id: campaignId,
        creatorId: creator.id,
        videoId: video.id,
        title: `حمایت از ${sample.title}`,
        description: "کمپین نمونه برای تست چرخه کامل حمایت",
        startAt: new Date(Date.now() - 86_400_000),
        endAt: new Date(Date.now() + 30 * 86_400_000),
        status: "ACTIVE",
        requiredWatchPercent: 90,
        rewardCredits: 10 + number,
        rewardXp: 25,
        // Written directly rather than through the API, so the seed does not need
        // the creator to have earned credits first. In the real flow a budget is
        // funded from the creator's own balance (src/lib/services/budget.ts).
        budgetCredits: 1000,
        maxSupportsPerUser: 1,
        dailyLimit: 100,
        tasks: {
          // Canonical reward model: required tasks carry no reward of their own —
          // their value is inside the campaign's rewardCredits. Only the optional
          // comment task adds a bonus.
          create: [
            { type: "WATCH_VIDEO", required: true, sortOrder: 0, rewardCredits: 0, rewardXp: 0 },
            { type: "SUBSCRIBE_CHANNEL", required: true, sortOrder: 1, rewardCredits: 0, rewardXp: 0 },
            { type: "LIKE_VIDEO", required: true, sortOrder: 2, rewardCredits: 0, rewardXp: 0 },
            { type: "COMMENT_VIDEO", required: false, sortOrder: 3, rewardCredits: 2, rewardXp: 5 },
          ],
        },
      },
    });
  }

  console.log("Seed completed");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

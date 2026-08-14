import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { runRetention, RETENTION_DAYS } from "@/lib/services/retention";
import { auditUserBalances, utcDay } from "@/lib/services/ledger";
import { computeLeaderboard } from "@/lib/services/leaderboard";
import { hashPassword, referralCode } from "@/lib/security";

/**
 * Retention against a REAL Postgres database.
 *
 * The pure policy rules are covered in retention.test.ts. What only a database can
 * prove is what this file asserts:
 *
 *   • the SQL predicates match the documented policy,
 *   • cleanup never touches Support / CreditLedger / User / Campaign,
 *   • deleting XpLedger does not move User.points, level, or the leaderboard,
 *   • deleting rows does not change any credit balance,
 *   • the job is idempotent and genuinely batch-based.
 *
 * Skipped unless TEST_DATABASE_URL is set, so `npm test` stays fast and hermetic.
 * Skipping is explicit rather than silent — the suite prints why.
 */

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl);

if (!enabled) {
  console.warn("[retention-db] skipped: set TEST_DATABASE_URL to a disposable Postgres database to run these tests.");
}

const prisma = enabled ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null;

const SUFFIX = `rt${Date.now().toString(36)}`;
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

type Fixture = {
  userId: string;
  campaignId: string;
  videoId: string;
  /** Terminal + settled: its execution state is eligible for deletion. */
  settledSessionId: string;
  settledSupportId: string;
  /** Still open: nothing of it may be deleted. */
  openSessionId: string;
  /** Terminal but held for review: nothing of it may be deleted. */
  heldSessionId: string;
};

async function seed(client: PrismaClient): Promise<Fixture> {
  const passwordHash = await hashPassword("RetentionTest2026!");

  const user = await client.user.create({
    data: {
      email: `retention-${SUFFIX}@test.local`,
      username: `retention_${SUFFIX}`,
      name: "Retention",
      passwordHash,
      status: "ACTIVE",
      referralCode: referralCode(`ret${SUFFIX}`),
      points: 500,
      level: 4,
      credits: 250,
    },
  });

  const creator = await client.user.create({
    data: {
      email: `retention-creator-${SUFFIX}@test.local`,
      username: `retention_creator_${SUFFIX}`,
      name: "Retention Creator",
      passwordHash,
      status: "ACTIVE",
      referralCode: referralCode(`retc${SUFFIX}`),
    },
  });

  const video = await client.video.create({
    data: {
      userId: creator.id,
      youtubeVideoId: "dQw4w9WgXcQ",
      youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      title: `Retention fixture ${SUFFIX}`,
      durationSec: 120,
      metadataSyncedAt: new Date(),
      status: "ACTIVE",
    },
  });

  const campaign = await client.campaign.create({
    data: {
      creatorId: creator.id,
      videoId: video.id,
      title: `Retention campaign ${SUFFIX}`,
      startAt: ago(30),
      endAt: new Date(Date.now() + 30 * DAY),
      status: "ACTIVE",
      requiredWatchPercent: 90,
      budgetCredits: 1000,
    },
  });

  // ---- A settled support: terminal session, Support row present ------------
  const support = await client.support.create({
    data: {
      supporterId: user.id,
      receiverId: creator.id,
      campaignId: campaign.id,
      videoId: video.id,
      creditsAwarded: 10,
      xpAwarded: 25,
      // The self-contained outcome: this is why the execution state below is
      // safe to delete.
      watchedSec: 110,
      requiredWatchSec: 108,
      riskScore: 4,
      verification: [{ type: "WATCH_VIDEO", method: "PLATFORM_OBSERVED", result: "PASSED" }],
    },
  });

  const settled = await client.supportSession.create({
    data: {
      campaignId: campaign.id,
      supporterId: user.id,
      creatorId: creator.id,
      videoId: video.id,
      state: "COMPLETED",
      rewardState: "CONFIRMED",
      expiresAt: ago(9),
      completedAt: ago(10),
      supportId: support.id,
    },
  });
  // updatedAt is @updatedAt, so it must be aged with raw SQL — Prisma overwrites
  // any value passed through the client.
  await client.$executeRaw`UPDATE public."SupportSession" SET "updatedAt" = ${ago(10)} WHERE "id" = ${settled.id}`;

  await client.watchSession.create({
    data: { sessionId: settled.id, videoId: video.id, durationSec: 120, requiredSec: 108, accumulatedSec: 110 },
  });
  await client.supportTask.create({
    data: { sessionId: settled.id, type: "WATCH_VIDEO", required: true, state: "SATISFIED" },
  });
  await client.supportVerification.create({
    data: { sessionId: settled.id, taskType: "WATCH_VIDEO", method: "PLATFORM_OBSERVED", result: "PASSED" },
  });

  // ---- An OPEN session: protected regardless of age ------------------------
  const open = await client.supportSession.create({
    data: {
      campaignId: campaign.id,
      supporterId: user.id,
      creatorId: creator.id,
      videoId: video.id,
      state: "WATCHING",
      rewardState: "NONE",
      expiresAt: new Date(Date.now() + DAY),
    },
  });
  await client.$executeRaw`UPDATE public."SupportSession" SET "updatedAt" = ${ago(90)} WHERE "id" = ${open.id}`;
  await client.watchSession.create({
    data: { sessionId: open.id, videoId: video.id, durationSec: 120, requiredSec: 108, accumulatedSec: 40 },
  });
  await client.supportTask.create({
    data: { sessionId: open.id, type: "WATCH_VIDEO", required: true, state: "PENDING" },
  });
  await client.supportVerification.create({
    data: { sessionId: open.id, taskType: "WATCH_VIDEO", method: "UNVERIFIED", result: "PENDING" },
  });

  // ---- A HELD session: terminal but awaiting a moderator ------------------
  const held = await client.supportSession.create({
    data: {
      campaignId: campaign.id,
      supporterId: creator.id,
      creatorId: user.id,
      videoId: video.id,
      state: "COMPLETED",
      rewardState: "PENDING_REVIEW",
      expiresAt: ago(89),
      completedAt: ago(90),
    },
  });
  await client.$executeRaw`UPDATE public."SupportSession" SET "updatedAt" = ${ago(90)} WHERE "id" = ${held.id}`;
  await client.watchSession.create({
    data: { sessionId: held.id, videoId: video.id, durationSec: 120, requiredSec: 108, accumulatedSec: 109 },
  });
  await client.supportVerification.create({
    data: { sessionId: held.id, taskType: "WATCH_VIDEO", method: "PLATFORM_OBSERVED", result: "PASSED" },
  });

  // ---- Age-based rows, on both sides of every boundary --------------------
  const notif = (days: number, title: string) =>
    client.notification.create({
      data: { userId: user.id, type: "SYSTEM", title, message: title, createdAt: ago(days) },
    });
  await notif(1, `fresh-${SUFFIX}`);
  await notif(2.5, `inside-${SUFFIX}`);
  await notif(5, `stale-${SUFFIX}`);
  await notif(40, `ancient-${SUFFIX}`);

  const activity = (days: number) =>
    client.activity.create({
      data: { userId: user.id, type: "SUPPORT_CREATED", targetId: SUFFIX, createdAt: ago(days) },
    });
  await activity(1);
  await activity(6.5);
  await activity(9);
  await activity(60);

  const audit = (days: number) =>
    client.auditLog.create({
      data: { userId: user.id, action: "LOGIN", entity: SUFFIX, createdAt: ago(days) },
    });
  await audit(1);
  await audit(6.5);
  await audit(9);

  // XP: fresh + old detail rows, and a permanent rollup carrying the full total.
  const xp = (days: number, amount: number, key: string) =>
    client.xpLedger.create({
      data: {
        userId: user.id,
        type: "SUPPORT_COMPLETED",
        amount,
        balanceAfter: 500,
        idempotencyKey: `${SUFFIX}-${key}`,
        createdAt: ago(days),
      },
    });
  await xp(1, 100, "xp-fresh");
  await xp(6.5, 100, "xp-inside");
  await xp(9, 150, "xp-stale");
  await xp(60, 150, "xp-ancient");

  // The rollup is what the leaderboard and the balance audit read. Seeded to match
  // User.points exactly, so any drift after cleanup is a real failure.
  await client.userDailyRollup.createMany({
    data: [
      { userId: user.id, day: utcDay(ago(1)), xp: 100 },
      { userId: user.id, day: utcDay(ago(6.5)), xp: 100 },
      { userId: user.id, day: utcDay(ago(9)), xp: 150 },
      { userId: user.id, day: utcDay(ago(60)), xp: 150 },
    ],
    skipDuplicates: true,
  });

  // Credit ledger matching User.credits, so "balances unchanged" is measurable.
  await client.creditLedger.createMany({
    data: [
      {
        userId: user.id,
        type: "SIGNUP_GRANT",
        amount: 50,
        balanceAfter: 50,
        idempotencyKey: `${SUFFIX}-credit-grant`,
        createdAt: ago(60),
      },
      {
        userId: user.id,
        type: "SUPPORT_COMPLETED",
        amount: 200,
        balanceAfter: 250,
        idempotencyKey: `${SUFFIX}-credit-earn`,
        createdAt: ago(30),
      },
    ],
  });

  // Abuse signals: one per protection case.
  await client.abuseSignal.createMany({
    data: [
      { userId: user.id, type: "SUPPORT_VELOCITY", severity: 3, createdAt: ago(1) },
      { userId: user.id, type: "SUPPORT_VELOCITY", severity: 3, createdAt: ago(9) },
      { userId: user.id, sessionId: open.id, type: "PAIR_FARMING", severity: 4, createdAt: ago(90) },
      { userId: user.id, sessionId: held.id, type: "PAIR_FARMING", severity: 5, createdAt: ago(90) },
      { userId: user.id, sessionId: settled.id, type: "PAIR_FARMING", severity: 2, createdAt: ago(90) },
    ],
  });

  return {
    userId: user.id,
    campaignId: campaign.id,
    videoId: video.id,
    settledSessionId: settled.id,
    settledSupportId: support.id,
    openSessionId: open.id,
    heldSessionId: held.id,
  };
}

async function cleanup(client: PrismaClient) {
  await client.campaign.deleteMany({ where: { title: { contains: SUFFIX } } });
  await client.video.deleteMany({ where: { title: { contains: SUFFIX } } });
  await client.user.deleteMany({ where: { email: { contains: SUFFIX } } });
}

describe.skipIf(!enabled)("retention against a real database", () => {
  let fixture: Fixture;
  let before: { credits: number; points: number; level: number };

  beforeAll(async () => {
    fixture = await seed(prisma!);
    const user = await prisma!.user.findUniqueOrThrow({
      where: { id: fixture.userId },
      select: { credits: true, points: true, level: true },
    });
    before = user;
  }, 120_000);

  afterAll(async () => {
    if (!prisma) return;
    await cleanup(prisma);
    await prisma.$disconnect();
  });

  it(
    "applies every retention window and protects everything permanent",
    async () => {
      const client = prisma!;

      // A dry run must report work without doing any.
      const preview = await runRetention({ dryRun: true, batchSize: 100 });
      expect(preview.dryRun).toBe(true);
      expect(preview.totalDeleted).toBeGreaterThan(0);
      const notificationsBeforeRun = await client.notification.count({
        where: { title: { contains: SUFFIX } },
      });
      expect(notificationsBeforeRun).toBe(4);

      const result = await runRetention({ batchSize: 100 });
      expect(result.hadErrors).toBe(false);

      // ---- Notification: 3 days ------------------------------------------
      const notifications = await client.notification.findMany({
        where: { title: { contains: SUFFIX } },
        select: { title: true },
      });
      const titles = notifications.map((row) => row.title);
      expect(titles).toContain(`fresh-${SUFFIX}`);
      expect(titles).toContain(`inside-${SUFFIX}`);
      expect(titles).not.toContain(`stale-${SUFFIX}`);
      expect(titles).not.toContain(`ancient-${SUFFIX}`);

      // ---- Activity / AuditLog / XpLedger: 7 days ------------------------
      const activities = await client.activity.findMany({
        where: { targetId: SUFFIX },
        select: { createdAt: true },
      });
      expect(activities).toHaveLength(2);
      for (const row of activities) {
        expect(row.createdAt.getTime()).toBeGreaterThan(Date.now() - 7.05 * DAY);
      }

      const audits = await client.auditLog.count({ where: { entity: SUFFIX } });
      expect(audits).toBe(2);

      const xpRows = await client.xpLedger.findMany({
        where: { idempotencyKey: { startsWith: SUFFIX } },
        select: { idempotencyKey: true },
      });
      const xpKeys = xpRows.map((row) => row.idempotencyKey);
      expect(xpKeys).toContain(`${SUFFIX}-xp-fresh`);
      expect(xpKeys).toContain(`${SUFFIX}-xp-inside`);
      expect(xpKeys).not.toContain(`${SUFFIX}-xp-stale`);
      expect(xpKeys).not.toContain(`${SUFFIX}-xp-ancient`);

      // ---- XP deletion changed nothing the user can see ------------------
      const after = await client.user.findUniqueOrThrow({
        where: { id: fixture.userId },
        select: { credits: true, points: true, level: true },
      });
      expect(after.points).toBe(before.points);
      expect(after.level).toBe(before.level);
      expect(after.credits).toBe(before.credits);

      // The permanent rollup is untouched, which is what keeps the above true.
      const rollupTotal = await client.userDailyRollup.aggregate({
        where: { userId: fixture.userId },
        _sum: { xp: true },
      });
      expect(rollupTotal._sum.xp).toBe(before.points);

      // And the balance audit still reconciles — it reads the rollup, not XpLedger.
      const audit = await auditUserBalances(client, fixture.userId);
      expect(audit.consistent).toBe(true);
      expect(audit.xp.drift).toBe(0);
      expect(audit.credits.drift).toBe(0);

      // The leaderboard still sees the user's full lifetime XP.
      const allTime = await computeLeaderboard({ period: "ALL_TIME", mode: "TOP_SUPPORTERS", limit: 100 });
      const row = allTime.find((entry) => entry.userId === fixture.userId);
      expect(row?.score).toBe(before.points);

      // ---- AbuseSignal: 7 days, unless a decision is open ----------------
      const signals = await client.abuseSignal.findMany({
        where: { userId: fixture.userId },
        select: { sessionId: true, createdAt: true },
      });
      // Kept: the fresh one, plus the open and held sessions' signals.
      expect(signals.some((s) => s.sessionId === fixture.openSessionId)).toBe(true);
      expect(signals.some((s) => s.sessionId === fixture.heldSessionId)).toBe(true);
      // Gone: the old account-level one and the settled session's.
      expect(signals.some((s) => s.sessionId === fixture.settledSessionId)).toBe(false);
      expect(signals.filter((s) => s.sessionId === null)).toHaveLength(1);

      // ---- Execution state: only for settled sessions --------------------
      expect(await client.watchSession.findUnique({ where: { sessionId: fixture.settledSessionId } })).toBeNull();
      expect(
        await client.supportVerification.count({ where: { sessionId: fixture.settledSessionId } })
      ).toBe(0);
      expect(await client.supportTask.count({ where: { sessionId: fixture.settledSessionId } })).toBe(0);

      // Open session keeps everything, despite being 90 days old.
      expect(await client.watchSession.findUnique({ where: { sessionId: fixture.openSessionId } })).not.toBeNull();
      expect(await client.supportVerification.count({ where: { sessionId: fixture.openSessionId } })).toBe(1);
      expect(await client.supportTask.count({ where: { sessionId: fixture.openSessionId } })).toBe(1);

      // Held-for-review session keeps everything the moderator needs.
      expect(await client.watchSession.findUnique({ where: { sessionId: fixture.heldSessionId } })).not.toBeNull();
      expect(await client.supportVerification.count({ where: { sessionId: fixture.heldSessionId } })).toBe(1);

      // ---- Nothing permanent was touched --------------------------------
      const support = await client.support.findUnique({ where: { id: fixture.settledSupportId } });
      expect(support).not.toBeNull();
      // The Support row still answers "did this succeed, and why was it paid?"
      // entirely on its own, after its execution state is gone.
      expect(support!.creditsAwarded).toBe(10);
      expect(support!.xpAwarded).toBe(25);
      expect(support!.watchedSec).toBe(110);
      expect(support!.requiredWatchSec).toBe(108);
      expect(support!.status).toBe("ACTIVE");
      expect(support!.verification).not.toBeNull();

      expect(await client.creditLedger.count({ where: { idempotencyKey: { startsWith: SUFFIX } } })).toBe(2);
      expect(await client.user.findUnique({ where: { id: fixture.userId } })).not.toBeNull();
      expect(await client.campaign.findUnique({ where: { id: fixture.campaignId } })).not.toBeNull();
      // The session rows themselves survive; only their children were pruned.
      expect(await client.supportSession.findUnique({ where: { id: fixture.settledSessionId } })).not.toBeNull();
    },
    180_000
  );

  it(
    "is idempotent: a second run deletes nothing and breaks nothing",
    async () => {
      const client = prisma!;
      const second = await runRetention({ batchSize: 100 });
      expect(second.hadErrors).toBe(false);

      // Everything eligible went in the first run, so the fixture contributes zero
      // here. Other rows in a shared test database may still be collected, so this
      // asserts on the fixture rather than on a global total of 0.
      expect(await client.notification.count({ where: { title: { contains: `stale-${SUFFIX}` } } })).toBe(0);
      expect(await client.notification.count({ where: { title: { contains: `fresh-${SUFFIX}` } } })).toBe(1);

      const after = await client.user.findUniqueOrThrow({
        where: { id: fixture.userId },
        select: { credits: true, points: true, level: true },
      });
      expect(after.points).toBe(before.points);
      expect(after.credits).toBe(before.credits);
      expect(after.level).toBe(before.level);

      expect(await client.support.findUnique({ where: { id: fixture.settledSupportId } })).not.toBeNull();
    },
    120_000
  );

  it(
    "deletes in bounded batches rather than one large statement",
    async () => {
      const client = prisma!;

      // 25 expired notifications, batch size 10 → at least 3 batches.
      await client.notification.createMany({
        data: Array.from({ length: 25 }, (_, index) => ({
          userId: fixture.userId,
          type: "SYSTEM" as const,
          title: `batch-${SUFFIX}-${index}`,
          message: "batch",
          createdAt: ago(RETENTION_DAYS.notification + 5),
        })),
      });

      const capped = await runRetention({ batchSize: 10, maxBatchesPerTable: 2 });
      const notificationResult = capped.tables.find((row) => row.table === "Notification")!;
      // The cap stopped it, proving work is chunked and resumable rather than
      // executed as a single unbounded DELETE.
      expect(notificationResult.batches).toBe(2);
      expect(notificationResult.capped).toBe(true);
      expect(notificationResult.deleted).toBeLessThanOrEqual(20);
      expect(await client.notification.count({ where: { title: { contains: `batch-${SUFFIX}` } } })).toBeGreaterThan(0);

      // A follow-up run continues from where the capped one stopped.
      await runRetention({ batchSize: 10, maxBatchesPerTable: 10 });
      expect(await client.notification.count({ where: { title: { contains: `batch-${SUFFIX}` } } })).toBe(0);
    },
    180_000
  );
});

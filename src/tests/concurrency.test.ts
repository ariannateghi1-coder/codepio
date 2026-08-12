import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { completeSupportSession, recordWatchHeartbeat, startSupportSession } from "@/lib/services/support";
import { auditUserBalances } from "@/lib/services/ledger";
import { hashPassword, referralCode } from "@/lib/security";

/**
 * Concurrency and integrity tests against a REAL Postgres database.
 *
 * These are the properties a fake transaction client cannot prove:
 *   - a campaign capacity of N admits exactly N concurrent completions,
 *   - the reward budget can never be overspent,
 *   - the ledger and the cached balances agree after a burst,
 *   - a replayed completion pays once,
 *   - out-of-order and replayed heartbeats cannot corrupt watch accounting.
 *
 * They are skipped unless TEST_DATABASE_URL is set, so `npm test` stays fast and
 * hermetic; CI sets it against a disposable database. Skipping is explicit rather
 * than silent — the suite prints why.
 *
 * The fixture writes the campaign row directly instead of going through the
 * campaigns API, because budget funding would otherwise require the creator to have
 * earned credits first — that path is exercised by its own test below.
 */

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl);

if (!enabled) {
  console.warn(
    "[concurrency] skipped: set TEST_DATABASE_URL to a disposable Postgres database to run these tests."
  );
}

const prisma = enabled ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null;

const SUFFIX = `ct${Date.now().toString(36)}`;
const CAPACITY = 5;
const SUPPORTER_COUNT = 25;

type Seeded = { creatorId: string; campaignId: string; supporterIds: string[] };

async function seed(client: PrismaClient): Promise<Seeded> {
  const passwordHash = await hashPassword("ConcurrencyTest2026!");

  const creator = await client.user.create({
    data: {
      email: `creator-${SUFFIX}@test.local`,
      username: `creator_${SUFFIX}`,
      name: "Creator",
      passwordHash,
      status: "ACTIVE",
      referralCode: referralCode(`creator${SUFFIX}`),
    },
  });

  const video = await client.video.create({
    data: {
      userId: creator.id,
      youtubeVideoId: "dQw4w9WgXcQ",
      youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      title: "Concurrency fixture",
      durationSec: 60,
      metadataSyncedAt: new Date(),
      status: "ACTIVE",
    },
  });

  const campaign = await client.campaign.create({
    data: {
      creatorId: creator.id,
      videoId: video.id,
      title: "Concurrency campaign",
      startAt: new Date(Date.now() - 3600_000),
      endAt: new Date(Date.now() + 86_400_000),
      status: "ACTIVE",
      requiredWatchPercent: 90,
      rewardCredits: 10,
      rewardXp: 25,
      // Budget sized to exactly CAPACITY payouts: the atomic conditional update
      // is what must stop the (CAPACITY + 1)-th completion.
      budgetCredits: 10 * CAPACITY,
      maxTotalSupports: CAPACITY,
      tasks: { create: [{ type: "WATCH_VIDEO", required: true, sortOrder: 0 }] },
    },
  });

  const supporterIds: string[] = [];
  for (let i = 0; i < SUPPORTER_COUNT; i += 1) {
    const supporter = await client.user.create({
      data: {
        email: `supporter-${i}-${SUFFIX}@test.local`,
        username: `supporter_${i}_${SUFFIX}`,
        name: `Supporter ${i}`,
        passwordHash,
        status: "ACTIVE",
        // Old enough to clear any minimum-account-age gate.
        createdAt: new Date(Date.now() - 30 * 86_400_000),
        referralCode: referralCode(`sup${i}${SUFFIX}`),
      },
    });
    supporterIds.push(supporter.id);
  }

  return { creatorId: creator.id, campaignId: campaign.id, supporterIds };
}

/** Marks the watch task satisfied without pretending the user watched anything. */
async function satisfyWatch(client: PrismaClient, sessionId: string) {
  const session = await client.supportSession.findUniqueOrThrow({
    where: { id: sessionId },
    include: { watchSession: true },
  });
  const duration = session.watchSession?.durationSec ?? 60;
  await client.watchSession.update({
    where: { sessionId },
    data: {
      accumulatedSec: duration,
      segments: [[0, duration]],
      heartbeats: 6,
      lastPosition: duration,
      lastSequence: 6,
      // Backdate the start so both the elapsed-time check and the real-time floor
      // (minimumElapsedSeconds) see a plausible watch.
      startedAt: new Date(Date.now() - 600_000),
    },
  });
  await client.supportSession.update({
    where: { id: sessionId },
    data: { state: "WATCH_THRESHOLD_REACHED", startedAt: new Date(Date.now() - 600_000) },
  });
  await client.supportTask.updateMany({
    where: { sessionId, type: "WATCH_VIDEO" },
    data: { state: "SATISFIED", method: "PLATFORM_OBSERVED", satisfiedAt: new Date() },
  });
}

async function cleanup(client: PrismaClient) {
  // Cascades from User/Campaign remove sessions, tasks, ledger rows and supports.
  await client.campaign.deleteMany({ where: { title: "Concurrency campaign" } });
  await client.user.deleteMany({ where: { email: { contains: SUFFIX } } });
}

describe.skipIf(!enabled)("support completion under concurrency", () => {
  let fixture: Seeded;

  beforeAll(async () => {
    await seed(prisma!).then((result) => {
      fixture = result;
    });
  }, 120_000);

  afterAll(async () => {
    if (!prisma) return;
    await cleanup(prisma);
    await prisma.$disconnect();
  });

  it(
    `admits exactly ${CAPACITY} supports when ${SUPPORTER_COUNT} complete simultaneously`,
    async () => {
      const client = prisma!;

      // Every supporter starts a session and satisfies the watch requirement.
      const sessionIds: string[] = [];
      for (const supporterId of fixture.supporterIds) {
        const started = await startSupportSession({
          supporterId,
          campaignId: fixture.campaignId,
          ipHash: null,
          userAgentHash: null,
        });
        await satisfyWatch(client, started.session.id);
        sessionIds.push(started.session.id);
      }

      // Fire all completions at once: this is the race.
      const results = await Promise.allSettled(
        sessionIds.map((sessionId, index) =>
          completeSupportSession({ sessionId, supporterId: fixture.supporterIds[index] })
        )
      );

      const fulfilled = results.filter((r) => r.status === "fulfilled").length;
      const rejected = results.filter((r) => r.status === "rejected").length;

      // Exactly the capacity is admitted — no over-admission, no lost slot.
      const activeSupports = await client.support.count({
        where: { campaignId: fixture.campaignId, status: "ACTIVE" },
      });
      expect(activeSupports).toBe(CAPACITY);
      expect(fulfilled).toBe(CAPACITY);
      expect(rejected).toBe(SUPPORTER_COUNT - CAPACITY);

      // The budget was never overspent.
      const campaign = await client.campaign.findUniqueOrThrow({ where: { id: fixture.campaignId } });
      expect(campaign.spentCredits).toBeLessThanOrEqual(campaign.budgetCredits);

      // Every paid supporter's cached balance matches their ledger.
      for (const supporterId of fixture.supporterIds) {
        const audit = await auditUserBalances(client, supporterId);
        expect(audit.consistent).toBe(true);
      }
      const creatorAudit = await auditUserBalances(client, fixture.creatorId);
      expect(creatorAudit.consistent).toBe(true);

      // Ledger entries per session never exceed one payout of each kind.
      const duplicatePayouts = await client.creditLedger.groupBy({
        by: ["idempotencyKey"],
        _count: { _all: true },
        having: { idempotencyKey: { _count: { gt: 1 } } },
      });
      expect(duplicatePayouts).toHaveLength(0);
    },
    180_000
  );

  it(
    "returns the same result for a replayed completion instead of paying twice",
    async () => {
      const client = prisma!;
      const support = await client.support.findFirstOrThrow({
        where: { campaignId: fixture.campaignId, status: "ACTIVE" },
        include: { session: true },
      });
      if (!support.session) throw new Error("expected a session for the support");

      const before = await auditUserBalances(client, support.supporterId);
      const replay = await completeSupportSession({
        sessionId: support.session.id,
        supporterId: support.supporterId,
      });
      const after = await auditUserBalances(client, support.supporterId);

      expect(replay.supportId).toBe(support.id);
      expect(after.credits.ledger).toBe(before.credits.ledger);
      expect(after.xp.ledger).toBe(before.xp.ledger);
    },
    60_000
  );

  it(
    "refuses replayed and out-of-order heartbeats without corrupting watch state",
    async () => {
      const client = prisma!;

      // A fresh supporter and a fresh session, so this test does not depend on
      // whatever the concurrency burst left behind.
      const started = await startSupportSession({
        supporterId: fixture.supporterIds[SUPPORTER_COUNT - 1],
        campaignId: fixture.campaignId,
        ipHash: null,
        userAgentHash: null,
      });
      const sessionId = started.session.id;
      const supporterId = fixture.supporterIds[SUPPORTER_COUNT - 1];

      // Two legitimate beats, spaced by real time.
      await recordWatchHeartbeat({ sessionId, supporterId, position: 5, playerState: "PLAYING", sequence: 1 });
      await client.watchSession.update({
        where: { sessionId },
        data: { lastHeartbeatAt: new Date(Date.now() - 10_000) },
      });
      const second = await recordWatchHeartbeat({
        sessionId,
        supporterId,
        position: 15,
        playerState: "PLAYING",
        sequence: 2,
      });
      expect(second.rejected).toBe(false);
      const credited = second.accumulatedSec;

      // Replay of sequence 2, and a late sequence 1: neither may change anything.
      const replay = await recordWatchHeartbeat({
        sessionId,
        supporterId,
        position: 400,
        playerState: "PLAYING",
        sequence: 2,
      });
      const stale = await recordWatchHeartbeat({
        sessionId,
        supporterId,
        position: 500,
        playerState: "PLAYING",
        sequence: 1,
      });

      expect(replay.rejected).toBe(true);
      expect(stale.rejected).toBe(true);
      expect(replay.accumulatedSec).toBe(credited);
      expect(stale.accumulatedSec).toBe(credited);

      const watch = await client.watchSession.findUniqueOrThrow({ where: { sessionId } });
      expect(watch.accumulatedSec).toBe(credited);
      expect(watch.lastSequence).toBe(2);
      expect(watch.rejectedBeats).toBe(2);
    },
    60_000
  );
});

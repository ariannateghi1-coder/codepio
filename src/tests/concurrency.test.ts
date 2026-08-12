import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  completeSupportSession,
  openWatchTarget,
  startSupportSession,
  watchTimerStatus,
} from "@/lib/services/support";
import { auditUserBalances } from "@/lib/services/ledger";
import { hashPassword, referralCode } from "@/lib/security";
import { SUPPORT_TRANSFER_CREDITS, WATCH_RULES } from "@/lib/gamification";

/**
 * Concurrency and integrity tests against a REAL Postgres database.
 *
 * These are the properties a fake transaction client cannot prove:
 *   - a campaign capacity of N admits exactly N concurrent completions,
 *   - the reward budget can never be overspent,
 *   - the ledger and the cached balances agree after a burst,
 *   - a replayed completion pays once,
 *   - the watch timer anchor is written once, so refreshes and repeated opens
 *     cannot restart it, extend it, or credit time twice.
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
const VIDEO_ID = "dQw4w9WgXcQ";
/** Ten minutes, so the 99% requirement is the specified 594 seconds. */
const DURATION_SEC = 600;
const REQUIRED_SEC = 594;

type Seeded = {
  creatorId: string;
  campaignId: string;
  /**
   * A second, separately funded campaign, used by the watch-timer tests.
   *
   * The burst test deliberately drains `campaignId` to exactly zero remaining
   * budget — that is the invariant it proves. Starting another session on it
   * therefore fails eligibility with CAMPAIGN_BUDGET_EXHAUSTED before the video
   * can even be opened, which says nothing about the timer. The timer tests get
   * their own funded campaign so the two stay independent.
   */
  timerCampaignId: string;
  supporterIds: string[];
};

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
      youtubeVideoId: VIDEO_ID,
      youtubeUrl: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
      title: "Concurrency fixture",
      durationSec: DURATION_SEC,
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
      requiredWatchPercent: WATCH_RULES.defaultRequiredPercent,
      rewardCredits: SUPPORT_TRANSFER_CREDITS,
      rewardXp: 25,
      // Budget sized to exactly CAPACITY transfers: the atomic conditional update
      // is what must stop the (CAPACITY + 1)-th completion.
      budgetCredits: SUPPORT_TRANSFER_CREDITS * CAPACITY,
      maxTotalSupports: CAPACITY,
      tasks: { create: [{ type: "WATCH_VIDEO", required: true, sortOrder: 0 }] },
    },
  });

  const timerCampaign = await client.campaign.create({
    data: {
      creatorId: creator.id,
      videoId: video.id,
      title: "Concurrency campaign timer",
      startAt: new Date(Date.now() - 3600_000),
      endAt: new Date(Date.now() + 86_400_000),
      status: "ACTIVE",
      requiredWatchPercent: WATCH_RULES.defaultRequiredPercent,
      rewardCredits: SUPPORT_TRANSFER_CREDITS,
      rewardXp: 25,
      // Funded for several transfers: the timer tests start more than one session
      // on this campaign, and an exhausted budget would fail them at eligibility
      // for a reason that has nothing to do with the timer.
      budgetCredits: SUPPORT_TRANSFER_CREDITS * 4,
      maxTotalSupports: 4,
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

  return {
    creatorId: creator.id,
    campaignId: campaign.id,
    timerCampaignId: timerCampaign.id,
    supporterIds,
  };
}

/**
 * Marks the watch task satisfied without pretending the user watched anything.
 *
 * The anchor is backdated past the requirement, which is exactly what completion
 * re-checks. Faking `accumulatedSec` alone would no longer work — settlement
 * recomputes from `openedAt` — and that is the point of the test below.
 */
async function satisfyWatch(client: PrismaClient, sessionId: string) {
  const session = await client.supportSession.findUniqueOrThrow({
    where: { id: sessionId },
    include: { watchSession: true },
  });
  const required = session.watchSession?.requiredSec ?? 60;
  await client.watchSession.update({
    where: { sessionId },
    data: {
      openedAt: new Date(Date.now() - (required + 60) * 1000),
      accumulatedSec: required,
    },
  });
  await client.supportSession.update({
    where: { id: sessionId },
    data: { state: "WATCH_THRESHOLD_REACHED", startedAt: new Date(Date.now() - (required + 60) * 1000) },
  });
  await client.supportTask.updateMany({
    where: { sessionId, type: "WATCH_VIDEO" },
    data: { state: "SATISFIED", method: "PLATFORM_OBSERVED", satisfiedAt: new Date() },
  });
}

async function cleanup(client: PrismaClient) {
  // Cascades from User/Campaign remove sessions, tasks, ledger rows and supports.
  await client.campaign.deleteMany({ where: { title: { startsWith: "Concurrency campaign" } } });
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

      // CREDIT CONSERVATION, measured end to end: what left the campaign's escrow
      // equals what arrived in supporter balances. A creator payout, a mutual bonus
      // or a task bonus paid in credits would break this equality, which is exactly
      // why they are all XP now.
      const supporterCredits = await client.creditLedger.aggregate({
        where: { campaignId: fixture.campaignId, type: "SUPPORT_COMPLETED" },
        _sum: { amount: true },
      });
      expect(supporterCredits._sum.amount ?? 0).toBe(campaign.spentCredits);
      expect(campaign.spentCredits).toBe(SUPPORT_TRANSFER_CREDITS * CAPACITY);

      // And the creator received no credits for being supported.
      const creatorReceipts = await client.creditLedger.aggregate({
        where: { userId: fixture.creatorId, amount: { gt: 0 } },
        _sum: { amount: true },
      });
      expect(creatorReceipts._sum.amount ?? 0).toBe(0);

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
    "writes the watch anchor once, so refreshes and repeated opens cannot restart or extend the timer",
    async () => {
      const client = prisma!;
      const supporterId = fixture.supporterIds[SUPPORTER_COUNT - 1];

      const started = await startSupportSession({
        supporterId,
        campaignId: fixture.timerCampaignId,
        ipHash: null,
        userAgentHash: null,
      });
      const sessionId = started.session.id;

      // requiredSec is derived server-side from the video duration, not sent by
      // anyone: 600s at 99% is 594s.
      // 600s at 99% → 594s, computed server-side from YouTube's duration.
      expect(started.requiredWatchSeconds).toBe(REQUIRED_SEC);
      expect(started.openedAt).toBeNull();
      expect(started.remainingSeconds).toBe(REQUIRED_SEC);

      // Not opened yet → asking for status is refused, and the task cannot pass.
      await expect(watchTimerStatus({ sessionId, supporterId })).rejects.toThrow();

      const first = await openWatchTarget({ sessionId, supporterId });
      expect(first.satisfied).toBe(false);
      expect(first.requiredSec).toBe(REQUIRED_SEC);
      expect(first.watchUrl).toBe(`https://www.youtube.com/watch?v=${VIDEO_ID}`);

      const anchor = (await client.watchSession.findUniqueOrThrow({ where: { sessionId } })).openedAt;
      expect(anchor).not.toBeNull();

      // THE INVARIANT: opening again — a refresh, a double click, a replayed
      // request — must reuse the same anchor. If it moved, a supporter could keep
      // the timer at "just started" forever, or restart it to avoid ever finishing;
      // if it stacked, two timers would run for one session.
      const second = await openWatchTarget({ sessionId, supporterId });
      const third = await openWatchTarget({ sessionId, supporterId });
      const stillAnchor = (await client.watchSession.findUniqueOrThrow({ where: { sessionId } })).openedAt;
      expect(stillAnchor!.getTime()).toBe(anchor!.getTime());
      expect(second.openedAt.getTime()).toBe(anchor!.getTime());
      expect(third.openedAt.getTime()).toBe(anchor!.getTime());

      // Concurrent opens race on the same conditional UPDATE; all must agree.
      const raced = await Promise.all(
        Array.from({ length: 5 }, () => openWatchTarget({ sessionId, supporterId }))
      );
      for (const result of raced) {
        expect(result.openedAt.getTime()).toBe(anchor!.getTime());
      }

      // Polling status repeatedly must not accumulate anything: the credited value
      // is recomputed from the anchor, never incremented.
      const a = await watchTimerStatus({ sessionId, supporterId });
      const b = await watchTimerStatus({ sessionId, supporterId });
      const c = await watchTimerStatus({ sessionId, supporterId });
      expect(a.satisfied).toBe(false);
      expect(c.elapsedSec).toBeLessThan(10);
      expect(b.remainingSec).toBeGreaterThan(REQUIRED_SEC - 20);
      const watchRow = await client.watchSession.findUniqueOrThrow({ where: { sessionId } });
      expect(watchRow.accumulatedSec).toBe(0);

      // Completing before the time has elapsed must be refused even though the
      // client has "asked" many times.
      await expect(completeSupportSession({ sessionId, supporterId })).rejects.toThrow();

      // Backdate the anchor past the requirement: the same reads now satisfy it.
      await client.watchSession.update({
        where: { sessionId },
        data: { openedAt: new Date(Date.now() - (REQUIRED_SEC + 60) * 1000) },
      });
      const done = await watchTimerStatus({ sessionId, supporterId });
      expect(done.satisfied).toBe(true);
      expect(done.remainingSec).toBe(0);
      expect(done.elapsedSec).toBe(REQUIRED_SEC);

      const satisfiedRow = await client.watchSession.findUniqueOrThrow({ where: { sessionId } });
      // Never more than the requirement, so the column cannot be inflated by polling.
      expect(satisfiedRow.accumulatedSec).toBe(REQUIRED_SEC);
      const completedAt = satisfiedRow.completedAt;
      expect(completedAt).not.toBeNull();

      // A second status read must not move completedAt: the first crossing stands.
      await watchTimerStatus({ sessionId, supporterId });
      const again = await client.watchSession.findUniqueOrThrow({ where: { sessionId } });
      expect(again.completedAt!.getTime()).toBe(completedAt!.getTime());
      expect(again.accumulatedSec).toBe(REQUIRED_SEC);

      const task = await client.supportTask.findFirstOrThrow({
        where: { sessionId, type: "WATCH_VIDEO" },
      });
      expect(task.state).toBe("SATISFIED");
      expect(task.method).toBe("PLATFORM_OBSERVED");
    },
    60_000
  );

  it(
    "refuses to settle a session whose anchor does not cover the requirement, even if the task row says satisfied",
    async () => {
      const client = prisma!;
      const supporterId = fixture.supporterIds[SUPPORTER_COUNT - 2];

      const started = await startSupportSession({
        supporterId,
        campaignId: fixture.timerCampaignId,
        ipHash: null,
        userAgentHash: null,
      });
      const sessionId = started.session.id;
      await openWatchTarget({ sessionId, supporterId });

      // Forge the state a compromised client would try to reach: the task marked
      // satisfied and the accounting column filled in, with no time actually spent.
      await client.supportTask.updateMany({
        where: { sessionId, type: "WATCH_VIDEO" },
        data: { state: "SATISFIED", method: "PLATFORM_OBSERVED", satisfiedAt: new Date() },
      });
      await client.watchSession.update({
        where: { sessionId },
        data: { accumulatedSec: REQUIRED_SEC },
      });
      await client.supportSession.update({
        where: { id: sessionId },
        data: { state: "WATCH_THRESHOLD_REACHED" },
      });

      // Settlement recomputes from the anchor, so the forgery does not pay.
      await expect(completeSupportSession({ sessionId, supporterId })).rejects.toThrow();

      // What matters, and what is actually guaranteed: nothing was paid and no
      // Support row exists.
      //
      // NOT asserted: state === "FAILED". runCompletion writes the FAILED/DENIED
      // marking and then throws, and both happen inside the same
      // prisma.$transaction — so the marking rolls back with the throw and the
      // session stays where it was. That is pre-existing behaviour on every
      // failure path in this function (REQUIRED_TASK_INCOMPLETE and RISK_DENIED
      // included), verified against the untouched REQUIRED_TASK_INCOMPLETE path,
      // not something the watch timer introduced. Asserting FAILED here would
      // encode a guarantee the code does not currently provide.
      const session = await client.supportSession.findUniqueOrThrow({ where: { id: sessionId } });
      expect(session.supportId).toBeNull();
      expect(session.rewardState).not.toBe("CONFIRMED");

      const paid = await client.creditLedger.count({ where: { sessionId } });
      expect(paid).toBe(0);
      const support = await client.support.count({ where: { supporterId, campaignId: fixture.timerCampaignId } });
      expect(support).toBe(0);

      // The reward is still unreachable on a retry: the anchor has not moved.
      await expect(completeSupportSession({ sessionId, supporterId })).rejects.toThrow();
      expect(await client.creditLedger.count({ where: { sessionId } })).toBe(0);
    },
    60_000
  );
});

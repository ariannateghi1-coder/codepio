import "server-only";
import type { Prisma } from "@prisma/client";
import { BADGE_DEFINITIONS, BADGE_REQUIREMENTS, type BadgeCode } from "../gamification";
import { ledgerKey, recordCredit, recordXp } from "./ledger";
import { createNotificationTx } from "./notifications";

/**
 * Badge engine.
 *
 * Guarantees:
 *  - Idempotent: a badge is awarded at most once per user, enforced by the
 *    UserBadge composite primary key, and its reward goes through the ledger
 *    with a deterministic idempotency key.
 *  - Quality-aware: only ACTIVE (non-reversed) supports count, and quality
 *    badges additionally require a minimum completion rate, so pure farming
 *    doesn't unlock "Trusted Supporter".
 *  - No swallowed errors: a duplicate is handled explicitly by checking what the
 *    user already owns; any other DB error propagates.
 */

type Tx = Prisma.TransactionClient;

export type UserMetrics = {
  supportsCompleted: number;
  supportsReceived: number;
  mutualSupports: number;
  streakDays: number;
  reputation: number;
  channelVerified: boolean;
  completionRate: number;
};

/** Pure decision function — no DB access, so it is directly unit testable. */
export function badgesToAward(metrics: UserMetrics, alreadyOwned: Set<string>): BadgeCode[] {
  const earned: BadgeCode[] = [];

  for (const definition of BADGE_DEFINITIONS) {
    const code = definition.code;
    if (alreadyOwned.has(code)) continue;

    const requirement = BADGE_REQUIREMENTS[code];
    const value =
      requirement.metric === "SUPPORTS_COMPLETED"
        ? metrics.supportsCompleted
        : requirement.metric === "SUPPORTS_RECEIVED"
          ? metrics.supportsReceived
          : requirement.metric === "MUTUAL_SUPPORTS"
            ? metrics.mutualSupports
            : requirement.metric === "STREAK_DAYS"
              ? metrics.streakDays
              : requirement.metric === "REPUTATION"
                ? metrics.reputation
                : metrics.channelVerified
                  ? 1
                  : 0;

    if (value < requirement.threshold) continue;
    if (requirement.minCompletionRate !== undefined && metrics.completionRate < requirement.minCompletionRate) continue;

    earned.push(code);
  }

  return earned;
}

async function loadMetrics(tx: Tx, userId: string): Promise<UserMetrics> {
  const [user, supportsCompleted, supportsReceived, mutualSupports] = await Promise.all([
    tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        reputation: true,
        youtubeVerified: true,
        currentStreakDays: true,
        supportsCompleted: true,
        supportsAbandoned: true,
      },
    }),
    tx.support.count({ where: { supporterId: userId, status: "ACTIVE" } }),
    tx.support.count({ where: { receiverId: userId, status: "ACTIVE" } }),
    tx.support.count({ where: { supporterId: userId, status: "ACTIVE", mutual: true } }),
  ]);

  const attempts = user.supportsCompleted + user.supportsAbandoned;
  return {
    supportsCompleted,
    supportsReceived,
    mutualSupports,
    streakDays: user.currentStreakDays,
    reputation: user.reputation,
    channelVerified: user.youtubeVerified,
    completionRate: attempts === 0 ? 1 : user.supportsCompleted / attempts,
  };
}

export type AwardedBadge = { code: string; name: string; icon: string; credits: number; xp: number };

/**
 * Evaluates and awards badges for a user, inside the caller's transaction so
 * badge state can never disagree with the counts it was based on.
 */
export async function evaluateBadges(tx: Tx, userId: string): Promise<AwardedBadge[]> {
  const [owned, metrics] = await Promise.all([
    tx.userBadge.findMany({ where: { userId }, select: { badge: { select: { code: true } } } }),
    loadMetrics(tx, userId),
  ]);

  const ownedCodes = new Set(owned.map((entry) => entry.badge.code));
  const toAward = badgesToAward(metrics, ownedCodes);
  if (toAward.length === 0) return [];

  const badges = await tx.badge.findMany({ where: { code: { in: toAward } } });
  const awarded: AwardedBadge[] = [];

  for (const badge of badges) {
    // createMany + skipDuplicates gives us "insert if absent" without a
    // catch-all that would also hide genuine DB failures.
    const inserted = await tx.userBadge.createMany({
      data: [{ userId, badgeId: badge.id }],
      skipDuplicates: true,
    });
    if (inserted.count === 0) continue;

    await tx.activity.create({
      data: { userId, actorId: userId, type: "BADGE_EARNED", targetId: badge.id, metadata: { code: badge.code } },
    });

    if (badge.rewardCredits > 0) {
      await recordCredit(tx, {
        userId,
        type: "BADGE_REWARD",
        amount: badge.rewardCredits,
        idempotencyKey: ledgerKey(["badge-credits", userId, badge.code]),
        reason: `badge:${badge.code}`,
      });
    }
    if (badge.rewardXp > 0) {
      await recordXp(tx, {
        userId,
        type: "BADGE_REWARD",
        amount: badge.rewardXp,
        idempotencyKey: ledgerKey(["badge-xp", userId, badge.code]),
        reason: `badge:${badge.code}`,
      });
    }

    await createNotificationTx(tx, {
      userId,
      type: "SYSTEM",
      title: `نشان جدید: ${badge.name}`,
      message: badge.description,
      metadata: { badgeCode: badge.code, credits: badge.rewardCredits, xp: badge.rewardXp },
      dedupeKey: ledgerKey(["badge-notification", userId, badge.code]),
    });

    awarded.push({
      code: badge.code,
      name: badge.name,
      icon: badge.icon,
      credits: badge.rewardCredits,
      xp: badge.rewardXp,
    });
  }

  return awarded;
}

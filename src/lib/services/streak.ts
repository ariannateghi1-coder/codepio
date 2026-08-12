import "server-only";
import type { Prisma } from "@prisma/client";
import { REWARDS } from "../gamification";
import { ledgerKey, recordCredit, recordXp } from "./ledger";

/**
 * Daily activity streak.
 *
 * A streak day is only earned by a genuinely completed, verified support — not
 * by logging in — so the counter measures participation rather than presence.
 * Milestone rewards go through the ledger with a deterministic key, so a user
 * who reaches day 7 twice in one day cannot be paid twice.
 */

type Tx = Prisma.TransactionClient;

/** Calendar day key in UTC, so a streak means "distinct days", not 24h windows. */
export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysBetween(a: Date, b: Date): number {
  const dayA = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const dayB = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.round((dayB - dayA) / 86_400_000);
}

/** Pure state transition, unit tested independently of the DB. */
export function nextStreak(
  lastStreakDay: Date | null,
  currentStreak: number,
  now: Date
): { streak: number; changed: boolean } {
  if (!lastStreakDay) return { streak: 1, changed: true };
  const gap = daysBetween(lastStreakDay, now);
  if (gap <= 0) return { streak: currentStreak, changed: false }; // Already counted today.
  if (gap === 1) return { streak: currentStreak + 1, changed: true };
  return { streak: 1, changed: true }; // Missed at least one day → restart.
}

export async function registerStreakDay(tx: Tx, userId: string, now = new Date()) {
  const user = await tx.user.findUniqueOrThrow({
    where: { id: userId },
    select: { currentStreakDays: true, longestStreakDays: true, lastStreakDay: true },
  });

  const { streak, changed } = nextStreak(user.lastStreakDay, user.currentStreakDays, now);
  if (!changed) return { streak, milestone: null as number | null };

  await tx.user.update({
    where: { id: userId },
    data: {
      currentStreakDays: streak,
      longestStreakDays: Math.max(user.longestStreakDays, streak),
      lastStreakDay: now,
    },
  });

  const milestoneReward = REWARDS.STREAK[streak];
  if (!milestoneReward) return { streak, milestone: null };

  await recordCredit(tx, {
    userId,
    type: "CAMPAIGN_BONUS",
    amount: milestoneReward.credits,
    idempotencyKey: ledgerKey(["streak-credits", userId, streak, dayKey(now)]),
    reason: `streak:${streak}`,
  });
  await recordXp(tx, {
    userId,
    type: "STREAK",
    amount: milestoneReward.xp,
    idempotencyKey: ledgerKey(["streak-xp", userId, streak, dayKey(now)]),
    reason: `streak:${streak}`,
  });

  return { streak, milestone: streak };
}

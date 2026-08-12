import "server-only";
import type { CreditEntryType, Prisma, ReputationEventType, XpEntryType } from "@prisma/client";
import { calculateLevel, calculateRankTier, REPUTATION } from "../gamification";
import { BusinessRuleError } from "../errors";

/**
 * Ledger service — the ONLY place credits, XP and reputation may change.
 *
 * Design rules:
 *  1. Append-only. Nothing is ever mutated or deleted; a correction is a new
 *     entry that points at the one it reverses.
 *  2. Idempotent. Every entry carries an `idempotencyKey`; a retried award hits
 *     the unique index and becomes a no-op instead of paying twice.
 *  3. Cached totals stay derivable. User.credits / points / reputation are
 *     denormalized caches updated in the same transaction as the entry, and
 *     each entry records `balanceAfter`, so drift is detectable (see auditUser).
 *  4. `points -= x` is never allowed anywhere in the codebase.
 */

type Tx = Prisma.TransactionClient;

export type LedgerRef = {
  sessionId?: string | null;
  campaignId?: string | null;
  supportId?: string | null;
  reason?: string;
  metadata?: Prisma.InputJsonValue;
};

/**
 * Deterministic idempotency key. Same (scope, subject, action) always produces
 * the same key, which is what makes a retry safe.
 */
export function ledgerKey(parts: (string | number | null | undefined)[]): string {
  return parts.filter((p) => p !== null && p !== undefined && p !== "").join(":");
}

function clampReputation(value: number) {
  return Math.min(REPUTATION.MAX, Math.max(REPUTATION.MIN, value));
}

/**
 * Serialize all accounting mutations for one user. PostgreSQL holds this row
 * lock until the surrounding transaction commits, so claiming an idempotency
 * key, changing the cached balance and writing balanceAfter form one ordered
 * critical section. Callers must keep using a single transaction client.
 */
async function lockUser(tx: Tx, userId: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE
  `;
  if (rows.length === 0) {
    await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true } });
  }
}

export type CreditResult = { applied: boolean; balanceAfter: number; entryId?: string };

/**
 * Credits a (positive) or debits a (negative) amount. Returns applied:false when
 * the idempotency key already existed — callers treat that as success.
 */
export async function recordCredit(
  tx: Tx,
  input: {
    userId: string;
    type: CreditEntryType;
    amount: number;
    idempotencyKey: string;
    reversalOfId?: string | null;
  } & LedgerRef
): Promise<CreditResult> {
  if (input.amount === 0) {
    const user = await tx.user.findUniqueOrThrow({ where: { id: input.userId }, select: { credits: true } });
    return { applied: false, balanceAfter: user.credits };
  }

  await lockUser(tx, input.userId);

  const existing = await tx.creditLedger.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { balanceAfter: true },
  });
  if (existing) return { applied: false, balanceAfter: existing.balanceAfter };

  let balanceAfter: number;
  if (input.amount < 0) {
    const required = -input.amount;
    const debited = await tx.user.updateMany({
      where: { id: input.userId, credits: { gte: required } },
      data: { credits: { decrement: required } },
    });
    if (debited.count === 0) {
      const user = await tx.user.findUniqueOrThrow({
        where: { id: input.userId },
        select: { credits: true },
      });
      throw new BusinessRuleError(
        `اعتبار کافی نیست. موجودی: ${user.credits}، مورد نیاز: ${required}.`,
        { rule: "INSUFFICIENT_CREDITS", details: { available: user.credits, required } }
      );
    }
    balanceAfter = (
      await tx.user.findUniqueOrThrow({ where: { id: input.userId }, select: { credits: true } })
    ).credits;
  } else {
    balanceAfter = (
      await tx.user.update({
        where: { id: input.userId },
        data: { credits: { increment: input.amount } },
        select: { credits: true },
      })
    ).credits;
  }

  const entry = await tx.creditLedger.create({
    data: {
      userId: input.userId,
      type: input.type,
      amount: input.amount,
      balanceAfter,
      sessionId: input.sessionId ?? null,
      campaignId: input.campaignId ?? null,
      supportId: input.supportId ?? null,
      reversalOfId: input.reversalOfId ?? null,
      idempotencyKey: input.idempotencyKey,
      reason: input.reason,
      metadata: input.metadata,
    },
    select: { id: true },
  });
  return { applied: true, balanceAfter, entryId: entry.id };
}

export type XpResult = { applied: boolean; balanceAfter: number; level: number; leveledUp: boolean; entryId?: string };

export async function recordXp(
  tx: Tx,
  input: {
    userId: string;
    type: XpEntryType;
    amount: number;
    idempotencyKey: string;
    reversalOfId?: string | null;
  } & LedgerRef
): Promise<XpResult> {
  if (input.amount === 0) {
    const user = await tx.user.findUniqueOrThrow({
      where: { id: input.userId },
      select: { points: true, level: true },
    });
    return { applied: false, balanceAfter: user.points, level: user.level, leveledUp: false };
  }

  await lockUser(tx, input.userId);

  const existing = await tx.xpLedger.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { balanceAfter: true },
  });
  if (existing) {
    const user = await tx.user.findUniqueOrThrow({
      where: { id: input.userId },
      select: { level: true },
    });
    return { applied: false, balanceAfter: existing.balanceAfter, level: user.level, leveledUp: false };
  }

  const before = await tx.user.findUniqueOrThrow({
    where: { id: input.userId },
    select: { points: true, level: true },
  });
  const updated = await tx.user.update({
    where: { id: input.userId },
    data: { points: { increment: input.amount } },
    select: { points: true },
  });

  const entry = await tx.xpLedger.create({
    data: {
      userId: input.userId,
      type: input.type,
      amount: input.amount,
      balanceAfter: updated.points,
      sessionId: input.sessionId ?? null,
      supportId: input.supportId ?? null,
      reversalOfId: input.reversalOfId ?? null,
      idempotencyKey: input.idempotencyKey,
      reason: input.reason,
      metadata: input.metadata,
    },
    select: { id: true },
  });

  const nextLevel = calculateLevel(updated.points);
  const leveledUp = nextLevel > before.level;
  if (nextLevel !== before.level) {
    await tx.user.update({ where: { id: input.userId }, data: { level: nextLevel } });
  }
  return { applied: true, balanceAfter: updated.points, level: nextLevel, leveledUp, entryId: entry.id };
}

export type ReputationResult = { applied: boolean; valueAfter: number; rankTier: string; tierChanged: boolean };

export async function recordReputation(
  tx: Tx,
  input: {
    userId: string;
    type: ReputationEventType;
    delta: number;
    idempotencyKey: string;
  } & LedgerRef
): Promise<ReputationResult> {
  await lockUser(tx, input.userId);

  const existing = await tx.reputationEvent.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { valueAfter: true },
  });
  if (existing) {
    const user = await tx.user.findUniqueOrThrow({
      where: { id: input.userId },
      select: { rankTier: true },
    });
    return { applied: false, valueAfter: existing.valueAfter, rankTier: user.rankTier, tierChanged: false };
  }

  const before = await tx.user.findUniqueOrThrow({
    where: { id: input.userId },
    select: { reputation: true, rankTier: true, supportsCompleted: true },
  });
  const target = clampReputation(before.reputation + input.delta);
  const effectiveDelta = target - before.reputation;

  if (effectiveDelta === 0) {
    return { applied: false, valueAfter: before.reputation, rankTier: before.rankTier, tierChanged: false };
  }

  await tx.reputationEvent.create({
    data: {
      userId: input.userId,
      type: input.type,
      delta: effectiveDelta,
      valueAfter: target,
      sessionId: input.sessionId ?? null,
      idempotencyKey: input.idempotencyKey,
      reason: input.reason,
      metadata: input.metadata,
    },
  });

  const nextTier = calculateRankTier(target, before.supportsCompleted);
  const tierChanged = nextTier !== before.rankTier;
  await tx.user.update({
    where: { id: input.userId },
    data: { reputation: target, rankTier: tierChanged ? nextTier : undefined },
  });

  return { applied: true, valueAfter: target, rankTier: nextTier, tierChanged };
}

/**
 * Reverses a previous credit entry. Implemented as a mirrored entry linked via
 * `reversalOfId` (itself unique), which makes double-reversal impossible.
 */
export async function reverseCredit(tx: Tx, entryId: string, reason: string): Promise<CreditResult> {
  const original = await tx.creditLedger.findUnique({ where: { id: entryId } });
  if (!original) return { applied: false, balanceAfter: 0 };

  const existing = await tx.creditLedger.findUnique({ where: { reversalOfId: entryId }, select: { id: true } });
  if (existing) {
    const user = await tx.user.findUniqueOrThrow({ where: { id: original.userId }, select: { credits: true } });
    return { applied: false, balanceAfter: user.credits };
  }

  return recordCredit(tx, {
    userId: original.userId,
    type: "REVERSAL",
    amount: -original.amount,
    idempotencyKey: ledgerKey(["credit-reversal", entryId]),
    reversalOfId: entryId,
    sessionId: original.sessionId,
    campaignId: original.campaignId,
    supportId: original.supportId,
    reason,
  });
}

export async function reverseXp(tx: Tx, entryId: string, reason: string): Promise<XpResult> {
  const original = await tx.xpLedger.findUnique({ where: { id: entryId } });
  if (!original) return { applied: false, balanceAfter: 0, level: 1, leveledUp: false };

  const existing = await tx.xpLedger.findUnique({ where: { reversalOfId: entryId }, select: { id: true } });
  if (existing) {
    const user = await tx.user.findUniqueOrThrow({ where: { id: original.userId }, select: { points: true, level: true } });
    return { applied: false, balanceAfter: user.points, level: user.level, leveledUp: false };
  }

  return recordXp(tx, {
    userId: original.userId,
    type: "REVERSAL",
    amount: -original.amount,
    idempotencyKey: ledgerKey(["xp-reversal", entryId]),
    reversalOfId: entryId,
    sessionId: original.sessionId,
    supportId: original.supportId,
    reason,
  });
}

/** Reverses every credit/XP entry tied to one support session. */
export async function reverseSessionLedger(tx: Tx, sessionId: string, reason: string) {
  const [credits, xp] = await Promise.all([
    tx.creditLedger.findMany({ where: { sessionId, type: { not: "REVERSAL" } }, select: { id: true } }),
    tx.xpLedger.findMany({ where: { sessionId, type: { not: "REVERSAL" } }, select: { id: true } }),
  ]);
  for (const entry of credits) await reverseCredit(tx, entry.id, reason);
  for (const entry of xp) await reverseXp(tx, entry.id, reason);
  return { creditEntries: credits.length, xpEntries: xp.length };
}

/**
 * Consistency check: recomputes balances from the ledgers and compares them with
 * the cached columns. Exposed to admins so accounting drift is observable rather
 * than assumed impossible.
 */
export async function auditUserBalances(client: Tx, userId: string) {
  const [creditSum, xpSum, user] = await Promise.all([
    client.creditLedger.aggregate({ where: { userId }, _sum: { amount: true } }),
    client.xpLedger.aggregate({ where: { userId }, _sum: { amount: true } }),
    client.user.findUniqueOrThrow({ where: { id: userId }, select: { credits: true, points: true } }),
  ]);
  const ledgerCredits = creditSum._sum.amount ?? 0;
  const ledgerXp = xpSum._sum.amount ?? 0;
  return {
    credits: { cached: user.credits, ledger: ledgerCredits, drift: user.credits - ledgerCredits },
    xp: { cached: user.points, ledger: ledgerXp, drift: user.points - ledgerXp },
    consistent: user.credits === ledgerCredits && user.points === ledgerXp,
  };
}

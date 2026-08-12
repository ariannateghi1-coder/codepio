import { describe, expect, it, beforeEach } from "vitest";
import {
  auditUserBalances,
  grantSignupCredits,
  ledgerKey,
  recordCredit,
  recordXp,
  reverseCredit,
  reverseXp,
  compensateMissingXp,
} from "@/lib/services/ledger";
import { SIGNUP_GRANT_CREDITS } from "@/lib/gamification";
import type { Prisma } from "@prisma/client";

/**
 * Ledger tests run against an in-memory fake of the Prisma transaction client.
 *
 * Only the handful of operations the ledger uses are implemented — including the
 * unique-constraint behaviour on `idempotencyKey`/`reversalOfId`, because that
 * constraint IS the idempotency mechanism. Testing it against a real database
 * would prove the same property more slowly; the concurrency behaviour that a
 * fake cannot prove is covered separately by the e2e suite.
 */

type UserRow = { id: string; credits: number; points: number; level: number; reputation: number; rankTier: string; supportsCompleted: number };
type LedgerRow = {
  id: string;
  userId: string;
  type: string;
  amount: number;
  balanceAfter: number;
  idempotencyKey: string;
  reversalOfId: string | null;
  sessionId: string | null;
  campaignId: string | null;
  supportId: string | null;
  reason?: string;
};

class UniqueViolation extends Error {
  code = "P2002";
}

function createFakeTx() {
  const users = new Map<string, UserRow>();
  const credits: LedgerRow[] = [];
  const xp: LedgerRow[] = [];
  /**
   * Permanent per-day aggregates, keyed "userId|yyyy-mm-dd".
   *
   * recordXp() writes here in the same transaction as the XpLedger row, because
   * XpLedger is pruned after 7 days and every window longer than that (monthly
   * leaderboard, all-time, last-week trend) plus auditUserBalances() read this
   * instead. The fake models it so those invariants are testable here.
   */
  const rollups = new Map<string, { userId: string; day: Date; xp: number; abuseSeverity: number }>();
  let sequence = 0;

  users.set("u1", { id: "u1", credits: 0, points: 0, level: 1, reputation: 100, rankTier: "BRONZE", supportsCompleted: 0 });

  function applyIncrement(current: number, value: unknown): number {
    if (typeof value === "object" && value !== null) {
      const op = value as { increment?: number; decrement?: number };
      if (typeof op.increment === "number") return current + op.increment;
      if (typeof op.decrement === "number") return current - op.decrement;
    }
    if (typeof value === "number") return value;
    return current;
  }

  function makeLedger(store: LedgerRow[]) {
    return {
      create({ data }: { data: Record<string, unknown> }) {
        const key = String(data.idempotencyKey);
        if (store.some((row) => row.idempotencyKey === key)) throw new UniqueViolation("idempotencyKey");
        if (data.reversalOfId && store.some((row) => row.reversalOfId === data.reversalOfId)) {
          throw new UniqueViolation("reversalOfId");
        }
        sequence += 1;
        const row: LedgerRow = {
          id: `entry_${sequence}`,
          userId: String(data.userId),
          type: String(data.type),
          amount: Number(data.amount),
          balanceAfter: Number(data.balanceAfter),
          idempotencyKey: key,
          reversalOfId: (data.reversalOfId as string | null) ?? null,
          sessionId: (data.sessionId as string | null) ?? null,
          campaignId: (data.campaignId as string | null) ?? null,
          supportId: (data.supportId as string | null) ?? null,
          reason: data.reason as string | undefined,
        };
        store.push(row);
        return Promise.resolve({ id: row.id });
      },
      findUnique({ where }: { where: Record<string, unknown> }) {
        // Every unique lookup the ledger actually performs must be modelled here.
        // `idempotencyKey` is the important one: recordCredit/recordXp pre-check it
        // and return applied:false on a hit. A fake that always missed would send
        // the replay on to create(), turning idempotency into a P2002 throw — which
        // is the opposite of the behaviour under test.
        const row =
          store.find((entry) =>
            "id" in where
              ? entry.id === where.id
              : "idempotencyKey" in where
                ? entry.idempotencyKey === where.idempotencyKey
                : "reversalOfId" in where
                  ? entry.reversalOfId === where.reversalOfId
                  : false
          ) ?? null;
        return Promise.resolve(row);
      },
      findMany({ where }: { where?: { sessionId?: string; type?: { not?: string } } } = {}) {
        return Promise.resolve(
          store.filter(
            (row) =>
              (where?.sessionId === undefined || row.sessionId === where.sessionId) &&
              (where?.type?.not === undefined || row.type !== where.type.not)
          )
        );
      },
      aggregate({ where }: { where?: { userId?: string } } = {}) {
        const total = store
          .filter((row) => where?.userId === undefined || row.userId === where.userId)
          .reduce((sum, row) => sum + row.amount, 0);
        return Promise.resolve({ _sum: { amount: total } });
      },
    };
  }

  const tx = {
    $queryRaw() {
      return Promise.resolve([{ id: "u1" }]);
    },
    user: {
      updateMany({ where, data }: { where: { id: string; credits?: { gte?: number } }; data: Record<string, unknown> }) {
        const row = users.get(where.id);
        if (!row || (where.credits?.gte !== undefined && row.credits < where.credits.gte)) {
          return Promise.resolve({ count: 0 });
        }
        if ("credits" in data) row.credits = applyIncrement(row.credits, data.credits);
        return Promise.resolve({ count: 1 });
      },
      update({ where, data, select }: { where: { id: string }; data: Record<string, unknown>; select?: Record<string, boolean> }) {
        const row = users.get(where.id);
        if (!row) throw new Error("user not found");
        if ("credits" in data) row.credits = applyIncrement(row.credits, data.credits);
        if ("points" in data) row.points = applyIncrement(row.points, data.points);
        if ("level" in data) row.level = applyIncrement(row.level, data.level);
        if ("reputation" in data) row.reputation = applyIncrement(row.reputation, data.reputation);
        if ("rankTier" in data) row.rankTier = String(data.rankTier);
        return Promise.resolve(select ? pick(row, select) : row);
      },
      findUniqueOrThrow({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) {
        const row = users.get(where.id);
        if (!row) throw new Error("user not found");
        return Promise.resolve(select ? pick(row, select) : row);
      },
    },
    creditLedger: makeLedger(credits),
    xpLedger: makeLedger(xp),
    userDailyRollup: {
      upsert({
        where,
        create,
        update,
      }: {
        where: { userId_day: { userId: string; day: Date } };
        create: { userId: string; day: Date; xp?: number; abuseSeverity?: number };
        update: { xp?: { increment: number }; abuseSeverity?: { increment: number } };
      }) {
        const key = `${where.userId_day.userId}|${where.userId_day.day.toISOString().slice(0, 10)}`;
        const existing = rollups.get(key);
        if (!existing) {
          rollups.set(key, {
            userId: create.userId,
            day: create.day,
            xp: create.xp ?? 0,
            abuseSeverity: create.abuseSeverity ?? 0,
          });
        } else {
          if (update.xp) existing.xp += update.xp.increment;
          if (update.abuseSeverity) existing.abuseSeverity += update.abuseSeverity.increment;
        }
        return Promise.resolve(rollups.get(key));
      },
      aggregate({ where }: { where?: { userId?: string } } = {}) {
        const rows = [...rollups.values()].filter((row) => where?.userId === undefined || row.userId === where.userId);
        return Promise.resolve({
          _sum: {
            xp: rows.reduce((sum, row) => sum + row.xp, 0),
            abuseSeverity: rows.reduce((sum, row) => sum + row.abuseSeverity, 0),
          },
        });
      },
    },
  };

  function pick(row: UserRow, select: Record<string, boolean>) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(select)) out[key] = (row as unknown as Record<string, unknown>)[key];
    return out;
  }

  return { tx: tx as unknown as Prisma.TransactionClient, users, credits, xp, rollups };
}

describe("ledgerKey", () => {
  it("is deterministic and skips empty parts", () => {
    expect(ledgerKey(["support-credits", "s1"])).toBe("support-credits:s1");
    expect(ledgerKey(["a", null, undefined, "", "b"])).toBe("a:b");
    expect(ledgerKey(["x", 1])).toBe(ledgerKey(["x", 1]));
  });
});

describe("recordCredit", () => {
  let fake: ReturnType<typeof createFakeTx>;
  beforeEach(() => {
    fake = createFakeTx();
  });

  it("credits the user and writes a ledger entry", async () => {
    const result = await recordCredit(fake.tx, {
      userId: "u1",
      type: "SUPPORT_COMPLETED",
      amount: 10,
      idempotencyKey: "k1",
    });
    expect(result.applied).toBe(true);
    expect(result.balanceAfter).toBe(10);
    expect(fake.users.get("u1")!.credits).toBe(10);
    expect(fake.credits).toHaveLength(1);
    expect(fake.credits[0].balanceAfter).toBe(10);
  });

  it("is idempotent: a replayed key does not pay twice", async () => {
    await recordCredit(fake.tx, { userId: "u1", type: "SUPPORT_COMPLETED", amount: 10, idempotencyKey: "k1" });
    const replay = await recordCredit(fake.tx, { userId: "u1", type: "SUPPORT_COMPLETED", amount: 10, idempotencyKey: "k1" });

    expect(replay.applied).toBe(false);
    // The cached balance must be rolled back, not left inflated.
    expect(replay.balanceAfter).toBe(10);
    expect(fake.users.get("u1")!.credits).toBe(10);
    expect(fake.credits).toHaveLength(1);
  });

  it("survives many replays of the same key", async () => {
    for (let i = 0; i < 20; i += 1) {
      await recordCredit(fake.tx, { userId: "u1", type: "SUPPORT_COMPLETED", amount: 7, idempotencyKey: "same" });
    }
    expect(fake.users.get("u1")!.credits).toBe(7);
    expect(fake.credits).toHaveLength(1);
  });

  it("supports debits", async () => {
    await recordCredit(fake.tx, { userId: "u1", type: "SUPPORT_COMPLETED", amount: 30, idempotencyKey: "k1" });
    const debit = await recordCredit(fake.tx, { userId: "u1", type: "PENALTY", amount: -12, idempotencyKey: "k2" });
    expect(debit.balanceAfter).toBe(18);
    expect(fake.users.get("u1")!.credits).toBe(18);
  });

  it("rejects an insufficient debit without changing balance or ledger", async () => {
    await recordCredit(fake.tx, { userId: "u1", type: "SUPPORT_COMPLETED", amount: 5, idempotencyKey: "fund" });

    await expect(
      recordCredit(fake.tx, { userId: "u1", type: "PENALTY", amount: -6, idempotencyKey: "too-much" })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      details: { available: 5, required: 6 },
    });
    expect(fake.users.get("u1")!.credits).toBe(5);
    expect(fake.credits).toHaveLength(1);
  });

  it("does not debit twice when the same idempotency key is replayed", async () => {
    await recordCredit(fake.tx, { userId: "u1", type: "SUPPORT_COMPLETED", amount: 20, idempotencyKey: "fund" });
    await recordCredit(fake.tx, { userId: "u1", type: "PENALTY", amount: -7, idempotencyKey: "debit" });
    const replay = await recordCredit(fake.tx, { userId: "u1", type: "PENALTY", amount: -7, idempotencyKey: "debit" });

    expect(replay.applied).toBe(false);
    expect(replay.balanceAfter).toBe(13);
    expect(fake.users.get("u1")!.credits).toBe(13);
    expect(fake.credits).toHaveLength(2);
  });

  it("treats a zero amount as a no-op", async () => {
    const result = await recordCredit(fake.tx, { userId: "u1", type: "ADMIN_ADJUSTMENT", amount: 0, idempotencyKey: "k0" });
    expect(result.applied).toBe(false);
    expect(fake.credits).toHaveLength(0);
  });

  it("records balanceAfter consistently across a sequence", async () => {
    await recordCredit(fake.tx, { userId: "u1", type: "SUPPORT_COMPLETED", amount: 10, idempotencyKey: "a" });
    await recordCredit(fake.tx, { userId: "u1", type: "MUTUAL_BONUS", amount: 4, idempotencyKey: "b" });
    await recordCredit(fake.tx, { userId: "u1", type: "PENALTY", amount: -6, idempotencyKey: "c" });
    expect(fake.credits.map((row) => row.balanceAfter)).toEqual([10, 14, 8]);
  });
});

describe("recordXp", () => {
  let fake: ReturnType<typeof createFakeTx>;
  beforeEach(() => {
    fake = createFakeTx();
  });

  it("recalculates the level and reports a level-up", async () => {
    const result = await recordXp(fake.tx, { userId: "u1", type: "SUPPORT_COMPLETED", amount: 150, idempotencyKey: "x1" });
    expect(result.applied).toBe(true);
    expect(result.level).toBe(2);
    expect(result.leveledUp).toBe(true);
    expect(fake.users.get("u1")!.level).toBe(2);
  });

  it("does not report a level-up when the level is unchanged", async () => {
    const result = await recordXp(fake.tx, { userId: "u1", type: "SUPPORT_COMPLETED", amount: 20, idempotencyKey: "x1" });
    expect(result.leveledUp).toBe(false);
    expect(result.level).toBe(1);
  });

  it("is idempotent", async () => {
    await recordXp(fake.tx, { userId: "u1", type: "SUPPORT_COMPLETED", amount: 25, idempotencyKey: "x1" });
    const replay = await recordXp(fake.tx, { userId: "u1", type: "SUPPORT_COMPLETED", amount: 25, idempotencyKey: "x1" });
    expect(replay.applied).toBe(false);
    expect(fake.users.get("u1")!.points).toBe(25);
    expect(fake.xp).toHaveLength(1);
  });
});

describe("reverseCredit", () => {
  let fake: ReturnType<typeof createFakeTx>;
  beforeEach(() => {
    fake = createFakeTx();
  });

  it("mirrors the original entry and restores the balance", async () => {
    const original = await recordCredit(fake.tx, {
      userId: "u1",
      type: "SUPPORT_COMPLETED",
      amount: 10,
      idempotencyKey: "k1",
      sessionId: "s1",
    });

    const reversal = await reverseCredit(fake.tx, original.entryId!, "fraud");
    expect(reversal.applied).toBe(true);
    expect(reversal.balanceAfter).toBe(0);
    expect(fake.users.get("u1")!.credits).toBe(0);
    expect(fake.credits).toHaveLength(2);
    expect(fake.credits[1].amount).toBe(-10);
    expect(fake.credits[1].reversalOfId).toBe(original.entryId);
  });

  it("cannot reverse the same entry twice", async () => {
    const original = await recordCredit(fake.tx, { userId: "u1", type: "SUPPORT_COMPLETED", amount: 10, idempotencyKey: "k1" });
    await reverseCredit(fake.tx, original.entryId!, "fraud");
    const second = await reverseCredit(fake.tx, original.entryId!, "fraud again");

    expect(second.applied).toBe(false);
    expect(fake.users.get("u1")!.credits).toBe(0);
    expect(fake.credits).toHaveLength(2);
  });

  it("is a no-op for an unknown entry", async () => {
    const result = await reverseCredit(fake.tx, "missing", "reason");
    expect(result.applied).toBe(false);
  });
});

describe("auditUserBalances", () => {
  it("reports consistency between the cache and the ledger", async () => {
    const fake = createFakeTx();
    await recordCredit(fake.tx, { userId: "u1", type: "SUPPORT_COMPLETED", amount: 10, idempotencyKey: "a" });
    await recordXp(fake.tx, { userId: "u1", type: "SUPPORT_COMPLETED", amount: 25, idempotencyKey: "b" });

    const audit = await auditUserBalances(fake.tx, "u1");
    expect(audit.consistent).toBe(true);
    expect(audit.credits.drift).toBe(0);
    expect(audit.xp.drift).toBe(0);
  });

  it("detects injected drift", async () => {
    const fake = createFakeTx();
    await recordCredit(fake.tx, { userId: "u1", type: "SUPPORT_COMPLETED", amount: 10, idempotencyKey: "a" });
    // Simulate a rogue direct write, the exact class of bug the ledger prevents.
    fake.users.get("u1")!.credits = 999;

    const audit = await auditUserBalances(fake.tx, "u1");
    expect(audit.consistent).toBe(false);
    expect(audit.credits.drift).toBe(989);
  });
});

describe("grantSignupCredits", () => {
  let fake: ReturnType<typeof createFakeTx>;
  beforeEach(() => {
    fake = createFakeTx();
  });

  it("grants the configured amount through the ledger, not as a bare balance", async () => {
    const result = await grantSignupCredits(fake.tx, "u1");
    expect(result.applied).toBe(true);
    expect(result.balanceAfter).toBe(SIGNUP_GRANT_CREDITS);
    expect(fake.users.get("u1")!.credits).toBe(SIGNUP_GRANT_CREDITS);
    // Recorded as an entry, so auditUserBalances stays consistent afterwards.
    expect(fake.credits).toHaveLength(1);
    expect(fake.credits[0].type).toBe("SIGNUP_GRANT");
  });

  it("grants at most once per user, however many times it is called", async () => {
    // This is what makes it safe to call unconditionally on every registration and
    // to re-run the backfill migration.
    for (let i = 0; i < 5; i += 1) await grantSignupCredits(fake.tx, "u1");
    expect(fake.users.get("u1")!.credits).toBe(SIGNUP_GRANT_CREDITS);
    expect(fake.credits).toHaveLength(1);
  });

  it("keeps the cache reconcilable with the ledger", async () => {
    await grantSignupCredits(fake.tx, "u1");
    const audit = await auditUserBalances(fake.tx, "u1");
    expect(audit.consistent).toBe(true);
    expect(audit.credits.drift).toBe(0);
  });
});

describe("XP rollup — what makes XpLedger retention safe", () => {
  let fake: ReturnType<typeof createFakeTx>;
  beforeEach(() => {
    fake = createFakeTx();
  });

  it("writes a permanent per-day aggregate alongside every XP entry", async () => {
    await recordXp(fake.tx, { userId: "u1", type: "SUPPORT_COMPLETED", amount: 25, idempotencyKey: "x1" });
    const rollup = await fake.tx.userDailyRollup.aggregate({ where: { userId: "u1" }, _sum: { xp: true } });
    expect(rollup._sum.xp).toBe(25);
    expect(fake.rollups.size).toBe(1);
  });

  it("accumulates several entries on the same day into one row", async () => {
    await recordXp(fake.tx, { userId: "u1", type: "SUPPORT_COMPLETED", amount: 25, idempotencyKey: "x1" });
    await recordXp(fake.tx, { userId: "u1", type: "MUTUAL_BONUS", amount: 10, idempotencyKey: "x2" });
    expect(fake.rollups.size).toBe(1);
    const rollup = await fake.tx.userDailyRollup.aggregate({ where: { userId: "u1" }, _sum: { xp: true } });
    expect(rollup._sum.xp).toBe(35);
  });

  it("does not double count a replayed idempotency key", async () => {
    await recordXp(fake.tx, { userId: "u1", type: "SUPPORT_COMPLETED", amount: 25, idempotencyKey: "x1" });
    await recordXp(fake.tx, { userId: "u1", type: "SUPPORT_COMPLETED", amount: 25, idempotencyKey: "x1" });
    const rollup = await fake.tx.userDailyRollup.aggregate({ where: { userId: "u1" }, _sum: { xp: true } });
    expect(rollup._sum.xp).toBe(25);
  });

  it("decrements on reversal, so the rollup nets out like the balance", async () => {
    const original = await recordXp(fake.tx, {
      userId: "u1",
      type: "SUPPORT_COMPLETED",
      amount: 40,
      idempotencyKey: "x1",
    });
    await reverseXp(fake.tx, original.entryId!, "support reversed");

    expect(fake.users.get("u1")!.points).toBe(0);
    const rollup = await fake.tx.userDailyRollup.aggregate({ where: { userId: "u1" }, _sum: { xp: true } });
    expect(rollup._sum.xp).toBe(0);
  });

  it("keeps the rollup equal to User.points, which is what the audit compares", async () => {
    await recordXp(fake.tx, { userId: "u1", type: "SUPPORT_COMPLETED", amount: 120, idempotencyKey: "a" });
    await recordXp(fake.tx, { userId: "u1", type: "STREAK", amount: 30, idempotencyKey: "b" });

    const audit = await auditUserBalances(fake.tx, "u1");
    expect(audit.xp.cached).toBe(150);
    // Sourced from the rollup, not XpLedger: pruning the detail table must not make
    // the platform look like it has XP drift.
    expect(audit.xp.ledger).toBe(150);
    expect(audit.xp.drift).toBe(0);
  });
});

describe("compensateMissingXp — reversal after XpLedger retention", () => {
  let fake: ReturnType<typeof createFakeTx>;
  beforeEach(() => {
    fake = createFakeTx();
  });

  it("claws back the full award when no detail entries survive", async () => {
    // Simulates a support older than the 7-day window: points are on the balance,
    // but the XpLedger rows that produced them have been pruned.
    await recordXp(fake.tx, { userId: "u1", type: "SUPPORT_COMPLETED", amount: 60, idempotencyKey: "seed" });
    expect(fake.users.get("u1")!.points).toBe(60);

    const result = await compensateMissingXp(fake.tx, {
      userId: "u1",
      supportId: "sup_1",
      sessionId: "s1",
      awarded: 60,
      // reverseSessionLedger found nothing to mirror.
      alreadyReversed: 0,
      reason: "support reversed",
    });

    expect(result.applied).toBe(true);
    expect(fake.users.get("u1")!.points).toBe(0);
  });

  it("charges only the shortfall when some entries were still reversible", async () => {
    await recordXp(fake.tx, { userId: "u1", type: "SUPPORT_COMPLETED", amount: 60, idempotencyKey: "seed" });

    await compensateMissingXp(fake.tx, {
      userId: "u1",
      supportId: "sup_1",
      sessionId: "s1",
      awarded: 60,
      // 25 of the 60 was mirrored normally, so only 35 may be taken here.
      alreadyReversed: 25,
      reason: "support reversed",
    });

    expect(fake.users.get("u1")!.points).toBe(25);
  });

  it("does nothing when the ledger already reversed the whole award", async () => {
    await recordXp(fake.tx, { userId: "u1", type: "SUPPORT_COMPLETED", amount: 60, idempotencyKey: "seed" });

    const result = await compensateMissingXp(fake.tx, {
      userId: "u1",
      supportId: "sup_1",
      sessionId: "s1",
      awarded: 60,
      alreadyReversed: 60,
      reason: "support reversed",
    });

    expect(result.applied).toBe(false);
    expect(fake.users.get("u1")!.points).toBe(60);
  });

  it("is idempotent, so a retried reversal cannot charge twice", async () => {
    await recordXp(fake.tx, { userId: "u1", type: "SUPPORT_COMPLETED", amount: 60, idempotencyKey: "seed" });

    for (let i = 0; i < 3; i += 1) {
      await compensateMissingXp(fake.tx, {
        userId: "u1",
        supportId: "sup_1",
        sessionId: "s1",
        awarded: 60,
        alreadyReversed: 0,
        reason: "support reversed",
      });
    }

    expect(fake.users.get("u1")!.points).toBe(0);
  });

  it("keeps the rollup in step, so the balance audit still reconciles", async () => {
    await recordXp(fake.tx, { userId: "u1", type: "SUPPORT_COMPLETED", amount: 60, idempotencyKey: "seed" });
    await compensateMissingXp(fake.tx, {
      userId: "u1",
      supportId: "sup_1",
      sessionId: "s1",
      awarded: 60,
      alreadyReversed: 0,
      reason: "support reversed",
    });

    const audit = await auditUserBalances(fake.tx, "u1");
    expect(audit.xp.cached).toBe(0);
    expect(audit.xp.drift).toBe(0);
    expect(audit.consistent).toBe(true);
  });
});

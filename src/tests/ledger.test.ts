import { describe, expect, it, beforeEach } from "vitest";
import { ledgerKey, recordCredit, recordXp, reverseCredit, auditUserBalances } from "@/lib/services/ledger";
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
        const row =
          store.find((entry) =>
            "id" in where ? entry.id === where.id : "reversalOfId" in where ? entry.reversalOfId === where.reversalOfId : false
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
  };

  function pick(row: UserRow, select: Record<string, boolean>) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(select)) out[key] = (row as unknown as Record<string, unknown>)[key];
    return out;
  }

  return { tx: tx as unknown as Prisma.TransactionClient, users, credits, xp };
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

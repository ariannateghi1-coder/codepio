import { beforeEach, describe, expect, it, vi } from "vitest";
import { COMPLIANCE_RULES } from "@/lib/gamification";

/**
 * Subscription compliance — behaviour, in isolation.
 *
 * Everything outside the service is mocked (Prisma, YouTube, audit, notifications,
 * abuse signals, quota), so these tests exercise the actual decision logic without
 * a database and WITHOUT SPENDING A SINGLE YOUTUBE QUOTA UNIT. Every API result is
 * scripted, which is the only way to test the failure paths — an outage cannot be
 * summoned on demand.
 *
 * The properties pinned here are the ones whose absence would either break honest
 * users or make the feature unaffordable:
 *
 *   • a definitive "not subscribed" violates; a failed check never does
 *   • a violation gates future earning and touches no money
 *   • a restore reopens access and pays nothing
 *   • a fresh cached verdict is reused, so page loads cost nothing
 *   • an expired TTL triggers exactly one real check
 *   • the sweep skips inactive users and stops at its quota ceiling
 */

/* ---------------------------------------------------------------- in-memory DB */

type Row = {
  id: string;
  userId: string;
  supportId: string;
  targetChannelId: string;
  subscriptionRequired: boolean;
  subscriptionVerified: boolean;
  lastKnownSubscribed: boolean;
  lastSubscriptionCheckAt: Date | null;
  status: "ACTIVE" | "VIOLATED" | "RESTORED";
  checkFailureCount: number;
  nextCheckAfter: Date | null;
  violationDetectedAt: Date | null;
  restoredAt: Date | null;
  createdAt: Date;
  user: { status: string; lastActiveAt: Date | null };
};

let rows: Row[] = [];

const MINUTE = 60_000;
const TTL_MS = COMPLIANCE_RULES.verificationTtlMinutes * MINUTE;

function row(overrides: Partial<Row> = {}): Row {
  const id = overrides.id ?? `c${rows.length + 1}`;
  return {
    id,
    userId: "u1",
    supportId: `s-${id}`,
    targetChannelId: `UC_${id}`,
    subscriptionRequired: true,
    subscriptionVerified: true,
    lastKnownSubscribed: true,
    // Stale by default, so a check is warranted unless a test says otherwise.
    lastSubscriptionCheckAt: new Date(Date.now() - TTL_MS - MINUTE),
    status: "ACTIVE",
    checkFailureCount: 0,
    nextCheckAfter: null,
    violationDetectedAt: null,
    restoredAt: null,
    createdAt: new Date(Date.now() - 10 * 86_400_000),
    user: { status: "ACTIVE", lastActiveAt: new Date() },
    ...overrides,
  };
}

/** Minimal Prisma `where` evaluator covering the shapes this service uses. */
function matches(target: unknown, where: unknown): boolean {
  if (where === null) return target === null;
  if (where instanceof Date) return target instanceof Date && target.getTime() === where.getTime();
  if (typeof where !== "object") return target === where;

  const clause = where as Record<string, unknown>;

  for (const [key, condition] of Object.entries(clause)) {
    if (key === "OR") {
      if (!(condition as unknown[]).some((sub) => matches(target, sub))) return false;
      continue;
    }
    if (key === "AND") {
      if (!(condition as unknown[]).every((sub) => matches(target, sub))) return false;
      continue;
    }
    if (key === "in") {
      if (!(condition as unknown[]).includes(target)) return false;
      continue;
    }
    if (key === "lte") {
      if (!(target instanceof Date) || target.getTime() > (condition as Date).getTime()) return false;
      continue;
    }
    if (key === "gte") {
      if (!(target instanceof Date) || target.getTime() < (condition as Date).getTime()) return false;
      continue;
    }
    const value = (target as Record<string, unknown>)?.[key];
    if (condition !== null && typeof condition === "object" && !(condition instanceof Date)) {
      if (!matches(value, condition)) return false;
      continue;
    }
    if (!matches(value, condition)) return false;
  }
  return true;
}

function sortRows(list: Row[], orderBy: unknown): Row[] {
  const spec = orderBy as { lastSubscriptionCheckAt?: unknown; createdAt?: string } | undefined;
  if (!spec) return list;
  if (spec.createdAt) {
    return [...list].sort((a, b) =>
      spec.createdAt === "desc" ? b.createdAt.getTime() - a.createdAt.getTime() : a.createdAt.getTime() - b.createdAt.getTime()
    );
  }
  // { lastSubscriptionCheckAt: { sort: "asc", nulls: "first" } }
  return [...list].sort((a, b) => {
    const av = a.lastSubscriptionCheckAt?.getTime();
    const bv = b.lastSubscriptionCheckAt?.getTime();
    if (av === undefined && bv === undefined) return 0;
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    return av - bv;
  });
}

function applyData(target: Row, data: Record<string, unknown>) {
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && typeof value === "object" && !(value instanceof Date) && "increment" in value) {
      (target as unknown as Record<string, number>)[key] =
        ((target as unknown as Record<string, number>)[key] ?? 0) + (value as { increment: number }).increment;
      continue;
    }
    (target as unknown as Record<string, unknown>)[key] = value;
  }
}

const complianceDelegate = {
  findMany: async ({ where, orderBy, take }: { where?: unknown; orderBy?: unknown; take?: number }) => {
    const found = sortRows(rows.filter((r) => matches(r, where ?? {})), orderBy);
    return take ? found.slice(0, take) : found;
  },
  findFirst: async ({ where }: { where?: unknown }) => rows.find((r) => matches(r, where ?? {})) ?? null,
  update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
    const target = rows.find((r) => r.id === where.id);
    if (!target) throw new Error(`no row ${where.id}`);
    applyData(target, data);
    return target;
  },
  updateMany: async ({ where, data }: { where: unknown; data: Record<string, unknown> }) => {
    const found = rows.filter((r) => matches(r, where));
    found.forEach((r) => applyData(r, data));
    return { count: found.length };
  },
};

const prismaMock = {
  subscriptionCompliance: complianceDelegate,
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prismaMock),
};

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

/* --------------------------------------------------------------- other mocks */

/** Every call the service would make to YouTube, scripted. */
const subscriptionResults: {
  outcome: string;
  available: boolean;
  subscribed: string[];
}[] = [];
let apiCallLog: string[][] = [];

vi.mock("@/lib/services/youtube-api", () => ({
  checkSubscriptions: async (_userId: string, channels: string[]) => {
    apiCallLog.push(channels);
    const scripted = subscriptionResults.shift();
    if (!scripted) throw new Error("unexpected YouTube call: no scripted result left");
    return {
      outcome: scripted.outcome,
      available: scripted.available,
      subscribed: new Set(scripted.subscribed),
      detail: {},
    };
  },
}));

let sweepBudgetAllowed = true;
vi.mock("@/lib/services/youtube-quota", () => ({
  hasSweepBudget: async () => ({
    allowed: sweepBudgetAllowed,
    status: { spent: 10, dailyLimit: 10_000, remaining: 9_990, used: 0.001 },
    ceiling: 5_000,
  }),
}));

/**
 * Money-touching modules are mocked as HARD FAILURES.
 *
 * This is the strongest available statement of requirement 14: if compliance ever
 * grows a call into the ledger, the reward service or the credit/XP path, these
 * throw and the suite fails. The guarantee is enforced, not documented.
 */
vi.mock("@/lib/services/ledger", () => ({
  recordCredit: () => {
    throw new Error("compliance must never write to CreditLedger");
  },
  recordXp: () => {
    throw new Error("compliance must never write to XpLedger");
  },
  recordReputation: () => {
    throw new Error("compliance must never write reputation");
  },
  ledgerKey: (parts: unknown[]) => parts.join(":"),
  bumpAbuseRollup: async () => undefined,
}));

const abuseSignals: { type: string; severity: number }[] = [];
vi.mock("@/lib/services/anti-abuse", () => ({
  persistAbuseSignals: async (_tx: unknown, input: { reasons: { type: string; severity: number }[] }) => {
    abuseSignals.push(...input.reasons);
  },
}));

const notifications: { title: string }[] = [];
vi.mock("@/lib/services/notifications", () => ({
  createNotificationTx: async (_tx: unknown, input: { title: string }) => {
    notifications.push(input);
    return { id: "n1", userId: "u1", type: "SECURITY", title: input.title, message: "", createdAt: new Date() };
  },
  deliverNotification: async () => undefined,
}));

const auditEvents: { event?: string }[] = [];
vi.mock("@/lib/audit", () => ({
  writeAudit: async (input: { metadata?: { event?: string } }) => {
    auditEvents.push({ event: input.metadata?.event });
  },
  writeAuditTx: async (_tx: unknown, input: { metadata?: { event?: string } }) => {
    auditEvents.push({ event: input.metadata?.event });
  },
}));

/* ---------------------------------------------------------------------- setup */

async function service() {
  return import("@/lib/services/subscription-compliance");
}

function scriptApi(result: { outcome?: string; available?: boolean; subscribed?: string[] }) {
  subscriptionResults.push({
    outcome: result.outcome ?? "VERIFIED",
    available: result.available ?? true,
    subscribed: result.subscribed ?? [],
  });
}

beforeEach(() => {
  rows = [];
  subscriptionResults.length = 0;
  apiCallLog = [];
  abuseSignals.length = 0;
  notifications.length = 0;
  auditEvents.length = 0;
  sweepBudgetAllowed = true;
});

/* ----------------------------------------------------------------------- tests */

describe("verified subscription keeps a support compliant", () => {
  it("a still-subscribed obligation stays ACTIVE and blocks nothing", async () => {
    rows.push(row({ id: "a" }));
    scriptApi({ subscribed: ["UC_a"] });

    const { verifyCompliance, assertCompliant } = await service();
    const result = await verifyCompliance("u1", { force: true, reason: "USER_RECHECK" });

    expect(result.compliant).toBe(true);
    expect(result.newViolations).toEqual([]);
    expect(rows[0].status).toBe("ACTIVE");
    expect(rows[0].lastKnownSubscribed).toBe(true);

    // The gate now passes without another API call: the verdict is fresh.
    await expect(assertCompliant("u1")).resolves.toBeUndefined();
    expect(apiCallLog).toHaveLength(1);
  });
});

describe("unsubscribing after a paid support", () => {
  it("moves the obligation to VIOLATED and records why", async () => {
    rows.push(row({ id: "a" }));
    scriptApi({ subscribed: [] });

    const { verifyCompliance } = await service();
    const result = await verifyCompliance("u1", { force: true, reason: "SWEEP" });

    expect(result.compliant).toBe(false);
    expect(result.newViolations).toEqual(["UC_a"]);
    expect(rows[0].status).toBe("VIOLATED");
    expect(rows[0].violationDetectedAt).toBeInstanceOf(Date);
    expect(rows[0].lastKnownSubscribed).toBe(false);

    // Visible to a moderator, and the reason is the previously unused enum member.
    expect(abuseSignals).toEqual([expect.objectContaining({ type: "SUBSCRIPTION_CHURN" })]);
    expect(auditEvents).toEqual(expect.arrayContaining([{ event: "VIOLATION_DETECTED" }]));
    expect(notifications).toHaveLength(1);
  });

  it("blocks any new support while the violation stands (option B)", async () => {
    rows.push(row({ id: "a", status: "VIOLATED", lastKnownSubscribed: false, violationDetectedAt: new Date() }));
    // The gate re-verifies before blocking; still unsubscribed.
    scriptApi({ subscribed: [] });

    const { assertCompliant, ComplianceBlockedError } = await service();
    await expect(assertCompliant("u1")).rejects.toBeInstanceOf(ComplianceBlockedError);
  });

  it("blocks release of a reward held for review", async () => {
    // The same gate guards resolveHeldReward's APPROVE path, so a held reward
    // cannot be paid out to a non-compliant supporter.
    rows.push(row({ id: "a", status: "VIOLATED", lastKnownSubscribed: false }));
    // Two scripted answers: the gate re-verifies on each attempt, and both
    // attempts must be refused.
    scriptApi({ subscribed: [] });
    scriptApi({ subscribed: [] });

    const { assertCompliant, ComplianceBlockedError } = await service();
    // 422 PRECONDITION_FAILED with the offending channels attached, so the client
    // can name them rather than showing a bare failure.
    await expect(assertCompliant("u1")).rejects.toMatchObject({
      name: "AppError",
      code: "PRECONDITION_FAILED",
      status: 422,
      details: { channels: ["UC_a"] },
    });
    await expect(assertCompliant("u1")).rejects.toBeInstanceOf(ComplianceBlockedError);
  });

  it("stays blocked while still unsubscribed, without re-notifying every check", async () => {
    rows.push(row({ id: "a", status: "VIOLATED", lastKnownSubscribed: false, violationDetectedAt: new Date() }));
    scriptApi({ subscribed: [] });

    const { verifyCompliance } = await service();
    const result = await verifyCompliance("u1", { force: true, reason: "USER_RECHECK" });

    expect(result.compliant).toBe(false);
    expect(result.violations).toEqual(["UC_a"]);
    // Already violated: no second violation event, no second notification.
    expect(result.newViolations).toEqual([]);
    expect(notifications).toHaveLength(0);
  });
});

describe("nothing financial is touched", () => {
  it("a violation changes no reward, credit or XP state", async () => {
    rows.push(row({ id: "a" }));
    scriptApi({ subscribed: [] });

    const { verifyCompliance } = await service();
    // The ledger mock throws on any call, so reaching this line at all proves no
    // credit, XP or reputation write happened.
    await expect(verifyCompliance("u1", { force: true, reason: "SWEEP" })).resolves.toMatchObject({
      compliant: false,
    });

    // The compliance row is the only thing that changed shape.
    expect(Object.keys(rows[0])).not.toContain("creditsAwarded");
    expect(rows[0].status).toBe("VIOLATED");
  });
});

describe("restore", () => {
  it("re-subscribing lifts the block and marks the row RESTORED", async () => {
    rows.push(
      row({
        id: "a",
        status: "VIOLATED",
        lastKnownSubscribed: false,
        violationDetectedAt: new Date(Date.now() - MINUTE),
      })
    );
    scriptApi({ subscribed: ["UC_a"] });

    const { verifyCompliance } = await service();
    const result = await verifyCompliance("u1", { force: true, reason: "USER_RECHECK" });

    expect(result.compliant).toBe(true);
    expect(result.restored).toEqual(["UC_a"]);
    expect(rows[0].status).toBe("RESTORED");
    expect(rows[0].restoredAt).toBeInstanceOf(Date);
    // Cleared, so the UI does not keep showing a stale violation date.
    expect(rows[0].violationDetectedAt).toBeNull();
  });

  it("a restored user may act again immediately", async () => {
    rows.push(row({ id: "a", status: "VIOLATED", lastKnownSubscribed: false }));
    scriptApi({ subscribed: ["UC_a"] });

    const { verifyCompliance, assertCompliant } = await service();
    await verifyCompliance("u1", { force: true, reason: "USER_RECHECK" });

    await expect(assertCompliant("u1")).resolves.toBeUndefined();
  });

  it("repeated restores create no duplicate reward and no second support", async () => {
    rows.push(row({ id: "a", status: "VIOLATED", lastKnownSubscribed: false }));
    scriptApi({ subscribed: ["UC_a"] });
    scriptApi({ subscribed: ["UC_a"] });
    scriptApi({ subscribed: ["UC_a"] });

    const { verifyCompliance } = await service();
    const first = await verifyCompliance("u1", { force: true, reason: "USER_RECHECK" });
    const second = await verifyCompliance("u1", { force: true, reason: "USER_RECHECK" });
    const third = await verifyCompliance("u1", { force: true, reason: "USER_RECHECK" });

    // Only the first transition is a restore; the rest are no-ops. The ledger mock
    // would have thrown had any of them tried to pay something.
    expect(first.restored).toEqual(["UC_a"]);
    expect(second.restored).toEqual([]);
    expect(third.restored).toEqual([]);
    expect(rows).toHaveLength(1);
  });

  it("a violation is never permanent — the only requirement is re-subscribing", async () => {
    rows.push(row({ id: "a" }));
    scriptApi({ subscribed: [] });        // unsubscribed → violated
    scriptApi({ subscribed: ["UC_a"] }); // re-subscribed → restored

    const { verifyCompliance, assertCompliant } = await service();
    await verifyCompliance("u1", { force: true, reason: "SWEEP" });
    expect(rows[0].status).toBe("VIOLATED");

    await verifyCompliance("u1", { force: true, reason: "USER_RECHECK" });
    expect(rows[0].status).toBe("RESTORED");
    await expect(assertCompliant("u1")).resolves.toBeUndefined();
  });
});

describe("a failed check is never a violation", () => {
  it("a temporary error leaves the status untouched", async () => {
    rows.push(row({ id: "a" }));
    scriptApi({ outcome: "TEMPORARY_ERROR", available: false });

    const { verifyCompliance } = await service();
    const result = await verifyCompliance("u1", { force: true, reason: "SWEEP" });

    expect(rows[0].status).toBe("ACTIVE");
    expect(result.newViolations).toEqual([]);
    expect(result.apiOutcome).toBe("TEMPORARY_ERROR");
    expect(abuseSignals).toHaveLength(0);
    expect(notifications).toHaveLength(0);
  });

  it("403/429 exhaustion is handled as a failure to ask, not an answer", async () => {
    rows.push(row({ id: "a" }));
    scriptApi({ outcome: "TEMPORARY_ERROR", available: false });

    const { verifyCompliance } = await service();
    const result = await verifyCompliance("u1", { force: true, reason: "SWEEP" });

    expect(result.compliant).toBe(true);
    expect(rows[0].status).toBe("ACTIVE");
    expect(result.message).toContain("امکان بررسی");
  });

  it("a dead OAuth grant asks the user to reconnect, without accusing them", async () => {
    rows.push(row({ id: "a" }));
    scriptApi({ outcome: "REAUTH_REQUIRED", available: false });

    const { verifyCompliance } = await service();
    const result = await verifyCompliance("u1", { force: true, reason: "USER_RECHECK" });

    expect(rows[0].status).toBe("ACTIVE");
    expect(result.apiOutcome).toBe("REAUTH_REQUIRED");
    expect(result.message).toContain("یوتیوب");
  });

  it("backs off exponentially so an outage is not retried in a loop", async () => {
    rows.push(row({ id: "a" }));
    scriptApi({ outcome: "TEMPORARY_ERROR", available: false });
    scriptApi({ outcome: "TEMPORARY_ERROR", available: false });

    const { verifyCompliance } = await service();
    await verifyCompliance("u1", { force: true, reason: "SWEEP" });
    const first = rows[0].nextCheckAfter!;
    expect(rows[0].checkFailureCount).toBe(1);

    await verifyCompliance("u1", { force: true, reason: "SWEEP" });
    const second = rows[0].nextCheckAfter!;
    expect(rows[0].checkFailureCount).toBe(2);
    // Second delay is roughly double the first; jitter makes it inexact.
    expect(second.getTime() - Date.now()).toBeGreaterThan((first.getTime() - Date.now()) * 1.5);
  });

  it("a failure during an outage does not unblock an existing violation either", async () => {
    rows.push(row({ id: "a", status: "VIOLATED", lastKnownSubscribed: false }));
    scriptApi({ outcome: "TEMPORARY_ERROR", available: false });

    const { assertCompliant, ComplianceBlockedError } = await service();
    // The last definitive answer was "not subscribed", and an outage is not
    // evidence to the contrary — so the block holds.
    await expect(assertCompliant("u1")).rejects.toBeInstanceOf(ComplianceBlockedError);
  });
});

describe("quota discipline", () => {
  it("reading state makes no API call at all, however often it is read", async () => {
    rows.push(row({ id: "a", lastSubscriptionCheckAt: new Date(Date.now() - 10 * TTL_MS) }));

    const { complianceSnapshot } = await service();
    for (let i = 0; i < 25; i++) await complianceSnapshot("u1");

    // 25 page loads with a badly stale row: still zero calls. Freshness is
    // irrelevant here because this path cannot reach the API.
    expect(apiCallLog).toHaveLength(0);
  });

  it("a fresh cached verdict is reused instead of re-asking", async () => {
    rows.push(row({ id: "a", lastSubscriptionCheckAt: new Date(Date.now() - MINUTE) }));

    const { verifyCompliance, assertCompliant } = await service();
    const result = await verifyCompliance("u1", { reason: "SWEEP" });

    expect(result.consultedApi).toBe(false);
    expect(apiCallLog).toHaveLength(0);

    // Even a sensitive operation reuses it while it is inside the TTL.
    await assertCompliant("u1");
    expect(apiCallLog).toHaveLength(0);
  });

  it("an expired TTL triggers exactly one real check, then caches again", async () => {
    rows.push(row({ id: "a", lastSubscriptionCheckAt: new Date(Date.now() - TTL_MS - MINUTE) }));
    scriptApi({ subscribed: ["UC_a"] });

    const { assertCompliant } = await service();
    await assertCompliant("u1");
    expect(apiCallLog).toHaveLength(1);

    // Second and third sensitive operations ride the refreshed verdict.
    await assertCompliant("u1");
    await assertCompliant("u1");
    expect(apiCallLog).toHaveLength(1);
  });

  it("one call covers all of a user's obligations", async () => {
    rows.push(row({ id: "a" }), row({ id: "b" }), row({ id: "c" }));
    scriptApi({ subscribed: ["UC_a", "UC_b", "UC_c"] });

    const { verifyCompliance } = await service();
    await verifyCompliance("u1", { force: true, reason: "USER_RECHECK" });

    expect(apiCallLog).toHaveLength(1);
    expect(apiCallLog[0]).toHaveLength(3);
  });

  it("an obligation that was never API-verified is never checked or enforced", async () => {
    // e.g. a campaign with no subscribe task, or one passed without API proof.
    rows.push(row({ id: "a", subscriptionRequired: false }));
    rows.push(row({ id: "b", subscriptionVerified: false }));

    const { verifyCompliance, complianceSnapshot } = await service();
    const result = await verifyCompliance("u1", { force: true, reason: "USER_RECHECK" });

    expect(apiCallLog).toHaveLength(0);
    expect(result.compliant).toBe(true);
    expect((await complianceSnapshot("u1")).totalObligations).toBe(0);
  });
});

describe("background sweep", () => {
  it("checks a stale obligation belonging to an active user", async () => {
    rows.push(row({ id: "a" }));
    scriptApi({ subscribed: ["UC_a"] });

    const { runComplianceSweep } = await service();
    const result = await runComplianceSweep();

    expect(result.usersChecked).toBe(1);
    expect(apiCallLog).toHaveLength(1);
  });

  it("skips users who have been inactive", async () => {
    const longAgo = new Date(Date.now() - (COMPLIANCE_RULES.inactiveDays + 5) * 86_400_000);
    rows.push(row({ id: "a", user: { status: "ACTIVE", lastActiveAt: longAgo } }));

    const { runComplianceSweep } = await service();
    const result = await runComplianceSweep();

    // A dormant user cannot earn anything without passing the gate at that moment,
    // so checking them in the background would spend quota for nothing.
    expect(result.usersConsidered).toBe(0);
    expect(apiCallLog).toHaveLength(0);
  });

  it("skips rows still inside their backoff window", async () => {
    rows.push(row({ id: "a", nextCheckAfter: new Date(Date.now() + 30 * MINUTE) }));

    const { runComplianceSweep } = await service();
    await runComplianceSweep();

    expect(apiCallLog).toHaveLength(0);
  });

  it("skips rows whose verdict is still fresh", async () => {
    rows.push(row({ id: "a", lastSubscriptionCheckAt: new Date(Date.now() - MINUTE) }));

    const { runComplianceSweep } = await service();
    await runComplianceSweep();

    expect(apiCallLog).toHaveLength(0);
  });

  it("stops when the quota ceiling is reached rather than pushing through", async () => {
    rows.push(row({ id: "a", userId: "u1" }), row({ id: "b", userId: "u2" }));
    sweepBudgetAllowed = false;

    const { runComplianceSweep } = await service();
    const result = await runComplianceSweep();

    expect(result.skippedForQuota).toBe(true);
    expect(result.usersChecked).toBe(0);
    expect(apiCallLog).toHaveLength(0);
  });

  it("caps the number of users examined in one run", async () => {
    for (let i = 0; i < COMPLIANCE_RULES.sweepMaxUsersPerRun + 10; i++) {
      rows.push(row({ id: `u${i}`, userId: `user${i}` }));
      scriptApi({ subscribed: [`UC_u${i}`] });
    }

    const { runComplianceSweep } = await service();
    const result = await runComplianceSweep();

    expect(result.usersConsidered).toBe(COMPLIANCE_RULES.sweepMaxUsersPerRun);
    expect(apiCallLog.length).toBeLessThanOrEqual(COMPLIANCE_RULES.sweepMaxUsersPerRun);
  });
});

describe("client state cannot be manipulated", () => {
  it("the snapshot is derived from stored rows, not from any input", async () => {
    rows.push(row({ id: "a", status: "VIOLATED", lastKnownSubscribed: false, violationDetectedAt: new Date() }));

    const { complianceSnapshot } = await service();
    const snapshot = await complianceSnapshot("u1");

    // There is no argument through which a caller could assert compliance: the
    // function takes a user id and reads the database.
    expect(snapshot.compliant).toBe(false);
    expect(snapshot.status).toBe("VIOLATED");
    expect(snapshot.violations).toHaveLength(1);
    expect(snapshot.message).toContain("اشتراک");
  });

  it("state is scoped to the user, so one account cannot read or affect another", async () => {
    rows.push(row({ id: "a", userId: "u1", status: "VIOLATED", lastKnownSubscribed: false }));
    rows.push(row({ id: "b", userId: "u2" }));

    const { complianceSnapshot } = await service();
    expect((await complianceSnapshot("u2")).compliant).toBe(true);
    expect((await complianceSnapshot("u2")).violations).toHaveLength(0);
    expect((await complianceSnapshot("u1")).compliant).toBe(false);
  });
});

describe("existing data stays intact", () => {
  it("a user with no obligations is unaffected and costs nothing to check", async () => {
    // Every account that predates this feature is in exactly this position.
    const { verifyCompliance, assertCompliant, complianceSnapshot } = await service();

    const snapshot = await complianceSnapshot("legacy-user");
    expect(snapshot).toMatchObject({ compliant: true, status: "NO_OBLIGATIONS", totalObligations: 0 });

    const result = await verifyCompliance("legacy-user", { force: true, reason: "USER_RECHECK" });
    expect(result.compliant).toBe(true);
    expect(result.consultedApi).toBe(false);

    await expect(assertCompliant("legacy-user")).resolves.toBeUndefined();
    expect(apiCallLog).toHaveLength(0);
  });
});

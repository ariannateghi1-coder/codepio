import { describe, expect, it } from "vitest";
import { MAX_BADGE_CREDITS_PER_USER, simulateEconomy } from "@/lib/services/economy-simulation";

describe("economy simulation", () => {
  it("models the requested 10,000 users × 20 supports/day baseline", () => {
    const result = simulateEconomy({ users: 10_000, supportsPerUserPerDay: 20 });
    expect(result.supports).toBe(200_000);
    expect(result.sources.supporter).toBe(2_000_000);
    expect(result.sources.creator).toBe(600_000);
    expect(result.sinks.budgetSpend).toBe(2_000_000);
    expect(result.netIssuance).toBe(600_000);
  });

  it("accounts independently for mutual, task, referral, streak and badge sources", () => {
    const result = simulateEconomy({
      users: 100,
      supportsPerUserPerDay: 2,
      mutualRate: 0.25,
      optionalTaskCreditsPerSupport: 2,
      referralRate: 0.1,
      streakCreditsPerUser: 3,
      badgeCreditsPerUser: MAX_BADGE_CREDITS_PER_USER,
    });
    expect(result.sources.mutual).toBe(200);
    expect(result.sources.task).toBe(400);
    expect(result.sources.referral).toBe(200);
    expect(result.sources.streak).toBe(300);
    expect(result.sources.badge).toBe(12_900);
    expect(result.sources.total - result.sinks.total).toBe(result.netIssuance);
  });

  it("can model a balanced policy by increasing the campaign sink", () => {
    const result = simulateEconomy({ users: 10_000, supportsPerUserPerDay: 20, budgetSpendPerSupport: 13 });
    expect(result.netIssuance).toBe(0);
  });

  it("rejects invalid rates and negative inputs", () => {
    expect(() => simulateEconomy({ users: -1, supportsPerUserPerDay: 20 })).toThrow(RangeError);
    expect(() => simulateEconomy({ users: 1, supportsPerUserPerDay: 1, mutualRate: 1.1 })).toThrow(RangeError);
  });
});

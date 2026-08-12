import { describe, expect, it } from "vitest";
import { computeSettlement, defaultTaskBonus, settlementBreakdown, type SettlementTask } from "@/lib/services/reward";
import { REWARDS, TASK_REWARDS, pairRewardMultiplier } from "@/lib/gamification";

/**
 * Reward settlement. These tests pin the CANONICAL reward model, whose entire
 * purpose is preventing double counting: campaign base covers required tasks,
 * only satisfied optional tasks add a bonus, and mutual is paid once per pair.
 */

const watch: SettlementTask = { type: "WATCH_VIDEO", required: true, satisfied: true, rewardCredits: 0, rewardXp: 0 };
const subscribe: SettlementTask = { type: "SUBSCRIBE_CHANNEL", required: true, satisfied: true, rewardCredits: 0, rewardXp: 0 };
const comment = (satisfied: boolean): SettlementTask => ({
  type: "COMMENT_VIDEO",
  required: false,
  satisfied,
  rewardCredits: 3,
  rewardXp: 6,
});

const base = {
  baseCredits: 20,
  baseXp: 40,
  priorPairSupports: 0,
  mutual: false,
  firstMutualForPair: false,
};

describe("computeSettlement — base", () => {
  it("pays the campaign base for required tasks and nothing extra", () => {
    const result = computeSettlement({ ...base, tasks: [watch, subscribe] });
    expect(result.base.credits).toBe(20);
    expect(result.base.xp).toBe(40);
    expect(result.taskBonuses).toHaveLength(0);
    expect(result.totalCredits).toBe(20);
    expect(result.totalXp).toBe(40);
  });

  it("IGNORES a reward attached to a required task (no double counting)", () => {
    // Even if old data carries a required-task reward, it must not be added: its
    // value is already inside the campaign base.
    const paidRequired: SettlementTask = { ...subscribe, rewardCredits: 99, rewardXp: 99 };
    const result = computeSettlement({ ...base, tasks: [watch, paidRequired] });
    expect(result.totalCredits).toBe(20);
    expect(result.taskBonuses).toHaveLength(0);
  });

  it("falls back to the platform default when the campaign has no reward", () => {
    const result = computeSettlement({ ...base, baseCredits: 0, baseXp: 0, tasks: [watch] });
    // A zero base is normalised to zero, not to a surprise default: the caller
    // supplies REWARDS.SUPPORT_COMPLETED when the campaign is unset.
    expect(result.totalCredits).toBe(0);
    expect(REWARDS.SUPPORT_COMPLETED.credits).toBeGreaterThan(0);
  });

  it("never produces a negative or non-finite payout", () => {
    const result = computeSettlement({ ...base, baseCredits: -50, baseXp: Number.NaN, tasks: [watch] });
    expect(result.totalCredits).toBe(0);
    expect(result.totalXp).toBe(0);
  });
});

describe("computeSettlement — optional task bonuses", () => {
  it("adds a bonus only when the optional task was actually satisfied", () => {
    const done = computeSettlement({ ...base, tasks: [watch, comment(true)] });
    expect(done.taskBonuses).toHaveLength(1);
    expect(done.totalCredits).toBe(23);
    expect(done.totalXp).toBe(46);

    const skipped = computeSettlement({ ...base, tasks: [watch, comment(false)] });
    expect(skipped.taskBonuses).toHaveLength(0);
    expect(skipped.totalCredits).toBe(20);
  });

  it("an unsatisfied optional task never reduces the base reward", () => {
    const skipped = computeSettlement({ ...base, tasks: [watch, comment(false)] });
    const withoutTask = computeSettlement({ ...base, tasks: [watch] });
    expect(skipped.totalCredits).toBe(withoutTask.totalCredits);
  });

  it("drops a zero-value bonus rather than emitting an empty component", () => {
    const zero: SettlementTask = { ...comment(true), rewardCredits: 0, rewardXp: 0 };
    expect(computeSettlement({ ...base, tasks: [watch, zero] }).taskBonuses).toHaveLength(0);
  });
});

describe("computeSettlement — pair multiplier", () => {
  it("applies diminishing returns to the base only", () => {
    const first = computeSettlement({ ...base, tasks: [watch, comment(true)], priorPairSupports: 0 });
    const fourth = computeSettlement({ ...base, tasks: [watch, comment(true)], priorPairSupports: 3 });

    expect(fourth.base.credits).toBeLessThan(first.base.credits);
    // The comment bonus is unchanged: repeat-pair penalty is about the pair, not
    // about punishing the extra effort.
    expect(fourth.taskBonuses[0].credits).toBe(first.taskBonuses[0].credits);
  });

  it("uses the same multiplier the config defines", () => {
    const result = computeSettlement({ ...base, tasks: [watch], priorPairSupports: 2 });
    expect(result.multiplier).toBe(pairRewardMultiplier(2));
    expect(result.base.credits).toBe(Math.round(20 * pairRewardMultiplier(2)));
  });

  it("labels the base with the multiplier when it is reduced", () => {
    const reduced = computeSettlement({ ...base, tasks: [watch], priorPairSupports: 2 });
    expect(reduced.base.label).toContain("ضریب");
    const full = computeSettlement({ ...base, tasks: [watch], priorPairSupports: 0 });
    expect(full.base.label).not.toContain("ضریب");
  });
});

describe("computeSettlement — mutual bonus", () => {
  it("pays the mutual bonus once, on the first reciprocal settlement", () => {
    const firstTime = computeSettlement({ ...base, tasks: [watch], mutual: true, firstMutualForPair: true });
    expect(firstTime.mutualBonus).not.toBeNull();
    expect(firstTime.totalCredits).toBe(20 + REWARDS.MUTUAL_BONUS.credits);

    const laterTime = computeSettlement({ ...base, tasks: [watch], mutual: true, firstMutualForPair: false });
    expect(laterTime.mutualBonus).toBeNull();
    expect(laterTime.totalCredits).toBe(20);
  });
});

describe("computeSettlement — budget and creator side", () => {
  it("charges the campaign budget exactly what the supporter is paid", () => {
    const result = computeSettlement({ ...base, tasks: [watch, comment(true)], mutual: true, firstMutualForPair: true });
    expect(result.budgetCost).toBe(result.totalCredits);
  });

  it("pays the creator a platform-funded amount that is NOT charged to their budget", () => {
    const result = computeSettlement({ ...base, tasks: [watch] });
    expect(result.creatorCredits).toBe(REWARDS.SUPPORT_RECEIVED.credits);
    // The budget covers only the supporter's payout, never the creator's own.
    expect(result.budgetCost).toBe(result.totalCredits);
    expect(result.budgetCost).not.toBe(result.totalCredits + result.creatorCredits);
  });
});

describe("settlementBreakdown", () => {
  it("lists every paid component exactly once", () => {
    const result = computeSettlement({
      ...base,
      tasks: [watch, comment(true)],
      mutual: true,
      firstMutualForPair: true,
    });
    const parts = settlementBreakdown(result);
    expect(parts).toHaveLength(3);
    expect(parts.reduce((sum, part) => sum + part.credits, 0)).toBe(result.totalCredits);
    expect(parts.reduce((sum, part) => sum + part.xp, 0)).toBe(result.totalXp);
  });

  it("gives every component a unique key, so ledger idempotency keys cannot collide", () => {
    const result = computeSettlement({
      ...base,
      tasks: [watch, comment(true)],
      mutual: true,
      firstMutualForPair: true,
    });
    const keys = settlementBreakdown(result).map((part) => part.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("defaultTaskBonus", () => {
  it("is zero for required tasks", () => {
    expect(defaultTaskBonus("SUBSCRIBE_CHANNEL", true)).toEqual({ credits: 0, xp: 0 });
    expect(defaultTaskBonus("WATCH_VIDEO", true)).toEqual({ credits: 0, xp: 0 });
  });

  it("uses the configured task reward for optional tasks", () => {
    expect(defaultTaskBonus("COMMENT_VIDEO", false)).toEqual(TASK_REWARDS.COMMENT_VIDEO);
  });
});

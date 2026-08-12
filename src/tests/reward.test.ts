import { describe, expect, it } from "vitest";
import { computeSettlement, defaultTaskBonus, settlementBreakdown, type SettlementTask } from "@/lib/services/reward";
import { REWARDS, SUPPORT_TRANSFER_CREDITS, TASK_REWARDS, pairRewardMultiplier } from "@/lib/gamification";

/**
 * Reward settlement.
 *
 * These tests pin CREDIT CONSERVATION: a support moves one fixed amount from the
 * campaign budget to the supporter, and nothing else in the settlement touches
 * credits. Every "does this pay credits?" case below is deliberately asserting
 * ZERO, because each one was previously a way for the supply to grow.
 */

const watch: SettlementTask = { type: "WATCH_VIDEO", required: true, satisfied: true, rewardXp: 0 };
const subscribe: SettlementTask = { type: "SUBSCRIBE_CHANNEL", required: true, satisfied: true, rewardXp: 0 };
const comment = (satisfied: boolean): SettlementTask => ({
  type: "COMMENT_VIDEO",
  required: false,
  satisfied,
  rewardXp: 6,
});

const base = {
  baseXp: 40,
  priorPairSupports: 0,
  mutual: false,
  firstMutualForPair: false,
};

describe("credit conservation — the core invariant", () => {
  it("pays the supporter exactly what the budget is charged", () => {
    const result = computeSettlement({ ...base, tasks: [watch, subscribe] });
    expect(result.totalCredits).toBe(result.budgetCost);
    expect(result.transferCredits).toBe(result.budgetCost);
  });

  it("transfers the platform constant, not a campaign-supplied amount", () => {
    const result = computeSettlement({ ...base, tasks: [watch] });
    expect(result.transferCredits).toBe(SUPPORT_TRANSFER_CREDITS);
    expect(result.totalCredits).toBe(SUPPORT_TRANSFER_CREDITS);
  });

  it("charges the same amount no matter how the campaign is configured", () => {
    // Every knob a creator can turn, turned — the credit leg must not budge.
    const cases = [
      computeSettlement({ ...base, tasks: [watch] }),
      computeSettlement({ ...base, baseXp: 500, tasks: [watch, subscribe, comment(true)] }),
      computeSettlement({ ...base, baseXp: 1, tasks: [watch], mutual: true, firstMutualForPair: true }),
      computeSettlement({ ...base, tasks: [watch], priorPairSupports: 4 }),
    ];
    for (const result of cases) {
      expect(result.totalCredits).toBe(SUPPORT_TRANSFER_CREDITS);
      expect(result.budgetCost).toBe(SUPPORT_TRANSFER_CREDITS);
    }
  });

  it("keeps the credit leg out of every non-base component", () => {
    const result = computeSettlement({
      ...base,
      tasks: [watch, comment(true)],
      mutual: true,
      firstMutualForPair: true,
    });
    // Optional task and mutual bonus exist, and neither carries credits.
    expect(result.taskBonuses).toHaveLength(1);
    expect(result.mutualBonus).not.toBeNull();
    for (const bonus of [...result.taskBonuses, result.mutualBonus!]) {
      expect(bonus.credits).toBe(0);
    }
    // So the sum of components still equals one transfer.
    expect(settlementBreakdown(result).reduce((sum, part) => sum + part.credits, 0)).toBe(
      SUPPORT_TRANSFER_CREDITS
    );
  });

  it("does not pay the creator credits for receiving support", () => {
    const result = computeSettlement({ ...base, tasks: [watch] });
    // A creator payout would be issuance: there is no counterparty debited for it.
    expect(result).not.toHaveProperty("creatorCredits");
    expect(result.creatorXp).toBe(REWARDS.SUPPORT_RECEIVED.xp);
  });
});

describe("computeSettlement — XP base", () => {
  it("pays the campaign base XP for required tasks and nothing extra", () => {
    const result = computeSettlement({ ...base, tasks: [watch, subscribe] });
    expect(result.base.xp).toBe(40);
    expect(result.taskBonuses).toHaveLength(0);
    expect(result.totalXp).toBe(40);
  });

  it("never produces a negative or non-finite XP payout", () => {
    expect(computeSettlement({ ...base, baseXp: -50, tasks: [watch] }).totalXp).toBe(0);
    expect(computeSettlement({ ...base, baseXp: Number.NaN, tasks: [watch] }).totalXp).toBe(0);
  });

  it("still transfers credits even when the campaign configures zero XP", () => {
    const result = computeSettlement({ ...base, baseXp: 0, tasks: [watch] });
    expect(result.totalXp).toBe(0);
    expect(result.totalCredits).toBe(SUPPORT_TRANSFER_CREDITS);
  });
});

describe("computeSettlement — optional task bonuses", () => {
  it("adds an XP bonus only when the optional task was actually satisfied", () => {
    const done = computeSettlement({ ...base, tasks: [watch, comment(true)] });
    expect(done.taskBonuses).toHaveLength(1);
    expect(done.totalXp).toBe(46);

    const skipped = computeSettlement({ ...base, tasks: [watch, comment(false)] });
    expect(skipped.taskBonuses).toHaveLength(0);
    expect(skipped.totalXp).toBe(40);
  });

  it("an unsatisfied optional task never reduces the base reward", () => {
    const skipped = computeSettlement({ ...base, tasks: [watch, comment(false)] });
    const withoutTask = computeSettlement({ ...base, tasks: [watch] });
    expect(skipped.totalXp).toBe(withoutTask.totalXp);
    expect(skipped.totalCredits).toBe(withoutTask.totalCredits);
  });

  it("ignores a reward attached to a required task", () => {
    const paidRequired: SettlementTask = { ...subscribe, rewardXp: 99 };
    const result = computeSettlement({ ...base, tasks: [watch, paidRequired] });
    expect(result.totalXp).toBe(40);
    expect(result.taskBonuses).toHaveLength(0);
  });

  it("drops a zero-value bonus rather than emitting an empty component", () => {
    const zero: SettlementTask = { ...comment(true), rewardXp: 0 };
    expect(computeSettlement({ ...base, tasks: [watch, zero] }).taskBonuses).toHaveLength(0);
  });
});

describe("computeSettlement — pair multiplier applies to XP only", () => {
  it("reduces repeat-pair XP", () => {
    const first = computeSettlement({ ...base, tasks: [watch], priorPairSupports: 0 });
    const fourth = computeSettlement({ ...base, tasks: [watch], priorPairSupports: 3 });
    expect(fourth.base.xp).toBeLessThan(first.base.xp);
    expect(fourth.base.xp).toBe(Math.round(40 * pairRewardMultiplier(3)));
  });

  it("does NOT reduce the credit transfer", () => {
    // Scaling the credit leg would pay the supporter less than the creator was
    // charged, destroying the difference — the mirror image of minting.
    const first = computeSettlement({ ...base, tasks: [watch], priorPairSupports: 0 });
    const tenth = computeSettlement({ ...base, tasks: [watch], priorPairSupports: 9 });
    expect(tenth.totalCredits).toBe(first.totalCredits);
    expect(tenth.budgetCost).toBe(tenth.totalCredits);
  });

  it("leaves the optional-task bonus unscaled", () => {
    const first = computeSettlement({ ...base, tasks: [watch, comment(true)], priorPairSupports: 0 });
    const fourth = computeSettlement({ ...base, tasks: [watch, comment(true)], priorPairSupports: 3 });
    expect(fourth.taskBonuses[0].xp).toBe(first.taskBonuses[0].xp);
  });

  it("labels the base as an XP multiplier when it is reduced", () => {
    const reduced = computeSettlement({ ...base, tasks: [watch], priorPairSupports: 2 });
    expect(reduced.base.label).toContain("ضریب");
    const full = computeSettlement({ ...base, tasks: [watch], priorPairSupports: 0 });
    expect(full.base.label).not.toContain("ضریب");
  });
});

describe("computeSettlement — mutual bonus", () => {
  it("pays mutual XP once, on the first reciprocal settlement", () => {
    const firstTime = computeSettlement({ ...base, tasks: [watch], mutual: true, firstMutualForPair: true });
    expect(firstTime.mutualBonus).not.toBeNull();
    expect(firstTime.totalXp).toBe(40 + REWARDS.MUTUAL_BONUS.xp);

    const laterTime = computeSettlement({ ...base, tasks: [watch], mutual: true, firstMutualForPair: false });
    expect(laterTime.mutualBonus).toBeNull();
    expect(laterTime.totalXp).toBe(40);
  });
});

describe("settlementBreakdown", () => {
  it("lists every component exactly once and sums to the totals", () => {
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
    expect(defaultTaskBonus("SUBSCRIBE_CHANNEL", true)).toEqual({ xp: 0 });
    expect(defaultTaskBonus("WATCH_VIDEO", true)).toEqual({ xp: 0 });
  });

  it("uses the configured task XP for optional tasks", () => {
    expect(defaultTaskBonus("COMMENT_VIDEO", false)).toEqual({ xp: TASK_REWARDS.COMMENT_VIDEO.xp });
  });
});

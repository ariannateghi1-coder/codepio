import { REWARDS, TASK_REWARDS, pairRewardMultiplier } from "../gamification";
import type { TaskType } from "@prisma/client";

/**
 * Reward settlement — the single, canonical reward model.
 *
 * The schema previously allowed two parallel reward models: `Campaign.rewardCredits`
 * AND `CampaignTask.rewardCredits`. Nothing summed them, nothing validated them
 * against each other, and either one could plausibly have been "the" reward. Two
 * ambiguous models is how double counting happens, so the ambiguity is resolved
 * here, once:
 *
 *   CANONICAL MODEL
 *   ───────────────
 *   base    = Campaign.rewardCredits / rewardXp
 *             The reward for satisfying ALL REQUIRED tasks. This is the number the
 *             Explore card promises, and required tasks therefore carry no reward
 *             of their own — their value is already inside `base`.
 *
 *   bonus   = Σ CampaignTask.rewardCredits for SATISFIED OPTIONAL tasks
 *             Optional tasks are the only place task-level rewards apply. A
 *             required task with a non-zero reward is rejected at creation time.
 *
 *   mutual  = REWARDS.MUTUAL_BONUS, paid once per pair on the first genuine
 *             two-way exchange.
 *
 *   final   = round(base × pairMultiplier) + bonus + mutual
 *             The pair multiplier applies to `base` only: diminishing returns are
 *             about repeatedly supporting the same creator, not about punishing
 *             someone for leaving a comment.
 *
 * Every figure the user is shown comes from this function, and the ledger writes
 * exactly these components with one idempotency key each. There is no other place
 * in the codebase that decides what a support is worth.
 */

export type SettlementTask = {
  type: TaskType;
  required: boolean;
  satisfied: boolean;
  /** Task-level reward from the campaign config. Only honoured when optional. */
  rewardCredits: number;
  rewardXp: number;
};

export type SettlementInput = {
  baseCredits: number;
  baseXp: number;
  tasks: SettlementTask[];
  /** How many times this supporter already supported this creator. */
  priorPairSupports: number;
  /** True when the creator has previously supported this supporter. */
  mutual: boolean;
  /** True when this is the first reciprocal settlement for the pair. */
  firstMutualForPair: boolean;
};

export type SettlementComponent = {
  key: string;
  label: string;
  credits: number;
  xp: number;
};

export type Settlement = {
  /** Campaign base after the pair multiplier. */
  base: SettlementComponent;
  /** One entry per satisfied optional task. */
  taskBonuses: SettlementComponent[];
  /** Mutual-exchange bonus, or null when it does not apply. */
  mutualBonus: SettlementComponent | null;
  multiplier: number;
  /** What the supporter is paid in total. */
  totalCredits: number;
  totalXp: number;
  /** What the creator is paid for receiving verified support. */
  creatorCredits: number;
  creatorXp: number;
  /** Credits that must be available in the campaign budget for this settlement. */
  budgetCost: number;
};

const TASK_LABELS: Record<TaskType, string> = {
  WATCH_VIDEO: "تماشای ویدیو",
  SUBSCRIBE_CHANNEL: "سابسکرایب کانال",
  LIKE_VIDEO: "لایک ویدیو",
  COMMENT_VIDEO: "کامنت",
};

/**
 * Computes a full settlement breakdown. Pure and total: same input, same output,
 * no clamping surprises — negative or absurd configuration is normalised here so
 * no caller has to defend against it.
 */
export function computeSettlement(input: SettlementInput): Settlement {
  const multiplier = pairRewardMultiplier(Math.max(0, input.priorPairSupports));

  const baseCredits = Math.max(0, Math.round(nonNegative(input.baseCredits) * multiplier));
  const baseXp = Math.max(0, Math.round(nonNegative(input.baseXp) * multiplier));

  const base: SettlementComponent = {
    key: "base",
    label: multiplier < 1 ? `پاداش پایه (ضریب ${multiplier})` : "پاداش پایه",
    credits: baseCredits,
    xp: baseXp,
  };

  // Only satisfied OPTIONAL tasks contribute a bonus. Required-task rewards are
  // deliberately ignored even if present in old data: their value is in `base`.
  const taskBonuses: SettlementComponent[] = input.tasks
    .filter((task) => !task.required && task.satisfied)
    .map((task) => ({
      key: `task:${task.type}`,
      label: `${TASK_LABELS[task.type] ?? task.type} (اختیاری)`,
      credits: nonNegative(task.rewardCredits),
      xp: nonNegative(task.rewardXp),
    }))
    .filter((bonus) => bonus.credits > 0 || bonus.xp > 0);

  const mutualBonus: SettlementComponent | null = input.firstMutualForPair
    ? {
        key: "mutual",
        label: "پاداش حمایت متقابل",
        credits: REWARDS.MUTUAL_BONUS.credits,
        xp: REWARDS.MUTUAL_BONUS.xp,
      }
    : null;

  const components = [base, ...taskBonuses, ...(mutualBonus ? [mutualBonus] : [])];
  const totalCredits = components.reduce((sum, part) => sum + part.credits, 0);
  const totalXp = components.reduce((sum, part) => sum + part.xp, 0);

  return {
    base,
    taskBonuses,
    mutualBonus,
    multiplier,
    totalCredits,
    totalXp,
    creatorCredits: REWARDS.SUPPORT_RECEIVED.credits,
    creatorXp: REWARDS.SUPPORT_RECEIVED.xp,
    // The creator's own payout is platform-funded, not campaign-funded: charging
    // a creator's budget for the reward they receive would be circular.
    budgetCost: totalCredits,
  };
}

/**
 * Default task-level bonus for an optional task, used when a campaign does not
 * specify one. Required tasks get 0 — their reward lives in the campaign base.
 */
export function defaultTaskBonus(type: TaskType, required: boolean): { credits: number; xp: number } {
  if (required) return { credits: 0, xp: 0 };
  return { credits: TASK_REWARDS[type].credits, xp: TASK_REWARDS[type].xp };
}

/** Human-readable component list, for the UI and for audit metadata. */
export function settlementBreakdown(settlement: Settlement): SettlementComponent[] {
  return [settlement.base, ...settlement.taskBonuses, ...(settlement.mutualBonus ? [settlement.mutualBonus] : [])];
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

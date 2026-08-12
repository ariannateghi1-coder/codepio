import { REWARDS, SUPPORT_TRANSFER_CREDITS, TASK_REWARDS, pairRewardMultiplier } from "../gamification";
import type { TaskType } from "@prisma/client";

/**
 * Reward settlement — the single, canonical model.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CREDIT CONSERVATION
 * ═══════════════════════════════════════════════════════════════════════════
 * A support moves ONE credit amount, and it is a TRANSFER, not a payout:
 *
 *     creator budget  −transferCredits  →  supporter  +transferCredits
 *
 * `transferCredits` is always SUPPORT_TRANSFER_CREDITS, a platform constant.
 * It is:
 *   • the same for every campaign, so no creator can pay less than another;
 *   • the same for every supporter, so no supporter can receive more;
 *   • not derived from any request field, so nothing a client sends can change it;
 *   • charged to the budget at exactly the amount paid out, so no credits are
 *     created or destroyed by a support.
 *
 * Everything else a support can earn is XP:
 *   • optional-task bonuses  → XP only
 *   • mutual-exchange bonus  → XP only
 *   • the creator's own side  → XP only
 *
 * This is why the function returns `creatorXp` but NO `creatorCredits`: paying
 * the creator credits for receiving support would mint currency out of nothing,
 * and it is what previously let total credits grow without bound.
 *
 * The pair diminishing multiplier applies to XP ONLY. Scaling the credit leg
 * would mean the supporter receives less than the creator was charged, which
 * destroys credits — the mirror image of minting, and equally a break of the
 * invariant. Repeat-pair farming is instead discouraged through XP (which drives
 * level and leaderboard) and through the risk engine.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export type SettlementTask = {
  type: TaskType;
  required: boolean;
  satisfied: boolean;
  /** XP bonus from the campaign config. Only honoured when the task is optional. */
  rewardXp: number;
};

export type SettlementInput = {
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
  /**
   * The credit transfer. Always SUPPORT_TRANSFER_CREDITS, in both directions:
   * debited from the campaign budget, credited to the supporter.
   */
  transferCredits: number;
  /** Base component: the credit transfer plus base XP after the pair multiplier. */
  base: SettlementComponent;
  /** One entry per satisfied optional task. XP only. */
  taskBonuses: SettlementComponent[];
  /** Mutual-exchange bonus, XP only, or null when it does not apply. */
  mutualBonus: SettlementComponent | null;
  /** Applies to XP only — never to transferCredits. */
  multiplier: number;
  /** What the supporter receives. Equals transferCredits, by construction. */
  totalCredits: number;
  totalXp: number;
  /** The creator's own side of a verified support: XP only, never credits. */
  creatorXp: number;
  /**
   * Credits that must be available in the campaign budget. Equals totalCredits
   * and transferCredits — the three are the same number by construction, which
   * is what makes the transfer conservative.
   */
  budgetCost: number;
};

const TASK_LABELS: Record<TaskType, string> = {
  WATCH_VIDEO: "تماشای ویدیو",
  SUBSCRIBE_CHANNEL: "سابسکرایب کانال",
  LIKE_VIDEO: "لایک ویدیو",
  COMMENT_VIDEO: "کامنت",
};

/**
 * Computes a full settlement breakdown. Pure and total: same input, same output.
 * Note there is no `baseCredits` input — the credit leg is a constant, so there
 * is nothing for a caller to pass in and nothing to get wrong.
 */
export function computeSettlement(input: SettlementInput): Settlement {
  const multiplier = pairRewardMultiplier(Math.max(0, input.priorPairSupports));

  // XP is scaled by the pair multiplier. Credits are NOT: see the header.
  const baseXp = Math.max(0, Math.round(nonNegative(input.baseXp) * multiplier));
  const transferCredits = SUPPORT_TRANSFER_CREDITS;

  const base: SettlementComponent = {
    key: "base",
    label: multiplier < 1 ? `پاداش پایه (ضریب XP ${multiplier})` : "پاداش پایه",
    credits: transferCredits,
    xp: baseXp,
  };

  // Only satisfied OPTIONAL tasks contribute a bonus, and only in XP.
  const taskBonuses: SettlementComponent[] = input.tasks
    .filter((task) => !task.required && task.satisfied)
    .map((task) => ({
      key: `task:${task.type}`,
      label: `${TASK_LABELS[task.type] ?? task.type} (اختیاری)`,
      credits: 0,
      xp: nonNegative(task.rewardXp),
    }))
    .filter((bonus) => bonus.xp > 0);

  const mutualBonus: SettlementComponent | null = input.firstMutualForPair
    ? {
        key: "mutual",
        label: "پاداش حمایت متقابل",
        credits: 0,
        xp: REWARDS.MUTUAL_BONUS.xp,
      }
    : null;

  const components = [base, ...taskBonuses, ...(mutualBonus ? [mutualBonus] : [])];
  const totalXp = components.reduce((sum, part) => sum + part.xp, 0);

  return {
    transferCredits,
    base,
    taskBonuses,
    mutualBonus,
    multiplier,
    // Identical by construction: the supporter receives exactly the transfer, and
    // the budget is charged exactly the transfer.
    totalCredits: transferCredits,
    totalXp,
    creatorXp: REWARDS.SUPPORT_RECEIVED.xp,
    budgetCost: transferCredits,
  };
}

/**
 * Default XP bonus for an optional task, used when a campaign does not specify
 * one. Required tasks get 0 — their value is inside the campaign base.
 */
export function defaultTaskBonus(type: TaskType, required: boolean): { xp: number } {
  if (required) return { xp: 0 };
  return { xp: TASK_REWARDS[type].xp };
}

/** Human-readable component list, for the UI and for audit metadata. */
export function settlementBreakdown(settlement: Settlement): SettlementComponent[] {
  return [settlement.base, ...settlement.taskBonuses, ...(settlement.mutualBonus ? [settlement.mutualBonus] : [])];
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

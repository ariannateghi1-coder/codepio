import { BADGE_DEFINITIONS, REWARDS } from "../gamification";

export type EconomySimulationInput = {
  users: number;
  supportsPerUserPerDay: number;
  days?: number;
  supporterBaseCredits?: number;
  creatorCredits?: number;
  optionalTaskCreditsPerSupport?: number;
  mutualRate?: number;
  referralRate?: number;
  streakCreditsPerUser?: number;
  badgeCreditsPerUser?: number;
  budgetSpendPerSupport?: number;
};

export type EconomySimulationResult = {
  assumptions: Required<EconomySimulationInput>;
  supports: number;
  sources: {
    supporter: number;
    creator: number;
    mutual: number;
    task: number;
    referral: number;
    streak: number;
    badge: number;
    total: number;
  };
  sinks: { budgetSpend: number; total: number };
  netIssuance: number;
  netPerSupport: number;
  budgetCoverageRatio: number;
};

const finiteNonNegative = (value: number, name: string): number => {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a finite non-negative number`);
  return value;
};

/**
 * Deterministic, parameter-driven credit economy projection.
 *
 * Sources are ledger credits minted for participants. Campaign funding is the
 * sink: credits leave creators when a budget is funded. `spentCredits` is budget
 * consumption, not a second sink, so it is deliberately not subtracted twice.
 */
export function simulateEconomy(input: EconomySimulationInput): EconomySimulationResult {
  const assumptions: Required<EconomySimulationInput> = {
    users: finiteNonNegative(input.users, "users"),
    supportsPerUserPerDay: finiteNonNegative(input.supportsPerUserPerDay, "supportsPerUserPerDay"),
    days: finiteNonNegative(input.days ?? 1, "days"),
    supporterBaseCredits: finiteNonNegative(input.supporterBaseCredits ?? REWARDS.SUPPORT_COMPLETED.credits, "supporterBaseCredits"),
    creatorCredits: finiteNonNegative(input.creatorCredits ?? REWARDS.SUPPORT_RECEIVED.credits, "creatorCredits"),
    optionalTaskCreditsPerSupport: finiteNonNegative(input.optionalTaskCreditsPerSupport ?? 0, "optionalTaskCreditsPerSupport"),
    mutualRate: finiteNonNegative(input.mutualRate ?? 0, "mutualRate"),
    referralRate: finiteNonNegative(input.referralRate ?? 0, "referralRate"),
    streakCreditsPerUser: finiteNonNegative(input.streakCreditsPerUser ?? 0, "streakCreditsPerUser"),
    badgeCreditsPerUser: finiteNonNegative(input.badgeCreditsPerUser ?? 0, "badgeCreditsPerUser"),
    budgetSpendPerSupport: finiteNonNegative(input.budgetSpendPerSupport ?? REWARDS.SUPPORT_COMPLETED.credits, "budgetSpendPerSupport"),
  };
  if (assumptions.mutualRate > 1 || assumptions.referralRate > 1) {
    throw new RangeError("mutualRate and referralRate must be between 0 and 1");
  }

  const supports = assumptions.users * assumptions.supportsPerUserPerDay * assumptions.days;
  const supporter = supports * assumptions.supporterBaseCredits;
  const creator = supports * assumptions.creatorCredits;
  const mutual = supports * assumptions.mutualRate * REWARDS.MUTUAL_BONUS.credits;
  const task = supports * assumptions.optionalTaskCreditsPerSupport;
  const referral = assumptions.users * assumptions.referralRate * REWARDS.REFERRAL.credits;
  const streak = assumptions.users * assumptions.streakCreditsPerUser;
  const badge = assumptions.users * assumptions.badgeCreditsPerUser;
  const sourceTotal = supporter + creator + mutual + task + referral + streak + badge;
  const budgetSpend = supports * assumptions.budgetSpendPerSupport;
  const netIssuance = sourceTotal - budgetSpend;

  return {
    assumptions,
    supports,
    sources: { supporter, creator, mutual, task, referral, streak, badge, total: sourceTotal },
    sinks: { budgetSpend, total: budgetSpend },
    netIssuance,
    netPerSupport: supports === 0 ? 0 : netIssuance / supports,
    budgetCoverageRatio: sourceTotal === 0 ? 0 : budgetSpend / sourceTotal,
  };
}

/** One-time badge source if every configured badge is eventually earned. */
export const MAX_BADGE_CREDITS_PER_USER = BADGE_DEFINITIONS.reduce((sum, badge) => sum + badge.credits, 0);

import { SIGNUP_GRANT_CREDITS, SUPPORT_TRANSFER_CREDITS } from "../gamification";

export type EconomySimulationInput = {
  users: number;
  supportsPerUserPerDay: number;
  days?: number;
  /** Per-account one-time grant. Defaults to the platform constant. */
  signupGrantCredits?: number;
  /** Credits moved per completed support. Defaults to the platform constant. */
  transferPerSupport?: number;
};

export type EconomySimulationResult = {
  assumptions: Required<EconomySimulationInput>;
  supports: number;
  /** Credits created. Only the signup grant creates credits. */
  issuance: number;
  /**
   * Credits moved between balances. Not issuance: every unit debited from a
   * creator's escrow is credited to a supporter, so this nets to zero.
   */
  transferVolume: number;
  netIssuance: number;
  netPerSupport: number;
  /** Total credits in existence after the modelled period. */
  totalSupply: number;
  /** True when no modelled activity changes the total supply. */
  conservative: boolean;
};

const finiteNonNegative = (value: number, name: string): number => {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a finite non-negative number`);
  return value;
};

/**
 * Deterministic projection of the credit supply.
 *
 * The previous version modelled a set of independent credit "sources" (supporter
 * payout, creator payout, mutual, task, referral, streak, badge) against a single
 * "sink" (campaign funding), and its own tests asserted a net issuance of +600,000
 * credits per day at 10,000 users — an economy where the supply grows without
 * bound and a credit means steadily less. That is no longer what the code does.
 *
 * A support is now a TRANSFER: the amount debited from the campaign's escrowed
 * budget equals the amount credited to the supporter, so support activity cannot
 * change the total supply at all. The only issuance is the one-time signup grant.
 *
 * Consequently `netIssuance` is independent of how much support activity happens,
 * and `conservative` is true by construction. The simulation is kept because it
 * documents that property and would catch a regression that reintroduced minting.
 */
export function simulateEconomy(input: EconomySimulationInput): EconomySimulationResult {
  const assumptions: Required<EconomySimulationInput> = {
    users: finiteNonNegative(input.users, "users"),
    supportsPerUserPerDay: finiteNonNegative(input.supportsPerUserPerDay, "supportsPerUserPerDay"),
    days: finiteNonNegative(input.days ?? 1, "days"),
    signupGrantCredits: finiteNonNegative(input.signupGrantCredits ?? SIGNUP_GRANT_CREDITS, "signupGrantCredits"),
    transferPerSupport: finiteNonNegative(input.transferPerSupport ?? SUPPORT_TRANSFER_CREDITS, "transferPerSupport"),
  };

  const supports = assumptions.users * assumptions.supportsPerUserPerDay * assumptions.days;
  const issuance = assumptions.users * assumptions.signupGrantCredits;
  const transferVolume = supports * assumptions.transferPerSupport;

  return {
    assumptions,
    supports,
    issuance,
    transferVolume,
    // A transfer moves credits; it does not issue them. This is the whole point.
    netIssuance: issuance,
    netPerSupport: 0,
    totalSupply: issuance,
    conservative: true,
  };
}

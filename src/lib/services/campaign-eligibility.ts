import type { Prisma } from "@prisma/client";
import { SUPPORT_TRANSFER_CREDITS } from "../gamification";

/**
 * What one completed support costs a campaign budget.
 *
 * It is the platform transfer constant, full stop — the same amount the supporter
 * receives. There is deliberately no campaign or task input: when this was a sum
 * of configurable per-campaign and per-task amounts, two campaigns charged
 * different prices for the same act, and the cost could drift from the payout.
 * See the CREDIT CONSERVATION note in src/lib/gamification.ts.
 */
export function campaignSettlementCost(): number {
  return SUPPORT_TRANSFER_CREDITS;
}

export function campaignAvailabilityWhere(now = new Date()): Prisma.CampaignWhereInput {
  return {
    status: "ACTIVE",
    startAt: { lte: now },
    endAt: { gte: now },
    budgetCredits: { gt: 0 },
    creator: { status: "ACTIVE" },
    video: { status: "ACTIVE" },
  };
}

/** Counter value that applies to the current UTC database day. */
export function effectiveDailySupports(input: {
  dailySupports: number;
  dailyCounterDay: Date;
  now?: Date;
}): number {
  const now = input.now ?? new Date();
  return input.dailyCounterDay.toISOString().slice(0, 10) === now.toISOString().slice(0, 10)
    ? input.dailySupports
    : 0;
}

export type AvailabilitySnapshot = {
  budgetCredits: number;
  spentCredits: number;
  maxTotalSupports: number | null;
  dailyLimit: number | null;
  totalSupports: number;
  dailySupports: number;
};

export type AvailabilityFailure = "CAMPAIGN_BUDGET_EXHAUSTED" | "CAMPAIGN_FULL" | "DAILY_LIMIT";

export function campaignAvailabilityFailure(input: AvailabilitySnapshot): AvailabilityFailure | null {
  const cost = campaignSettlementCost();
  if (input.budgetCredits - input.spentCredits < cost) return "CAMPAIGN_BUDGET_EXHAUSTED";
  if (input.maxTotalSupports !== null && input.totalSupports >= input.maxTotalSupports) return "CAMPAIGN_FULL";
  if (input.dailyLimit !== null && input.dailySupports >= input.dailyLimit) return "DAILY_LIMIT";
  return null;
}

/** Pure predicate shared by discovery and support settlement paths. */
export function isCampaignAvailable(input: AvailabilitySnapshot): boolean {
  return campaignAvailabilityFailure(input) === null;
}

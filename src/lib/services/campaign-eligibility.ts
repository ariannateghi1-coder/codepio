import type { Prisma } from "@prisma/client";

export function campaignSettlementCost(input: {
  rewardCredits: number;
  tasks?: { required: boolean; rewardCredits: number }[];
}): number {
  const optional = (input.tasks ?? [])
    .filter((task) => !task.required)
    .reduce((sum, task) => sum + Math.max(0, task.rewardCredits), 0);
  return Math.max(1, input.rewardCredits + optional);
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
  rewardCredits: number;
  maxTotalSupports: number | null;
  dailyLimit: number | null;
  totalSupports: number;
  dailySupports: number;
  tasks?: { required: boolean; rewardCredits: number }[];
};

export type AvailabilityFailure = "CAMPAIGN_BUDGET_EXHAUSTED" | "CAMPAIGN_FULL" | "DAILY_LIMIT";

export function campaignAvailabilityFailure(input: AvailabilitySnapshot): AvailabilityFailure | null {
  const cost = campaignSettlementCost(input);
  if (input.budgetCredits - input.spentCredits < cost) return "CAMPAIGN_BUDGET_EXHAUSTED";
  if (input.maxTotalSupports !== null && input.totalSupports >= input.maxTotalSupports) return "CAMPAIGN_FULL";
  if (input.dailyLimit !== null && input.dailySupports >= input.dailyLimit) return "DAILY_LIMIT";
  return null;
}

/** Pure predicate shared by discovery and support settlement paths. */
export function isCampaignAvailable(input: AvailabilitySnapshot): boolean {
  return campaignAvailabilityFailure(input) === null;
}

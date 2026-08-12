import { describe, expect, it } from "vitest";
import {
  campaignAvailabilityFailure,
  campaignSettlementCost,
  isCampaignAvailable,
} from "@/lib/services/campaign-eligibility";

const available = {
  budgetCredits: 100,
  spentCredits: 0,
  rewardCredits: 10,
  maxTotalSupports: 10,
  dailyLimit: 5,
  totalSupports: 0,
  dailySupports: 0,
  tasks: [{ required: false, rewardCredits: 2 }],
};

describe("campaign eligibility", () => {
  it("uses the worst-case full settlement cost", () => {
    expect(campaignSettlementCost(available)).toBe(12);
    expect(campaignAvailabilityFailure({ ...available, budgetCredits: 11 })).toBe("CAMPAIGN_BUDGET_EXHAUSTED");
  });

  it("applies capacity and rolling daily limits consistently", () => {
    expect(campaignAvailabilityFailure({ ...available, totalSupports: 10 })).toBe("CAMPAIGN_FULL");
    expect(campaignAvailabilityFailure({ ...available, dailySupports: 5 })).toBe("DAILY_LIMIT");
    expect(isCampaignAvailable(available)).toBe(true);
  });
});

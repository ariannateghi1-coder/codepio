import { describe, expect, it } from "vitest";
import {
  campaignAvailabilityFailure,
  campaignSettlementCost,
  isCampaignAvailable,
} from "@/lib/services/campaign-eligibility";
import { SUPPORT_TRANSFER_CREDITS } from "@/lib/gamification";

const available = {
  budgetCredits: 100,
  spentCredits: 0,
  maxTotalSupports: 10,
  dailyLimit: 5,
  totalSupports: 0,
  dailySupports: 0,
};

describe("campaign eligibility", () => {
  it("costs one fixed transfer per support, regardless of campaign config", () => {
    expect(campaignSettlementCost()).toBe(SUPPORT_TRANSFER_CREDITS);
  });

  it("refuses a campaign whose remaining escrow cannot cover one transfer", () => {
    expect(
      campaignAvailabilityFailure({ ...available, budgetCredits: SUPPORT_TRANSFER_CREDITS - 1 })
    ).toBe("CAMPAIGN_BUDGET_EXHAUSTED");
    expect(
      campaignAvailabilityFailure({
        ...available,
        budgetCredits: SUPPORT_TRANSFER_CREDITS * 4,
        spentCredits: SUPPORT_TRANSFER_CREDITS * 4,
      })
    ).toBe("CAMPAIGN_BUDGET_EXHAUSTED");
  });

  it("admits a campaign with exactly one transfer left", () => {
    expect(
      isCampaignAvailable({
        ...available,
        budgetCredits: SUPPORT_TRANSFER_CREDITS * 4,
        spentCredits: SUPPORT_TRANSFER_CREDITS * 3,
      })
    ).toBe(true);
  });

  it("applies capacity and rolling daily limits consistently", () => {
    expect(campaignAvailabilityFailure({ ...available, totalSupports: 10 })).toBe("CAMPAIGN_FULL");
    expect(campaignAvailabilityFailure({ ...available, dailySupports: 5 })).toBe("DAILY_LIMIT");
    expect(isCampaignAvailable(available)).toBe(true);
  });
});

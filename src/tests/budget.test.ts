import { describe, expect, it } from "vitest";
import { estimateSupports } from "@/lib/services/budget";
import { campaignCreateSchema, campaignUpdateSchema } from "@/lib/validators";

/**
 * Campaign budget arithmetic.
 *
 * The ledger side of budget funding needs a database and is covered by the
 * concurrency suite; what is testable here in isolation is the exposure estimate
 * the studio shows a creator before they commit credits.
 */

describe("estimateSupports", () => {
  it("reports how many supports a budget can pay for", () => {
    expect(estimateSupports(100, 10)).toBe(10);
    expect(estimateSupports(95, 10)).toBe(9);
  });

  it("returns null for an invalid non-positive budget", () => {
    expect(estimateSupports(0, 10)).toBeNull();
  });

  it("returns null when the reward is not a positive number", () => {
    expect(estimateSupports(100, 0)).toBeNull();
    expect(estimateSupports(100, -5)).toBeNull();
  });

  it("floors rather than rounds, so the estimate is never optimistic", () => {
    expect(estimateSupports(29, 10)).toBe(2);
    expect(estimateSupports(9, 10)).toBe(0);
  });
});

describe("campaignCreateSchema budget contract", () => {
  const validCampaign = {
    videoId: "clabcdefghijklmnopqrst",
    title: "Funded campaign",
    startAt: new Date("2026-01-01T00:00:00.000Z"),
    endAt: new Date("2026-01-02T00:00:00.000Z"),
    requiredWatchPercent: 90,
    rewardCredits: 10,
    rewardXp: 25,
    budgetCredits: 100,
    tasks: [{ type: "WATCH_VIDEO" as const, required: true, rewardCredits: 0, rewardXp: 0 }],
  };

  it("accepts a positive funded budget", () => {
    expect(campaignCreateSchema.safeParse(validCampaign).success).toBe(true);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid budget %s", (budgetCredits) => {
    const result = campaignCreateSchema.safeParse({ ...validCampaign, budgetCredits });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some((issue) => issue.path[0] === "budgetCredits")).toBe(true);
  });

  it("rejects a budget that cannot fund one full settlement", () => {
    const result = campaignCreateSchema.safeParse({ ...validCampaign, budgetCredits: 9 });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some((issue) => issue.path[0] === "budgetCredits")).toBe(true);
  });
});

describe("campaignUpdateSchema action contract", () => {
  const campaignId = "clabcdefghijklmnopqrst";

  it("requires at least one field for EDIT", () => {
    expect(campaignUpdateSchema.safeParse({ campaignId, action: "EDIT" }).success).toBe(false);
  });

  it("rejects edit fields on lifecycle actions", () => {
    expect(campaignUpdateSchema.safeParse({ campaignId, action: "PAUSE", title: "Unexpected title" }).success).toBe(false);
  });

  it("accepts a valid edit and a field-free lifecycle action", () => {
    expect(campaignUpdateSchema.safeParse({ campaignId, action: "EDIT", title: "Updated campaign" }).success).toBe(true);
    expect(campaignUpdateSchema.safeParse({ campaignId, action: "END" }).success).toBe(true);
  });
});

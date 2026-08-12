import { describe, expect, it } from "vitest";
import { estimateSupports } from "@/lib/services/budget";
import { campaignCreateSchema, campaignUpdateSchema } from "@/lib/validators";
import { SUPPORT_TRANSFER_CREDITS } from "@/lib/gamification";

/**
 * Campaign budget arithmetic.
 *
 * The ledger side of budget funding needs a database and is covered by the
 * concurrency suite; what is testable here in isolation is the exposure estimate
 * the studio shows a creator before they commit credits, and the schema contract
 * that keeps the credit leg out of client control.
 */

describe("estimateSupports", () => {
  it("divides the remaining escrow by the fixed transfer", () => {
    expect(estimateSupports(SUPPORT_TRANSFER_CREDITS * 10)).toBe(10);
    expect(estimateSupports(SUPPORT_TRANSFER_CREDITS * 10 - 1)).toBe(9);
  });

  it("returns null for an invalid non-positive budget", () => {
    expect(estimateSupports(0)).toBeNull();
    expect(estimateSupports(-5)).toBeNull();
  });

  it("floors rather than rounds, so the estimate is never optimistic", () => {
    expect(estimateSupports(SUPPORT_TRANSFER_CREDITS * 3 - 1)).toBe(2);
    expect(estimateSupports(SUPPORT_TRANSFER_CREDITS - 1)).toBe(0);
  });
});

describe("campaignCreateSchema budget contract", () => {
  const validCampaign = {
    videoId: "clabcdefghijklmnopqrst",
    title: "Funded campaign",
    startAt: new Date("2026-01-01T00:00:00.000Z"),
    endAt: new Date("2026-01-02T00:00:00.000Z"),
    requiredWatchPercent: 90,
    rewardXp: 25,
    budgetCredits: 100,
    tasks: [{ type: "WATCH_VIDEO" as const, required: true, rewardXp: 0 }],
  };

  it("accepts a positive funded budget", () => {
    expect(campaignCreateSchema.safeParse(validCampaign).success).toBe(true);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid budget %s", (budgetCredits) => {
    const result = campaignCreateSchema.safeParse({ ...validCampaign, budgetCredits });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some((issue) => issue.path[0] === "budgetCredits")).toBe(true);
  });

  it("rejects a budget that cannot fund one full transfer", () => {
    const result = campaignCreateSchema.safeParse({
      ...validCampaign,
      budgetCredits: SUPPORT_TRANSFER_CREDITS - 1,
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some((issue) => issue.path[0] === "budgetCredits")).toBe(true);
  });

  it("STRIPS a client-supplied per-support credit amount", () => {
    // The credit leg is a platform constant. If this ever came back as an accepted
    // field, one campaign could outbid another and the payout could drift from the
    // charge — the two failures the transfer model exists to prevent.
    const parsed = campaignCreateSchema.parse({ ...validCampaign, rewardCredits: 500 });
    expect(parsed).not.toHaveProperty("rewardCredits");
  });

  it("STRIPS a client-supplied per-task credit amount", () => {
    const parsed = campaignCreateSchema.parse({
      ...validCampaign,
      tasks: [
        { type: "WATCH_VIDEO" as const, required: true, rewardXp: 0 },
        { type: "COMMENT_VIDEO" as const, required: false, rewardXp: 5, rewardCredits: 99 },
      ],
    });
    for (const task of parsed.tasks) {
      expect(task).not.toHaveProperty("rewardCredits");
    }
  });

  it("still rejects a paid required task", () => {
    const result = campaignCreateSchema.safeParse({
      ...validCampaign,
      tasks: [{ type: "WATCH_VIDEO" as const, required: true, rewardXp: 40 }],
    });
    expect(result.success).toBe(false);
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

  it("refuses a budget below one full transfer", () => {
    const result = campaignUpdateSchema.safeParse({
      campaignId,
      action: "EDIT",
      budgetCredits: SUPPORT_TRANSFER_CREDITS - 1,
    });
    expect(result.success).toBe(false);
  });
});

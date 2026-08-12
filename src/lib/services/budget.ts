import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { NotFoundError } from "../errors";
import { ledgerKey, recordCredit } from "./ledger";
import { logger } from "../logger";
import { campaignSettlementCost } from "./campaign-eligibility";

/**
 * Campaign budget funding — the credit SINK that closes the product loop.
 *
 * Without this the economy is open-ended: supporters earn credits and nothing ever
 * consumes them, so the balance only grows and a credit means progressively less.
 * The loop the product actually promises is:
 *
 *   support others → earn credits → SPEND credits on exposure → receive support
 *
 * So a campaign's reward budget is paid for out of the creator's own credits, at
 * the moment the budget is set. That makes exposure cost something, gives credits
 * a real use, and ties the amount of support a creator can attract to the amount
 * they have given.
 *
 * Rules encoded here:
 *  • Funding a budget DEBITS the creator through the ledger (CAMPAIGN_BUDGET_SPEND).
 *    No `credits -= x` anywhere.
 *  • The debit and the campaign write happen in one transaction, so a campaign can
 *    never exist with an unfunded budget, and credits can never be taken without a
 *    campaign to show for it.
 *  • Raising a budget debits only the delta.
 *  • Lowering is refused below what is already spent (the remaining budget would
 *    read negative).
 *  • Ending a campaign REFUNDS the unspent remainder. A creator who over-funded is
 *    not punished for stopping early.
 *  • Every campaign has a positive, fully funded budget. Zero never means
 *    unlimited; privileged/system campaigns require a separate explicit model.
 */

type Tx = Prisma.TransactionClient;

/** Reserves credits from the creator for a campaign budget. Throws if short. */
export async function debitBudget(
  tx: Tx,
  input: { creatorId: string; campaignId: string; amount: number; note: string }
): Promise<void> {
  if (input.amount <= 0) return;

  await recordCredit(tx, {
    userId: input.creatorId,
    type: "CAMPAIGN_BUDGET_SPEND",
    amount: -input.amount,
    idempotencyKey: ledgerKey(["campaign-budget", input.campaignId, input.amount, input.note]),
    campaignId: input.campaignId,
    reason: input.note,
  });
}

/** Returns unspent budget to the creator. Used when a campaign ends. */
export async function refundUnspentBudget(
  tx: Tx,
  input: { creatorId: string; campaignId: string; budgetCredits: number; spentCredits: number }
): Promise<number> {
  const remaining = Math.max(0, input.budgetCredits - input.spentCredits);
  if (remaining <= 0) return 0;

  await recordCredit(tx, {
    userId: input.creatorId,
    type: "CAMPAIGN_BUDGET_SPEND",
    amount: remaining,
    idempotencyKey: ledgerKey(["campaign-budget-refund", input.campaignId]),
    campaignId: input.campaignId,
    reason: "unspent campaign budget returned",
  });

  // Zero the budget so a re-activated campaign cannot spend refunded credits.
  await tx.campaign.update({
    where: { id: input.campaignId },
    data: { budgetCredits: input.spentCredits },
  });

  logger.info("refunded unspent campaign budget", { campaignId: input.campaignId, remaining });
  return remaining;
}

/**
 * Ends a campaign and refunds whatever is left of its budget, atomically.
 * Idempotent: ending an already-ended campaign refunds nothing a second time,
 * because the refund carries a per-campaign idempotency key.
 */
export async function endCampaignWithRefund(input: { campaignId: string; creatorId: string }): Promise<{ refunded: number }> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{
      id: string;
      creatorId: string | null;
      status: "DRAFT" | "ACTIVE" | "PAUSED" | "ENDED";
      budgetCredits: number;
      spentCredits: number;
    }>>`
      SELECT "id", "creatorId", "status", "budgetCredits", "spentCredits"
      FROM "Campaign"
      WHERE "id" = ${input.campaignId} AND "creatorId" = ${input.creatorId}
      FOR UPDATE
    `;
    const campaign = rows[0];
    if (!campaign || !campaign.creatorId) throw new NotFoundError("این کمپین پیدا نشد.");

    await tx.campaign.update({ where: { id: campaign.id }, data: { status: "ENDED" } });

    const refunded = await refundUnspentBudget(tx, {
      creatorId: campaign.creatorId,
      campaignId: campaign.id,
      budgetCredits: campaign.budgetCredits,
      spentCredits: campaign.spentCredits,
    });

    return { refunded };
  });
}

/**
 * How much exposure a given budget buys, for the studio UI.
 * Purely informational: the authoritative accounting is the atomic conditional
 * UPDATE in the completion path.
 */
export function estimateSupports(
  budgetCredits: number,
  rewardCredits: number,
  tasks: { required: boolean; rewardCredits: number }[] = []
): number | null {
  if (budgetCredits <= 0) return null;
  const settlementCost = campaignSettlementCost({ rewardCredits, tasks });
  if (settlementCost <= 0) return null;
  return Math.floor(budgetCredits / settlementCost);
}

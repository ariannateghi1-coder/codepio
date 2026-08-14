import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { BusinessRuleError, NotFoundError } from "../errors";
import { ledgerKey, recordCredit } from "./ledger";
import { logger } from "../logger";
import { campaignSettlementCost } from "./campaign-eligibility";

/**
 * Campaign budget funding — the PAYING HALF of the credit transfer.
 *
 * Credits are a closed, zero-sum economy (see the CREDIT CONSERVATION note in
 * src/lib/gamification.ts). A support does not mint a reward; it moves a fixed
 * amount from a creator's funded budget to a supporter:
 *
 *   creator balance → campaign budget → supporter balance
 *
 * A budget is therefore an escrow, not a fee: the creator's credits leave their
 * balance when the budget is funded, sit in the campaign, and are handed to
 * supporters one transfer at a time as supports complete. Anything unspent comes
 * back when the campaign ends. Nothing evaporates and nothing appears.
 *
 * Rules encoded here:
 *  • Funding a budget DEBITS the creator through the ledger (CAMPAIGN_BUDGET_SPEND).
 *    No `credits -= x` anywhere.
 *  • The debit and the campaign write happen in one transaction, so a campaign can
 *    never exist with an unfunded budget, and credits can never be taken without a
 *    campaign to show for it.
 *  • Raising a budget debits only the delta, and the debit must have actually been
 *    applied before the new budget is written — see assertApplied.
 *  • Lowering is refused below what is already spent (the remaining budget would
 *    read negative).
 *  • Ending a campaign REFUNDS the unspent remainder. A creator who over-funded is
 *    not punished for stopping early.
 *  • Every campaign has a positive, fully funded budget. Zero never means
 *    unlimited; privileged/system campaigns require a separate explicit model.
 */

type Tx = Prisma.TransactionClient;

/**
 * Moves credits from the creator's balance into a campaign budget. Throws if the
 * creator is short.
 *
 * `idempotencyKey` must identify this specific funding event. It is a required
 * parameter rather than something derived from `amount`, because a key built from
 * the amount alone repeats: fund 100 → raise to 150 (delta 50) → lower to 100 →
 * raise to 150 again produces the same "delta 50" key twice, the ledger treats the
 * second one as an already-applied replay, and the budget would rise without the
 * creator being charged. The caller therefore keys on the transition, not the size.
 */
export async function debitBudget(
  tx: Tx,
  input: { creatorId: string; campaignId: string; amount: number; note: string; idempotencyKey: string }
): Promise<void> {
  if (input.amount <= 0) return;

  const result = await recordCredit(tx, {
    userId: input.creatorId,
    type: "CAMPAIGN_BUDGET_SPEND",
    amount: -input.amount,
    idempotencyKey: input.idempotencyKey,
    campaignId: input.campaignId,
    reason: input.note,
  });

  // recordCredit returns applied:false for a replayed key. For a debit that means
  // "the money was NOT taken this time", so the caller must not proceed to grant
  // the budget it pays for. Failing loudly is the only safe reading: silently
  // treating it as success is how an unfunded budget appears.
  assertApplied(result, input.campaignId);
}

/** Guard for the invariant "budget granted ⇒ credits actually debited". */
function assertApplied(result: { applied: boolean }, campaignId: string): void {
  if (result.applied) return;
  logger.error("campaign budget debit was a replay; refusing to grant budget", { campaignId });
  throw new BusinessRuleError(
    "این تغییر بودجه قبلاً ثبت شده است. صفحه را تازه کنید و در صورت نیاز دوباره تلاش کنید.",
    { rule: "BUDGET_DEBIT_REPLAYED" }
  );
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
      FROM public."Campaign"
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
 * How many supports a given budget can still pay for, for the studio UI.
 * Purely informational: the authoritative accounting is the atomic conditional
 * UPDATE in the completion path. Every support costs the same fixed transfer, so
 * this is a plain division with no campaign-specific pricing.
 */
export function estimateSupports(remainingBudgetCredits: number): number | null {
  if (remainingBudgetCredits <= 0) return null;
  const settlementCost = campaignSettlementCost();
  if (settlementCost <= 0) return null;
  return Math.floor(remainingBudgetCredits / settlementCost);
}

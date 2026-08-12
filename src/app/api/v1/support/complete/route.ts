import { parseBody } from "@/lib/api";
import { active } from "@/lib/handler";
import { supportCompleteSchema } from "@/lib/validators";
import { completeSupportSession } from "@/lib/services/support";

/**
 * Completes a support session and settles the reward.
 *
 * All the hard guarantees live in the service: eligibility re-check, required
 * tasks satisfied, risk scoring, atomic budget/capacity enforcement, ledger-based
 * payout with idempotency keys, and a Serializable transaction with bounded retry.
 * Replaying this endpoint for an already-completed session returns the same result
 * instead of paying twice.
 */
export const POST = active(
  "support.complete",
  async ({ req, user }) => {
    const { sessionId } = await parseBody(req, supportCompleteSchema);
    return completeSupportSession({ sessionId, supporterId: user.id });
  },
  { rateLimit: "supportComplete" }
);

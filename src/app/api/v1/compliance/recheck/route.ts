import { active } from "@/lib/handler";
import { complianceSnapshot, verifyCompliance } from "@/lib/services/subscription-compliance";

/**
 * «بررسی مجدد» — the user asks YouTube to re-check their subscriptions.
 *
 * THE ONLY USER-FACING ENDPOINT THAT SPENDS QUOTA, and it does so once per press:
 * one `subscriptions.list` call covers every outstanding obligation the user has,
 * because the API accepts a comma-separated channel list for a flat 1 unit.
 *
 * Protected by the `complianceRecheck` policy (6 per hour). The limit exists
 * because this is a user-triggered path to a metered external resource — without
 * it, holding the button down would be a quota-exhaustion vector against the whole
 * platform. Six is enough for a genuine "I just re-subscribed, check again"
 * without being enough to matter.
 *
 * NOTHING IS TRUSTED FROM THE CLIENT. There is no request body at all: no
 * `subscribed`, no `verified`, no `supportId`. The user is taken from the session
 * and every verdict comes from YouTube, so the only thing this endpoint accepts is
 * the fact that a button was pressed.
 *
 * A RESTORE PAYS NOTHING. `verifyCompliance` lifts the gate and writes the
 * compliance row; it never creates a Support, a ledger entry, XP or a reward. So
 * pressing this repeatedly cannot manufacture a duplicate reward — there is no
 * payout code reachable from here.
 *
 * The response distinguishes the three outcomes the UI must render differently:
 * restored, still-not-subscribed, and could-not-check. The last one is why
 * `apiOutcome` is returned separately from `compliant` — a user must never be told
 * they unsubscribed when the truth is that Google did not answer.
 */
export const POST = active(
  "compliance.recheck",
  async ({ user }) => {
    const result = await verifyCompliance(user.id, { force: true, reason: "USER_RECHECK" });
    // Returned alongside the outcome so the client has the full, authoritative
    // state after the action and does not need a second request to refresh.
    const snapshot = await complianceSnapshot(user.id);

    return {
      compliant: result.compliant,
      /** VERIFIED | TEMPORARY_ERROR | REAUTH_REQUIRED | UNAVAILABLE | null */
      apiOutcome: result.apiOutcome,
      /** False when a fresh cached verdict was reused instead of calling YouTube. */
      consultedApi: result.consultedApi,
      checked: result.checked,
      restored: result.restored,
      newViolations: result.newViolations,
      message: result.message,
      snapshot,
    };
  },
  { rateLimit: "complianceRecheck" }
);

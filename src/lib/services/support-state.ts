import type { SupportSessionState, RewardState } from "@prisma/client";

/**
 * Support session state machine.
 *
 * Two orthogonal axes, deliberately kept separate instead of flattened into one
 * enum:
 *
 *   state       — where the supporter is in the flow (progress)
 *   rewardState — what happened to the money (settlement)
 *
 * The spec listed REWARD_PENDING / REWARDED / REVERSED alongside the progress
 * states. Folding them into a single enum would give a completed-but-held session
 * two possible "true" states and force every query to know which one wins, so
 * settlement lives in `rewardState` and this module guards both transitions.
 *
 * Illegal transitions are rejected rather than silently applied: a REVERSED
 * reward can never go back to CONFIRMED, and a FAILED session can never become
 * COMPLETED.
 */

/** Progress transitions. Empty array = terminal. */
const STATE_TRANSITIONS: Record<SupportSessionState, readonly SupportSessionState[]> = {
  STARTED: ["VIDEO_OPENED", "WATCHING", "FAILED", "EXPIRED", "ABANDONED"],
  VIDEO_OPENED: ["WATCHING", "FAILED", "EXPIRED", "ABANDONED"],
  // Watching can regress to VIDEO_OPENED only in the sense of staying put; the
  // threshold is the one forward gate.
  WATCHING: ["WATCHING", "WATCH_THRESHOLD_REACHED", "FAILED", "EXPIRED", "ABANDONED"],
  // The threshold is sticky: additional heartbeats must not drop it back to
  // WATCHING, which would let a user lose credited progress by pausing.
  WATCH_THRESHOLD_REACHED: ["WATCH_THRESHOLD_REACHED", "VERIFYING", "FAILED", "EXPIRED", "ABANDONED"],
  VERIFYING: ["VERIFYING", "WATCH_THRESHOLD_REACHED", "COMPLETED", "FAILED", "EXPIRED", "ABANDONED"],
  COMPLETED: [],
  FAILED: [],
  EXPIRED: [],
  ABANDONED: [],
};

/** Settlement transitions. */
const REWARD_TRANSITIONS: Record<RewardState, readonly RewardState[]> = {
  NONE: ["PENDING_REVIEW", "CONFIRMED", "DENIED"],
  // A held reward is later approved or refused by a moderator.
  PENDING_REVIEW: ["CONFIRMED", "DENIED"],
  // A paid reward can only be clawed back.
  CONFIRMED: ["REVERSED"],
  DENIED: [],
  // Terminal on purpose: re-confirming a reversal would re-pay a clawed-back
  // reward, which is the exact bug the ledger exists to prevent.
  REVERSED: [],
};

export const TERMINAL_STATES: readonly SupportSessionState[] = ["COMPLETED", "FAILED", "EXPIRED", "ABANDONED"];

/** States in which a session is still live and may accept heartbeats. */
export const OPEN_STATES: readonly SupportSessionState[] = [
  "STARTED",
  "VIDEO_OPENED",
  "WATCHING",
  "WATCH_THRESHOLD_REACHED",
  "VERIFYING",
];

export function isTerminal(state: SupportSessionState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function isOpen(state: SupportSessionState): boolean {
  return OPEN_STATES.includes(state);
}

export function canTransition(from: SupportSessionState, to: SupportSessionState): boolean {
  return STATE_TRANSITIONS[from].includes(to);
}

export function canTransitionReward(from: RewardState, to: RewardState): boolean {
  return REWARD_TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly kind: "state" | "reward",
    readonly from: string,
    readonly to: string
  ) {
    super(`Illegal ${kind} transition: ${from} → ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function assertTransition(from: SupportSessionState, to: SupportSessionState): void {
  if (from === to) return;
  if (!canTransition(from, to)) throw new IllegalTransitionError("state", from, to);
}

export function assertRewardTransition(from: RewardState, to: RewardState): void {
  if (from === to) return;
  if (!canTransitionReward(from, to)) throw new IllegalTransitionError("reward", from, to);
}

/**
 * Returns the target state, or the current one when the transition is not legal.
 *
 * Used on the heartbeat path, where a stale request arriving after completion
 * should be a no-op rather than an error the user sees.
 */
export function nextState(from: SupportSessionState, desired: SupportSessionState): SupportSessionState {
  return canTransition(from, desired) ? desired : from;
}

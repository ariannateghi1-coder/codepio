import { describe, expect, it } from "vitest";
import {
  OPEN_STATES,
  TERMINAL_STATES,
  assertRewardTransition,
  assertTransition,
  canTransition,
  canTransitionReward,
  IllegalTransitionError,
  isOpen,
  isTerminal,
  nextState,
} from "@/lib/services/support-state";

/**
 * Support state machine. The point of these tests is that illegal transitions are
 * REJECTED rather than quietly applied — particularly the ones that would re-pay
 * or un-fail a settled session.
 */

describe("progress transitions", () => {
  it("walks the happy path", () => {
    expect(canTransition("STARTED", "VIDEO_OPENED")).toBe(true);
    expect(canTransition("VIDEO_OPENED", "WATCHING")).toBe(true);
    expect(canTransition("WATCHING", "WATCH_THRESHOLD_REACHED")).toBe(true);
    expect(canTransition("WATCH_THRESHOLD_REACHED", "VERIFYING")).toBe(true);
    expect(canTransition("VERIFYING", "COMPLETED")).toBe(true);
  });

  it("refuses to resurrect a terminal session", () => {
    for (const terminal of TERMINAL_STATES) {
      expect(canTransition(terminal, "WATCHING")).toBe(false);
      expect(canTransition(terminal, "COMPLETED")).toBe(false);
      expect(canTransition(terminal, "VERIFYING")).toBe(false);
    }
  });

  it("refuses to skip the watch threshold", () => {
    expect(canTransition("STARTED", "COMPLETED")).toBe(false);
    expect(canTransition("WATCHING", "COMPLETED")).toBe(false);
    expect(canTransition("VIDEO_OPENED", "VERIFYING")).toBe(false);
  });

  it("keeps the threshold sticky, so a later heartbeat cannot un-reach it", () => {
    // Pausing after crossing 90% must not drop the user back to WATCHING.
    expect(canTransition("WATCH_THRESHOLD_REACHED", "WATCHING")).toBe(false);
    expect(nextState("WATCH_THRESHOLD_REACHED", "WATCHING")).toBe("WATCH_THRESHOLD_REACHED");
  });

  it("does not let a late heartbeat pull a VERIFYING session back to WATCHING", () => {
    expect(nextState("VERIFYING", "WATCHING")).toBe("VERIFYING");
  });

  it("allows VERIFYING back to the threshold, so a failed check can be retried", () => {
    expect(canTransition("VERIFYING", "WATCH_THRESHOLD_REACHED")).toBe(true);
  });

  it("allows abandonment from every open state", () => {
    for (const state of OPEN_STATES) {
      expect(canTransition(state, "ABANDONED")).toBe(true);
      expect(canTransition(state, "EXPIRED")).toBe(true);
      expect(canTransition(state, "FAILED")).toBe(true);
    }
  });
});

describe("assertTransition", () => {
  it("treats a self-transition as a no-op", () => {
    expect(() => assertTransition("WATCHING", "WATCHING")).not.toThrow();
    expect(() => assertTransition("COMPLETED", "COMPLETED")).not.toThrow();
  });

  it("throws IllegalTransitionError with both ends named", () => {
    try {
      assertTransition("FAILED", "COMPLETED");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(IllegalTransitionError);
      expect((error as IllegalTransitionError).from).toBe("FAILED");
      expect((error as IllegalTransitionError).to).toBe("COMPLETED");
      expect((error as IllegalTransitionError).kind).toBe("state");
    }
  });
});

describe("reward transitions", () => {
  it("settles from NONE", () => {
    expect(canTransitionReward("NONE", "CONFIRMED")).toBe(true);
    expect(canTransitionReward("NONE", "PENDING_REVIEW")).toBe(true);
    expect(canTransitionReward("NONE", "DENIED")).toBe(true);
  });

  it("lets a held reward be approved or refused", () => {
    expect(canTransitionReward("PENDING_REVIEW", "CONFIRMED")).toBe(true);
    expect(canTransitionReward("PENDING_REVIEW", "DENIED")).toBe(true);
  });

  it("only allows a paid reward to be clawed back", () => {
    expect(canTransitionReward("CONFIRMED", "REVERSED")).toBe(true);
    expect(canTransitionReward("CONFIRMED", "PENDING_REVIEW")).toBe(false);
    expect(canTransitionReward("CONFIRMED", "DENIED")).toBe(false);
  });

  it("REFUSES to re-confirm a reversed reward", () => {
    // This is the transition that would re-pay a clawed-back reward.
    expect(canTransitionReward("REVERSED", "CONFIRMED")).toBe(false);
    expect(() => assertRewardTransition("REVERSED", "CONFIRMED")).toThrow(IllegalTransitionError);
  });

  it("treats DENIED as terminal", () => {
    expect(canTransitionReward("DENIED", "CONFIRMED")).toBe(false);
    expect(canTransitionReward("DENIED", "PENDING_REVIEW")).toBe(false);
  });

  it("marks the error kind as reward", () => {
    try {
      assertRewardTransition("REVERSED", "CONFIRMED");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as IllegalTransitionError).kind).toBe("reward");
    }
  });
});

describe("state predicates", () => {
  it("classifies terminal and open states without overlap", () => {
    for (const state of TERMINAL_STATES) {
      expect(isTerminal(state)).toBe(true);
      expect(isOpen(state)).toBe(false);
    }
    for (const state of OPEN_STATES) {
      expect(isOpen(state)).toBe(true);
      expect(isTerminal(state)).toBe(false);
    }
  });

  it("covers every state exactly once across the two sets", () => {
    expect(TERMINAL_STATES.length + OPEN_STATES.length).toBe(9);
  });
});

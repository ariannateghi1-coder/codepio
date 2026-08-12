import { describe, expect, it } from "vitest";
import { RETENTION_DAYS, retentionPolicy } from "@/lib/services/retention";

/**
 * Retention POLICY tests — pure, no database.
 *
 * These assert the rules themselves: what is old enough, and what is protected
 * regardless of age. The SQL that implements the same rules is covered by the
 * database-backed suite in retention-db.test.ts, which needs TEST_DATABASE_URL.
 *
 * Every "must not be deleted" case here corresponds to a specific way an earlier
 * design could have destroyed live data.
 */

const DAY = 86_400_000;
const now = new Date("2026-08-20T12:00:00.000Z");
const ago = (days: number) => new Date(now.getTime() - days * DAY);

describe("retention windows", () => {
  it("keeps the documented policy", () => {
    // Pinned so a casual edit to a window is a failing test, not a silent change
    // in how long user-visible history survives.
    expect(RETENTION_DAYS.notification).toBe(3);
    expect(RETENTION_DAYS.activity).toBe(7);
    expect(RETENTION_DAYS.auditLog).toBe(7);
    expect(RETENTION_DAYS.abuseSignal).toBe(7);
    expect(RETENTION_DAYS.xpLedger).toBe(7);
  });
});

describe("Notification — 3 days", () => {
  it("keeps a notification younger than 3 days", () => {
    expect(retentionPolicy.isExpired("notification", ago(0), now)).toBe(false);
    expect(retentionPolicy.isExpired("notification", ago(1), now)).toBe(false);
    expect(retentionPolicy.isExpired("notification", ago(2.9), now)).toBe(false);
  });

  it("deletes a notification older than 3 days", () => {
    expect(retentionPolicy.isExpired("notification", ago(3.1), now)).toBe(true);
    expect(retentionPolicy.isExpired("notification", ago(30), now)).toBe(true);
  });

  it("treats the boundary as not-yet-expired", () => {
    // Exactly at the cutoff the row is kept: the predicate is `<`, so a row can
    // never be deleted in the same instant it becomes eligible.
    expect(retentionPolicy.isExpired("notification", ago(3), now)).toBe(false);
  });
});

describe("Activity — 7 days", () => {
  it("keeps activity younger than 7 days", () => {
    expect(retentionPolicy.isExpired("activity", ago(6.9), now)).toBe(false);
  });

  it("deletes activity older than 7 days", () => {
    expect(retentionPolicy.isExpired("activity", ago(7.1), now)).toBe(true);
  });
});

describe("AuditLog — 7 days", () => {
  it("keeps an audit entry younger than 7 days", () => {
    expect(retentionPolicy.isExpired("auditLog", ago(6.9), now)).toBe(false);
  });

  it("deletes an audit entry older than 7 days", () => {
    expect(retentionPolicy.isExpired("auditLog", ago(7.1), now)).toBe(true);
  });
});

describe("XpLedger — 7 days", () => {
  it("keeps an XP entry younger than 7 days", () => {
    expect(retentionPolicy.isExpired("xpLedger", ago(6.9), now)).toBe(false);
  });

  it("deletes an XP entry older than 7 days", () => {
    expect(retentionPolicy.isExpired("xpLedger", ago(7.1), now)).toBe(true);
  });
});

describe("AbuseSignal — 7 days, but never while a decision is open", () => {
  const settled = { state: "COMPLETED", rewardState: "CONFIRMED" };

  it("keeps a signal younger than 7 days even when its session is settled", () => {
    expect(retentionPolicy.canDeleteAbuseSignal({ createdAt: ago(3), session: settled }, now)).toBe(false);
  });

  it("deletes an old signal whose session is settled", () => {
    expect(retentionPolicy.canDeleteAbuseSignal({ createdAt: ago(8), session: settled }, now)).toBe(true);
  });

  it("deletes an old account-level signal that has no session", () => {
    expect(retentionPolicy.canDeleteAbuseSignal({ createdAt: ago(8), session: null }, now)).toBe(true);
  });

  it("KEEPS an old signal whose session is still open", () => {
    // The decision has not been made yet; this evidence is an input to it.
    for (const state of ["STARTED", "WATCHING", "WATCH_THRESHOLD_REACHED", "VERIFYING"]) {
      expect(
        retentionPolicy.canDeleteAbuseSignal({ createdAt: ago(90), session: { state, rewardState: "NONE" } }, now)
      ).toBe(false);
    }
  });

  it("KEEPS an old signal whose reward is held for moderator review", () => {
    // A moderator opening this queue item needs exactly these signals to decide.
    expect(
      retentionPolicy.canDeleteAbuseSignal(
        { createdAt: ago(365), session: { state: "COMPLETED", rewardState: "PENDING_REVIEW" } },
        now
      )
    ).toBe(false);
  });

  it("deletes it once the moderator has resolved the review", () => {
    expect(
      retentionPolicy.canDeleteAbuseSignal(
        { createdAt: ago(365), session: { state: "COMPLETED", rewardState: "DENIED" } },
        now
      )
    ).toBe(true);
  });
});

describe("session execution state — WatchSession / SupportVerification / SupportTask", () => {
  const settledLongAgo = {
    state: "COMPLETED",
    rewardState: "CONFIRMED",
    updatedAt: ago(10),
    supportId: "sup_1",
  };

  it("deletes execution state for a settled, finalised support", () => {
    expect(retentionPolicy.canDeleteSessionExecutionState(settledLongAgo, now)).toBe(true);
  });

  it("KEEPS execution state while the session is still active", () => {
    for (const state of ["STARTED", "VIDEO_OPENED", "WATCHING", "WATCH_THRESHOLD_REACHED", "VERIFYING"]) {
      expect(
        retentionPolicy.canDeleteSessionExecutionState(
          { state, rewardState: "NONE", updatedAt: ago(365), supportId: null },
          now
        )
      ).toBe(false);
    }
  });

  it("KEEPS execution state while a reward is held for review", () => {
    // The moderator needs the watch figures and per-task results to judge it.
    expect(
      retentionPolicy.canDeleteSessionExecutionState(
        { ...settledLongAgo, rewardState: "PENDING_REVIEW" },
        now
      )
    ).toBe(false);
  });

  it("KEEPS execution state inside the grace period", () => {
    expect(
      retentionPolicy.canDeleteSessionExecutionState({ ...settledLongAgo, updatedAt: ago(1) }, now)
    ).toBe(false);
    expect(
      retentionPolicy.canDeleteSessionExecutionState(
        { ...settledLongAgo, updatedAt: ago(RETENTION_DAYS.sessionExecutionState + 0.1) },
        now
      )
    ).toBe(true);
  });

  it("KEEPS execution state for a COMPLETED session with no Support row", () => {
    // Settlement did not finish, so this is the only surviving evidence of what
    // happened — the one case where age alone must not authorise deletion.
    expect(
      retentionPolicy.canDeleteSessionExecutionState({ ...settledLongAgo, supportId: null }, now)
    ).toBe(false);
  });

  it("deletes execution state for terminal-but-unsuccessful sessions", () => {
    // FAILED / EXPIRED / ABANDONED never produce a Support row, so requiring one
    // would keep their execution state forever.
    for (const state of ["FAILED", "EXPIRED", "ABANDONED"]) {
      expect(
        retentionPolicy.canDeleteSessionExecutionState(
          { state, rewardState: "NONE", updatedAt: ago(10), supportId: null },
          now
        )
      ).toBe(true);
    }
  });

  it("keeps a DENIED reward's state deletable — the decision was made", () => {
    expect(
      retentionPolicy.canDeleteSessionExecutionState(
        { state: "FAILED", rewardState: "DENIED", updatedAt: ago(10), supportId: null },
        now
      )
    ).toBe(true);
  });
});

describe("what retention must never touch", () => {
  it("has no policy entry for permanent tables", () => {
    // A window appearing here for any of these would be the bug. Support,
    // CreditLedger, User, Campaign and the daily rollups are permanent by design:
    // Support is the outcome record, CreditLedger is the accounting record, and
    // UserDailyRollup is what makes the 7-day windows above safe at all.
    const windows = Object.keys(RETENTION_DAYS);
    for (const table of [
      "support",
      "creditLedger",
      "user",
      "campaign",
      "userDailyRollup",
      "reputationEvent",
      "supportSession",
      "leaderboardSnapshot",
      "userBadge",
    ]) {
      expect(windows).not.toContain(table);
    }
  });
});

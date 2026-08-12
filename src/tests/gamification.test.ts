import { describe, expect, it } from "vitest";
import {
  BADGE_DEFINITIONS,
  BADGE_REQUIREMENTS,
  PAIR_DIMINISHING_MULTIPLIERS,
  RANK_TIERS,
  REPUTATION,
  REWARDS,
  TASK_REWARDS,
  calculateLevel,
  calculateRankTier,
  nextLevelProgress,
  pairRewardMultiplier,
  rankTierLabel,
} from "@/lib/gamification";
import { badgesToAward, type UserMetrics } from "@/lib/services/badges";
import { nextStreak } from "@/lib/services/streak";
import { assessGraph, assessSessionEvidence, scoreFromReasons } from "@/lib/services/anti-abuse";

describe("levels", () => {
  it("derives the level from XP thresholds", () => {
    expect(calculateLevel(0)).toBe(1);
    expect(calculateLevel(99)).toBe(1);
    expect(calculateLevel(100)).toBe(2);
    expect(calculateLevel(999)).toBe(4);
    expect(calculateLevel(12_000)).toBe(10);
    expect(calculateLevel(999_999)).toBe(10);
  });

  it("reports progress toward the next level", () => {
    const start = nextLevelProgress(100);
    expect(start.current).toBe(2);
    expect(start.next).toBe(3);
    expect(start.progress).toBe(0);

    const mid = nextLevelProgress(175);
    expect(mid.progress).toBe(50);

    const capped = nextLevelProgress(50_000);
    expect(capped.next).toBeNull();
    expect(capped.progress).toBe(100);
  });
});

describe("rank tiers", () => {
  it("requires both reputation and support volume", () => {
    // High reputation alone does not promote you.
    expect(calculateRankTier(1000, 0)).toBe("BRONZE");
    expect(calculateRankTier(150, 5)).toBe("SILVER");
    expect(calculateRankTier(260, 20)).toBe("GOLD");
    expect(calculateRankTier(800, 250)).toBe("ELITE");
  });

  it("has a label for every tier", () => {
    for (const tier of RANK_TIERS) {
      expect(rankTierLabel(tier.tier)).toBe(tier.label);
    }
  });

  it("defines tiers in ascending order", () => {
    for (let i = 1; i < RANK_TIERS.length; i += 1) {
      expect(RANK_TIERS[i].minReputation).toBeGreaterThanOrEqual(RANK_TIERS[i - 1].minReputation);
      expect(RANK_TIERS[i].minSupports).toBeGreaterThanOrEqual(RANK_TIERS[i - 1].minSupports);
    }
  });
});

describe("pair diminishing returns", () => {
  it("pays full value the first time and less on repeats", () => {
    expect(pairRewardMultiplier(0)).toBe(1);
    expect(pairRewardMultiplier(1)).toBeLessThan(1);
    expect(pairRewardMultiplier(2)).toBeLessThan(pairRewardMultiplier(1));
  });

  it("never drops below the final multiplier, and never goes negative", () => {
    const last = PAIR_DIMINISHING_MULTIPLIERS[PAIR_DIMINISHING_MULTIPLIERS.length - 1];
    expect(pairRewardMultiplier(50)).toBe(last);
    expect(last).toBeGreaterThan(0);
  });

  it("makes farming one creator unprofitable relative to spreading out", () => {
    const farmSamePair = [0, 1, 2, 3, 4].reduce((sum, n) => sum + pairRewardMultiplier(n), 0);
    const fiveDistinctPairs = 5 * pairRewardMultiplier(0);
    expect(farmSamePair).toBeLessThan(fiveDistinctPairs);
  });
});

describe("reward configuration", () => {
  it("keeps every reward non-negative", () => {
    for (const reward of Object.values(TASK_REWARDS)) {
      expect(reward.credits).toBeGreaterThanOrEqual(0);
      expect(reward.xp).toBeGreaterThanOrEqual(0);
    }
    expect(REWARDS.SUPPORT_COMPLETED.credits).toBeGreaterThan(0);
    expect(REWARDS.SUPPORT_RECEIVED.credits).toBeGreaterThan(0);
  });

  it("penalises a reversal more than a completion earns", () => {
    expect(Math.abs(REPUTATION.SUPPORT_REVERSED)).toBeGreaterThan(REPUTATION.SUPPORT_VERIFIED);
  });

  it("defines requirements for every badge, and no orphans", () => {
    const codes = BADGE_DEFINITIONS.map((b) => b.code).sort();
    expect(Object.keys(BADGE_REQUIREMENTS).sort()).toEqual(codes);
  });
});

describe("badgesToAward", () => {
  const metrics: UserMetrics = {
    supportsCompleted: 0,
    supportsReceived: 0,
    mutualSupports: 0,
    streakDays: 0,
    reputation: REPUTATION.START,
    channelVerified: false,
    completionRate: 1,
  };

  it("awards the first-support badge at exactly one support", () => {
    expect(badgesToAward({ ...metrics, supportsCompleted: 1 }, new Set())).toContain("FIRST_SUPPORT");
    expect(badgesToAward(metrics, new Set())).not.toContain("FIRST_SUPPORT");
  });

  it("never re-awards a badge the user already holds", () => {
    const owned = new Set(["FIRST_SUPPORT"]);
    expect(badgesToAward({ ...metrics, supportsCompleted: 1 }, owned)).not.toContain("FIRST_SUPPORT");
  });

  it("awards all crossed thresholds at once", () => {
    const awarded = badgesToAward({ ...metrics, supportsCompleted: 60 }, new Set());
    expect(awarded).toContain("FIRST_SUPPORT");
    expect(awarded).toContain("SUPPORTS_10");
    expect(awarded).toContain("SUPPORTS_50");
    expect(awarded).not.toContain("SUPPORTS_100");
  });

  it("gates the quality badge on completion rate, not volume alone", () => {
    const highReputationLowQuality = { ...metrics, reputation: 400, completionRate: 0.4 };
    expect(badgesToAward(highReputationLowQuality, new Set())).not.toContain("TRUSTED_SUPPORTER");

    const highReputationGoodQuality = { ...metrics, reputation: 400, completionRate: 0.95 };
    expect(badgesToAward(highReputationGoodQuality, new Set())).toContain("TRUSTED_SUPPORTER");
  });

  it("awards the channel badge only when verified", () => {
    expect(badgesToAward({ ...metrics, channelVerified: true }, new Set())).toContain("VERIFIED_CREATOR");
    expect(badgesToAward(metrics, new Set())).not.toContain("VERIFIED_CREATOR");
  });
});

describe("streaks", () => {
  const day = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

  it("starts at one for a first activity", () => {
    expect(nextStreak(null, 0, day("2026-08-10"))).toEqual({ streak: 1, changed: true });
  });

  it("increments on a consecutive day", () => {
    expect(nextStreak(day("2026-08-09"), 3, day("2026-08-10"))).toEqual({ streak: 4, changed: true });
  });

  it("does not double-count the same day", () => {
    expect(nextStreak(day("2026-08-10"), 3, day("2026-08-10"))).toEqual({ streak: 3, changed: false });
  });

  it("resets after a missed day", () => {
    expect(nextStreak(day("2026-08-07"), 9, day("2026-08-10"))).toEqual({ streak: 1, changed: true });
  });
});

describe("anti-abuse — session evidence", () => {
  it("flags watching more seconds than wall-clock time allows", () => {
    const reasons = assessSessionEvidence({
      elapsedSeconds: 30,
      watchedSeconds: 600,
      requiredSeconds: 540,
      seekCount: 0,
      heartbeats: 3,
      impossibleProgressEvents: 0,
    });
    expect(reasons.some((r) => r.type === "IMPOSSIBLE_WATCH_SPEED")).toBe(true);
    expect(scoreFromReasons(reasons).decision).toBe("DENY");
  });

  it("flags repeated replayed heartbeats", () => {
    const reasons = assessSessionEvidence({
      elapsedSeconds: 620,
      watchedSeconds: 600,
      requiredSeconds: 540,
      seekCount: 0,
      heartbeats: 60,
      impossibleProgressEvents: 0,
      rejectedBeats: 6,
    });
    expect(reasons.some((r) => r.type === "HEARTBEAT_REPLAY")).toBe(true);
  });

  it("tolerates a couple of rejected beats as network jitter", () => {
    const reasons = assessSessionEvidence({
      elapsedSeconds: 620,
      watchedSeconds: 600,
      requiredSeconds: 540,
      seekCount: 0,
      heartbeats: 60,
      impossibleProgressEvents: 0,
      rejectedBeats: 2,
    });
    expect(reasons.some((r) => r.type === "HEARTBEAT_REPLAY")).toBe(false);
  });

  it("flags a watch that happened mostly in a hidden tab, without denying it", () => {
    const reasons = assessSessionEvidence({
      elapsedSeconds: 620,
      watchedSeconds: 600,
      requiredSeconds: 540,
      seekCount: 0,
      heartbeats: 60,
      impossibleProgressEvents: 0,
      hiddenSeconds: 500,
    });
    expect(reasons.some((r) => r.type === "BACKGROUND_WATCH")).toBe(true);
    // Advisory only: a client can under-report this, so it must not deny alone.
    expect(scoreFromReasons(reasons).decision).not.toBe("DENY");
  });

  it("does not flag brief backgrounding", () => {
    const reasons = assessSessionEvidence({
      elapsedSeconds: 620,
      watchedSeconds: 600,
      requiredSeconds: 540,
      seekCount: 0,
      heartbeats: 60,
      impossibleProgressEvents: 0,
      hiddenSeconds: 20,
    });
    expect(reasons.some((r) => r.type === "BACKGROUND_WATCH")).toBe(false);
  });

  it("passes a genuine, unremarkable watch", () => {
    const reasons = assessSessionEvidence({
      elapsedSeconds: 620,
      watchedSeconds: 600,
      requiredSeconds: 540,
      seekCount: 1,
      heartbeats: 60,
      impossibleProgressEvents: 0,
    });
    expect(reasons).toHaveLength(0);
    expect(scoreFromReasons(reasons).decision).toBe("ALLOW");
  });

  it("flags heavy scrubbing that barely clears the threshold", () => {
    const reasons = assessSessionEvidence({
      elapsedSeconds: 600,
      watchedSeconds: 545,
      requiredSeconds: 540,
      seekCount: 15,
      heartbeats: 55,
      impossibleProgressEvents: 0,
    });
    expect(reasons.some((r) => r.type === "SEEK_JUMP_ABUSE")).toBe(true);
  });

  it("flags a suspiciously low heartbeat count for the credited time", () => {
    const reasons = assessSessionEvidence({
      elapsedSeconds: 620,
      watchedSeconds: 600,
      requiredSeconds: 540,
      seekCount: 0,
      heartbeats: 3,
      impossibleProgressEvents: 0,
    });
    expect(reasons.some((r) => r.type === "HEARTBEAT_ANOMALY")).toBe(true);
  });

  it("escalates client tampering with the number of events", () => {
    const one = assessSessionEvidence({
      elapsedSeconds: 620, watchedSeconds: 600, requiredSeconds: 540, seekCount: 0, heartbeats: 60, impossibleProgressEvents: 1,
    });
    const many = assessSessionEvidence({
      elapsedSeconds: 620, watchedSeconds: 600, requiredSeconds: 540, seekCount: 0, heartbeats: 60, impossibleProgressEvents: 5,
    });
    const severityOf = (rs: ReturnType<typeof assessSessionEvidence>) =>
      rs.find((r) => r.type === "CLIENT_TAMPERING")?.severity ?? 0;
    expect(severityOf(many)).toBeGreaterThan(severityOf(one));
  });
});

describe("anti-abuse — graph signals", () => {
  const base = {
    supporterId: "a",
    receiverId: "b",
    pairSupportCount: 0,
    reciprocalCount: 0,
    lastPairSupportAt: null,
    recentSupportCount: 1,
    distinctRecentCreators: 5,
    dailySupportCount: 5,
    supporterAccountAgeHours: 500,
    supporterReputation: 200,
    supporterReversals: 0,
    sharedIpWithReceiver: false,
    ringOverlap: 0,
  };

  it("denies a self-support attempt outright", () => {
    const reasons = assessGraph({ ...base, receiverId: "a" });
    expect(reasons.some((r) => r.type === "SELF_SUPPORT_ATTEMPT")).toBe(true);
    expect(scoreFromReasons(reasons).decision).toBe("DENY");
  });

  it("detects a reciprocal ping-pong loop", () => {
    const reasons = assessGraph({ ...base, pairSupportCount: 4, reciprocalCount: 4 });
    expect(reasons.some((r) => r.type === "RECIPROCAL_LOOP")).toBe(true);
    expect(scoreFromReasons(reasons).decision).not.toBe("ALLOW");
  });

  it("flags high volume concentrated on very few creators", () => {
    const reasons = assessGraph({ ...base, dailySupportCount: 20, distinctRecentCreators: 2 });
    expect(reasons.some((r) => r.type === "PAIR_FARMING")).toBe(true);
  });

  it("flags burst velocity", () => {
    const reasons = assessGraph({ ...base, recentSupportCount: 12 });
    expect(reasons.some((r) => r.type === "SUPPORT_VELOCITY")).toBe(true);
  });

  it("treats a shared network as a signal, never as sufficient proof", () => {
    const assessment = scoreFromReasons(assessGraph({ ...base, sharedIpWithReceiver: true }));
    expect(assessment.score).toBeGreaterThan(0);
    expect(assessment.decision).not.toBe("DENY");
  });

  it("detects a closed farming ring that pair counters cannot see", () => {
    // A→B looks like a first-time support, but the group trades among itself.
    const reasons = assessGraph({ ...base, ringOverlap: 4 });
    expect(reasons.some((r) => r.type === "FARMING_RING")).toBe(true);
    expect(scoreFromReasons(reasons).decision).not.toBe("ALLOW");
  });

  it("does not treat a single shared connection as a ring", () => {
    expect(assessGraph({ ...base, ringOverlap: 1 }).some((r) => r.type === "FARMING_RING")).toBe(false);
  });

  it("flags a dense, concentrated multi-hop cluster with an explainable signal", () => {
    const reasons = assessGraph({
      ...base,
      clusterMemberCount: 5,
      clusterEdgeCount: 12,
      clusterConcentration: 0.9,
    });
    const signal = reasons.find((reason) => reason.type === "FARMING_RING");
    expect(signal?.note).toContain("dense support cluster");
    expect(scoreFromReasons(reasons).decision).not.toBe("DENY");
  });

  it("does not overblock a broad or weakly connected community", () => {
    expect(
      assessGraph({
        ...base,
        clusterMemberCount: 20,
        clusterEdgeCount: 15,
        clusterConcentration: 0.3,
      }).some((reason) => reason.type === "FARMING_RING")
    ).toBe(false);
  });

  it("leaves an ordinary first-time support untouched", () => {
    expect(assessGraph(base)).toHaveLength(0);
    expect(scoreFromReasons([]).decision).toBe("ALLOW");
  });

  it("caps the score at 100", () => {
    const reasons = assessGraph({
      ...base,
      receiverId: "a",
      pairSupportCount: 9,
      reciprocalCount: 9,
      recentSupportCount: 50,
      supporterReversals: 9,
      supporterReputation: 0,
      sharedIpWithReceiver: true,
    });
    expect(scoreFromReasons(reasons).score).toBeLessThanOrEqual(100);
  });
});

describe("risk decision thresholds", () => {
  it("maps a mid-range score to review rather than denial", () => {
    const reasons = [{ type: "PAIR_FARMING" as const, severity: 6, note: "test" }];
    expect(scoreFromReasons(reasons).decision).toBe("REVIEW");
  });
});

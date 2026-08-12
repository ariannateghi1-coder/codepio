import { describe, expect, it } from "vitest";
import {
  applyHeartbeat,
  boundedElapsed,
  checkSequence,
  creditedWatchSeconds,
  isTimerSatisfied,
  isWatchSatisfied,
  mergeSegments,
  minimumElapsedSeconds,
  parseSegments,
  remainingWatchSeconds,
  requiredWatchSeconds,
  segmentsTotal,
  watchPercent,
  type Segment,
} from "@/lib/services/watch";
import { WATCH_RULES } from "@/lib/gamification";

/**
 * Watch accounting is the anti-abuse core: these tests encode the rule that
 * watched time is the measure of the UNION of segments actually played, credited
 * only as fast as wall-clock time allows.
 */

describe("mergeSegments", () => {
  it("merges overlapping ranges", () => {
    expect(mergeSegments([[0, 10], [5, 20]])).toEqual([[0, 20]]);
  });

  it("merges adjacent ranges within the tolerance", () => {
    expect(mergeSegments([[0, 10], [10.2, 20]])).toEqual([[0, 20]]);
  });

  it("keeps genuinely separate ranges apart", () => {
    expect(mergeSegments([[0, 10], [40, 50]])).toEqual([
      [0, 10],
      [40, 50],
    ]);
  });

  it("sorts unordered input and drops empty ranges", () => {
    expect(mergeSegments([[40, 50], [0, 0], [10, 20]])).toEqual([
      [10, 20],
      [40, 50],
    ]);
  });

  it("normalises reversed ranges instead of trusting the caller", () => {
    expect(mergeSegments([[20, 10]])).toEqual([[10, 20]]);
  });
});

describe("segmentsTotal", () => {
  it("counts overlapping coverage once", () => {
    expect(segmentsTotal([[0, 60], [30, 90]])).toBe(90);
  });

  it("is zero for no coverage", () => {
    expect(segmentsTotal([])).toBe(0);
  });
});

describe("applyHeartbeat", () => {
  const base = { durationSec: 600, maxRate: 2 };

  it("credits normal playback", () => {
    const result = applyHeartbeat({
      ...base,
      segments: [],
      previousPosition: 0,
      position: 10,
      elapsedWallSeconds: 10,
    });
    expect(result.creditedSec).toBeCloseTo(10);
    expect(result.seeked).toBe(false);
    expect(result.impossible).toBe(false);
  });

  it("credits nothing for a forward seek and does not count it as watched", () => {
    // Claimed 540s of progress in 10s of wall time: physically impossible.
    const result = applyHeartbeat({
      ...base,
      segments: [],
      previousPosition: 0,
      position: 540,
      elapsedWallSeconds: 10,
    });
    expect(result.creditedSec).toBe(0);
    expect(result.accumulatedSec).toBe(0);
    expect(result.seeked).toBe(true);
    expect(result.impossible).toBe(true);
  });

  it("does not credit rewinding, and does not treat it as abuse", () => {
    const result = applyHeartbeat({
      ...base,
      segments: [[0, 100]],
      previousPosition: 100,
      position: 40,
      elapsedWallSeconds: 10,
    });
    expect(result.creditedSec).toBe(0);
    expect(result.accumulatedSec).toBe(100);
    expect(result.impossible).toBe(false);
  });

  it("does not double-count a re-watched region", () => {
    const result = applyHeartbeat({
      ...base,
      segments: [[0, 100]],
      previousPosition: 50,
      position: 60,
      elapsedWallSeconds: 10,
    });
    expect(result.accumulatedSec).toBe(100);
    expect(result.creditedSec).toBe(0);
  });

  it("allows up to maxRate but not beyond", () => {
    const withinRate = applyHeartbeat({
      ...base,
      segments: [],
      previousPosition: 0,
      position: 20,
      elapsedWallSeconds: 10,
    });
    expect(withinRate.creditedSec).toBeCloseTo(20);

    const aboveRate = applyHeartbeat({
      ...base,
      segments: [],
      previousPosition: 0,
      position: 60,
      elapsedWallSeconds: 10,
    });
    expect(aboveRate.creditedSec).toBe(0);
    expect(aboveRate.seeked).toBe(true);
  });

  it("clamps a position beyond the video duration", () => {
    const result = applyHeartbeat({
      ...base,
      segments: [],
      previousPosition: 595,
      position: 9999,
      elapsedWallSeconds: 10,
    });
    expect(result.accumulatedSec).toBeLessThanOrEqual(600);
  });

  it("cannot be satisfied by scrubbing across the whole timeline", () => {
    // Ten 60s jumps, one per 10s heartbeat: covers the timeline visually but
    // credits nothing, because each jump exceeds the wall-clock allowance.
    let segments: Segment[] = [];
    let position = 0;
    for (let i = 0; i < 10; i += 1) {
      const next = position + 60;
      const result = applyHeartbeat({
        ...base,
        segments,
        previousPosition: position,
        position: next,
        elapsedWallSeconds: 10,
      });
      segments = result.segments;
      position = next;
    }
    expect(segmentsTotal(segments)).toBe(0);
    expect(isWatchSatisfied(segmentsTotal(segments), 600, 90)).toBe(false);
  });

  it("accumulates a genuine full watch to the required threshold", () => {
    let segments: Segment[] = [];
    let position = 0;
    // 60 heartbeats of 10s each at 1x = 600s of real coverage.
    for (let i = 0; i < 60; i += 1) {
      const next = position + 10;
      const result = applyHeartbeat({
        ...base,
        segments,
        previousPosition: position,
        position: next,
        elapsedWallSeconds: 10,
      });
      segments = result.segments;
      position = next;
    }
    expect(segmentsTotal(segments)).toBeCloseTo(600);
    expect(isWatchSatisfied(segmentsTotal(segments), 600, 90)).toBe(true);
  });
});

/**
 * The timer model is what the live watch flow uses. These tests pin the two
 * properties the reward depends on: the requirement is 99% of the real duration,
 * and satisfaction is a function of the server anchor alone.
 */
describe("watch requirement — 99% of duration", () => {
  it("is ceil(duration * 0.99), as specified", () => {
    const percent = WATCH_RULES.defaultRequiredPercent;
    expect(percent).toBe(99);
    expect(requiredWatchSeconds(600, percent)).toBe(594);
    expect(requiredWatchSeconds(300, percent)).toBe(297);
  });

  it("rounds up rather than down, so a short watch never passes on rounding", () => {
    // 213 * 0.99 = 210.87 → 211, not 210.
    expect(requiredWatchSeconds(213, 99)).toBe(211);
    expect(requiredWatchSeconds(101, 99)).toBe(100);
  });
});

describe("isTimerSatisfied", () => {
  const now = new Date("2026-08-16T12:00:00.000Z");
  const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);

  it("is false until the full requirement has elapsed", () => {
    expect(isTimerSatisfied(ago(593), 594, now)).toBe(false);
    expect(isTimerSatisfied(ago(594), 594, now)).toBe(true);
    expect(isTimerSatisfied(ago(600), 594, now)).toBe(true);
  });

  it("is never satisfied when the video was never opened", () => {
    // This is the property that stops a client from skipping straight to done.
    expect(isTimerSatisfied(null, 594, now)).toBe(false);
    expect(isTimerSatisfied(undefined, 594, now)).toBe(false);
  });

  it("is not satisfied by a nonsensical requirement", () => {
    expect(isTimerSatisfied(ago(10_000), 0, now)).toBe(false);
    expect(isTimerSatisfied(ago(10_000), Number.NaN, now)).toBe(false);
  });

  it("cannot be satisfied by an anchor in the future", () => {
    expect(isTimerSatisfied(new Date(now.getTime() + 60_000), 594, now)).toBe(false);
  });
});

describe("remainingWatchSeconds", () => {
  const now = new Date("2026-08-16T12:00:00.000Z");
  const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);

  it("counts down and stops at zero", () => {
    expect(remainingWatchSeconds(ago(0), 594, now)).toBe(594);
    expect(remainingWatchSeconds(ago(394), 594, now)).toBe(200);
    expect(remainingWatchSeconds(ago(594), 594, now)).toBe(0);
    expect(remainingWatchSeconds(ago(5_000), 594, now)).toBe(0);
  });

  it("reports the whole requirement before the video is opened", () => {
    expect(remainingWatchSeconds(null, 594, now)).toBe(594);
  });
});

describe("creditedWatchSeconds", () => {
  const now = new Date("2026-08-16T12:00:00.000Z");
  const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);

  it("never exceeds the requirement, however long the tab stayed open", () => {
    expect(creditedWatchSeconds(ago(10_000), 594, now)).toBe(594);
  });

  it("never exceeds elapsed real time", () => {
    expect(creditedWatchSeconds(ago(120), 594, now)).toBe(120);
  });

  it("is zero before the video is opened", () => {
    expect(creditedWatchSeconds(null, 594, now)).toBe(0);
  });
});

describe("thresholds", () => {
  it("rounds the required seconds up", () => {
    expect(requiredWatchSeconds(213, 90)).toBe(192);
  });

  it("clamps an out-of-range percentage", () => {
    expect(requiredWatchSeconds(100, 500)).toBe(100);
    expect(requiredWatchSeconds(100, 0)).toBe(1);
  });

  it("reports percentage without exceeding 100", () => {
    expect(watchPercent(700, 600)).toBe(100);
    expect(watchPercent(300, 600)).toBe(50);
    expect(watchPercent(10, 0)).toBe(0);
  });
});

describe("parseSegments", () => {
  it("tolerates garbage from the JSON column", () => {
    expect(parseSegments("not-an-array")).toEqual([]);
    expect(parseSegments([["a", "b"], [1], [0, 10]])).toEqual([[0, 10]]);
    expect(parseSegments(null)).toEqual([]);
  });
});

describe("checkSequence", () => {
  const cadence = 10;

  it("accepts a normal in-order beat", () => {
    expect(
      checkSequence({ sequence: 5, lastSequence: 4, elapsedWallSeconds: 10, expectedIntervalSeconds: cadence })
    ).toEqual({ accepted: true });
  });

  it("rejects a replayed sequence", () => {
    const result = checkSequence({
      sequence: 4,
      lastSequence: 4,
      elapsedWallSeconds: 10,
      expectedIntervalSeconds: cadence,
    });
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.reason).toBe("REPLAY");
  });

  it("rejects an out-of-order beat that arrived late", () => {
    const result = checkSequence({
      sequence: 2,
      lastSequence: 7,
      elapsedWallSeconds: 10,
      expectedIntervalSeconds: cadence,
    });
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.reason).toBe("OUT_OF_ORDER");
  });

  it("rejects a flood of beats arriving faster than the cadence allows", () => {
    const result = checkSequence({
      sequence: 8,
      lastSequence: 7,
      elapsedWallSeconds: 0.2,
      expectedIntervalSeconds: cadence,
    });
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.reason).toBe("TOO_FREQUENT");
  });

  it("tolerates ordinary jitter around the cadence", () => {
    expect(
      checkSequence({ sequence: 3, lastSequence: 2, elapsedWallSeconds: 7.5, expectedIntervalSeconds: cadence }).accepted
    ).toBe(true);
    expect(
      checkSequence({ sequence: 3, lastSequence: 2, elapsedWallSeconds: 14, expectedIntervalSeconds: cadence }).accepted
    ).toBe(true);
  });

  it("still applies the cadence check when the client sends no sequence", () => {
    expect(
      checkSequence({ sequence: undefined, lastSequence: 5, elapsedWallSeconds: 10, expectedIntervalSeconds: cadence })
        .accepted
    ).toBe(true);
    expect(
      checkSequence({ sequence: undefined, lastSequence: 5, elapsedWallSeconds: 0.1, expectedIntervalSeconds: cadence })
        .accepted
    ).toBe(false);
  });

  it("cannot be used to accumulate allowance by beating rapidly", () => {
    // 20 beats in 4 seconds: only the ones respecting the floor are accepted.
    let accepted = 0;
    for (let i = 1; i <= 20; i += 1) {
      if (checkSequence({ sequence: i, lastSequence: i - 1, elapsedWallSeconds: 0.2, expectedIntervalSeconds: cadence }).accepted) {
        accepted += 1;
      }
    }
    expect(accepted).toBe(0);
  });
});

describe("boundedElapsed", () => {
  it("passes a normal interval through", () => {
    expect(boundedElapsed(10, 10)).toBe(10);
    expect(boundedElapsed(12, 10)).toBe(12);
  });

  it("caps a long silence, so a gap cannot bank allowance for a later jump", () => {
    // Away for an hour, then a big position jump: allowance is 3 intervals, not 3600s.
    expect(boundedElapsed(3600, 10)).toBe(30);
  });

  it("treats a non-positive or invalid interval as zero allowance", () => {
    expect(boundedElapsed(0, 10)).toBe(0);
    expect(boundedElapsed(-5, 10)).toBe(0);
    expect(boundedElapsed(Number.NaN, 10)).toBe(0);
  });

  it("makes the gap-then-jump attack worthless end to end", () => {
    // Silence for an hour, then claim 600s of progress.
    const allowance = boundedElapsed(3600, 10);
    const result = applyHeartbeat({
      segments: [],
      previousPosition: 0,
      position: 600,
      elapsedWallSeconds: allowance,
      durationSec: 600,
      maxRate: 2,
    });
    expect(result.creditedSec).toBe(0);
    expect(result.seeked).toBe(true);
  });
});

describe("minimumElapsedSeconds", () => {
  it("requires most of the real duration even at maximum credited rate", () => {
    // 540s required at 2x with a 15s grace → 255s of wall time minimum.
    expect(minimumElapsedSeconds(540, 2)).toBe(255);
  });

  it("makes a ten-minute requirement impossible to meet in twenty seconds", () => {
    expect(minimumElapsedSeconds(600, 2)).toBeGreaterThan(20);
  });

  it("never returns a negative floor for a very short video", () => {
    expect(minimumElapsedSeconds(10, 2)).toBe(0);
  });

  it("treats a nonsensical rate as 1x rather than dividing by it", () => {
    expect(minimumElapsedSeconds(100, 0)).toBe(85);
    expect(minimumElapsedSeconds(100, 0.1)).toBe(85);
  });
});

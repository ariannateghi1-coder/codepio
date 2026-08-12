/**
 * Watch-progress accounting — pure functions, no I/O, fully unit tested.
 *
 * The rule that matters: watched time is the measure of the UNION of timeline
 * segments the user actually played, not `currentTime`. Seeking to 90% and
 * stopping yields ~0 watched seconds, which is exactly the abuse this prevents.
 */

/** A half-open watched range in seconds: [from, to). */
export type Segment = [number, number];

const EPSILON = 0.5;

/** Sorts and merges overlapping/adjacent segments into a canonical set. */
export function mergeSegments(segments: Segment[]): Segment[] {
  const valid = segments
    .map(([from, to]) => [Math.max(0, Math.min(from, to)), Math.max(0, Math.max(from, to))] as Segment)
    .filter(([from, to]) => to - from > 0.01)
    .sort((a, b) => a[0] - b[0]);

  const merged: Segment[] = [];
  for (const [from, to] of valid) {
    const last = merged[merged.length - 1];
    if (last && from <= last[1] + EPSILON) {
      last[1] = Math.max(last[1], to);
    } else {
      merged.push([from, to]);
    }
  }
  return merged;
}

export function segmentsTotal(segments: Segment[]): number {
  return mergeSegments(segments).reduce((sum, [from, to]) => sum + (to - from), 0);
}

export type HeartbeatInput = {
  /** Current merged segments held server-side. */
  segments: Segment[];
  /** Player position reported at the previous heartbeat. */
  previousPosition: number;
  /** Player position reported now. */
  position: number;
  /** Seconds of wall-clock time the server measured between the two heartbeats. */
  elapsedWallSeconds: number;
  /** Total video length, from YouTube metadata (not the client). */
  durationSec: number;
  /** Maximum playback rate we are willing to credit (anti fast-forward). */
  maxRate: number;
};

export type HeartbeatOutcome = {
  segments: Segment[];
  accumulatedSec: number;
  /** Seconds actually credited by this heartbeat. */
  creditedSec: number;
  /** True when the reported jump could not be genuine playback. */
  seeked: boolean;
  /** True when progress exceeded what wall-clock time allows. */
  impossible: boolean;
};

/** Why a heartbeat was refused, when it was. */
export type BeatRejection = "REPLAY" | "OUT_OF_ORDER" | "TOO_FREQUENT";

export type SequenceCheck =
  | { accepted: true }
  | { accepted: false; reason: BeatRejection; note: string };

/**
 * Sequence and cadence gate, applied BEFORE any progress is credited.
 *
 * Three distinct failures, each of which would otherwise corrupt the accounting:
 *
 *   REPLAY        the same sequence number arriving twice — a resent request, or
 *                 an attacker replaying a captured beat to earn the interval again.
 *   OUT_OF_ORDER  a sequence below the last accepted one; the network reordered
 *                 delivery, and applying it would rewind the credit cursor.
 *   TOO_FREQUENT  beats arriving faster than the client is supposed to send them.
 *                 Each beat carries its own wall-clock allowance, so without this
 *                 gate a flood of tiny intervals could be used to accumulate
 *                 allowance far faster than real time.
 *
 * Sequence is required by the public heartbeat schema. The defensive undefined
 * branch remains for legacy/internal callers and applies cadence-only protection.
 */
export function checkSequence(input: {
  sequence: number | undefined;
  lastSequence: number;
  elapsedWallSeconds: number;
  /** Expected client cadence in seconds. */
  expectedIntervalSeconds: number;
}): SequenceCheck {
  const { sequence, lastSequence, elapsedWallSeconds, expectedIntervalSeconds } = input;

  if (sequence !== undefined) {
    if (sequence === lastSequence) {
      return { accepted: false, reason: "REPLAY", note: `sequence ${sequence} already applied` };
    }
    if (sequence < lastSequence) {
      return {
        accepted: false,
        reason: "OUT_OF_ORDER",
        note: `sequence ${sequence} is behind the last accepted ${lastSequence}`,
      };
    }
  }

  // A quarter of the cadence absorbs timer drift and network jitter; anything
  // faster than that is not a real player loop.
  const floor = expectedIntervalSeconds * 0.25;
  if (elapsedWallSeconds < floor) {
    return {
      accepted: false,
      reason: "TOO_FREQUENT",
      note: `beat arrived after ${elapsedWallSeconds.toFixed(2)}s, minimum ${floor.toFixed(2)}s`,
    };
  }

  return { accepted: true };
}

/**
 * Caps the wall-clock allowance a single heartbeat may claim.
 *
 * Without this, a client that goes quiet for an hour and then reports a large
 * position jump would carry an hour of allowance, and the jump would be credited
 * as genuine playback. Real players beat every `heartbeatSeconds`, so a longer gap
 * means we simply were not observing — credit at most a few intervals' worth.
 */
export function boundedElapsed(elapsedWallSeconds: number, expectedIntervalSeconds: number): number {
  if (!Number.isFinite(elapsedWallSeconds) || elapsedWallSeconds <= 0) return 0;
  return Math.min(elapsedWallSeconds, expectedIntervalSeconds * 3);
}

/**
 * Minimum wall-clock time in which a watch requirement can legitimately be met.
 *
 * Even a client that spoofs positions perfectly cannot compress real time: a
 * ten-minute video cannot be 90%-watched in twenty seconds. Allowing for the
 * maximum credited playback rate plus a startup/buffering grace period gives the
 * floor that completion is checked against.
 */
export function minimumElapsedSeconds(requiredSec: number, maxRate: number, graceSeconds = 15): number {
  const rate = Math.max(1, maxRate);
  return Math.max(0, requiredSec / rate - graceSeconds);
}

/**
 * Applies one heartbeat.
 *
 * Credit is granted only for forward progress that is consistent with the wall
 * time we measured between heartbeats. A larger jump is treated as a seek: the
 * new position becomes the cursor, but no time is credited. A jump that is
 * forward yet still too fast is flagged impossible and clamped.
 */
export function applyHeartbeat(input: HeartbeatInput): HeartbeatOutcome {
  const duration = Math.max(1, input.durationSec);
  const position = clamp(input.position, 0, duration);
  const previous = clamp(input.previousPosition, 0, duration);
  const delta = position - previous;

  const allowance = Math.max(0, input.elapsedWallSeconds) * input.maxRate + EPSILON;

  if (delta <= 0) {
    // Rewind or pause: no new coverage, and rewinding is not itself abuse.
    const merged = mergeSegments(input.segments);
    return { segments: merged, accumulatedSec: segmentsTotal(merged), creditedSec: 0, seeked: delta < -EPSILON, impossible: false };
  }

  if (delta > allowance) {
    // Cannot have played this much in the elapsed time → it's a seek/tamper.
    const merged = mergeSegments(input.segments);
    return {
      segments: merged,
      accumulatedSec: segmentsTotal(merged),
      creditedSec: 0,
      seeked: true,
      impossible: delta > allowance * 2,
    };
  }

  const merged = mergeSegments([...input.segments, [previous, position]]);
  const before = segmentsTotal(input.segments);
  const after = segmentsTotal(merged);
  return {
    segments: merged,
    accumulatedSec: after,
    creditedSec: Math.max(0, after - before),
    seeked: false,
    impossible: false,
  };
}

export function requiredWatchSeconds(durationSec: number, requiredPercent: number): number {
  const percent = clamp(requiredPercent, 1, 100);
  return Math.ceil((durationSec * percent) / 100);
}

export function watchPercent(accumulatedSec: number, durationSec: number): number {
  if (durationSec <= 0) return 0;
  return Math.min(100, Math.round((accumulatedSec / durationSec) * 100));
}

export function isWatchSatisfied(accumulatedSec: number, durationSec: number, requiredPercent: number): boolean {
  return accumulatedSec + EPSILON >= requiredWatchSeconds(durationSec, requiredPercent);
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Parses the JSON column into typed segments, tolerating legacy/garbage data. */
export function parseSegments(value: unknown): Segment[] {
  if (!Array.isArray(value)) return [];
  const out: Segment[] = [];
  for (const item of value) {
    if (Array.isArray(item) && item.length === 2) {
      const from = Number(item[0]);
      const to = Number(item[1]);
      if (Number.isFinite(from) && Number.isFinite(to)) out.push([from, to]);
    }
  }
  return mergeSegments(out);
}

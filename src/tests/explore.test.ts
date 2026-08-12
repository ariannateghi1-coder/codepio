import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "@/lib/services/explore";
import { EXPLORE_MIX, EXPLORE_POOL, EXPLORE_WEIGHTS } from "@/lib/gamification";

/**
 * Explore ranking configuration and cursor.
 *
 * The feed itself needs a database, so it is exercised end-to-end elsewhere. What
 * is tested here is what can be tested honestly without one: that the declared
 * configuration is coherent, and that the cursor round-trips exactly — since a
 * lossy cursor is what produces duplicate or skipped items between pages.
 */

describe("EXPLORE_WEIGHTS", () => {
  it("declares every factor the scoring pipeline consumes", () => {
    // If a weight is added here but never read, the config is lying about how the
    // feed works; if one is read but missing, scoring would produce NaN.
    expect(Object.keys(EXPLORE_WEIGHTS).sort()).toEqual(
      ["completionRate", "fairness", "freshness", "personalization", "popularity", "quality", "reputation"].sort()
    );
  });

  it("sums to 1, so a raw score is a 0..1 quantity", () => {
    const total = Object.values(EXPLORE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it("gives every factor real influence", () => {
    for (const [name, weight] of Object.entries(EXPLORE_WEIGHTS)) {
      expect(weight, `${name} must be able to affect ranking`).toBeGreaterThan(0);
    }
  });

  it("does not let any single factor dominate the feed", () => {
    for (const weight of Object.values(EXPLORE_WEIGHTS)) {
      expect(weight).toBeLessThan(0.5);
    }
  });

  it("weights quality and freshness above raw popularity", () => {
    // Otherwise the feed converges on whoever is already popular, which is the
    // opposite of what a support exchange needs.
    expect(EXPLORE_WEIGHTS.quality).toBeGreaterThan(EXPLORE_WEIGHTS.popularity);
    expect(EXPLORE_WEIGHTS.freshness).toBeGreaterThanOrEqual(EXPLORE_WEIGHTS.popularity);
  });
});

describe("EXPLORE_MIX", () => {
  it("declares exactly the four lanes the pipeline fills", () => {
    expect(Object.keys(EXPLORE_MIX).sort()).toEqual(["exploration", "fresh", "personalized", "popular"]);
  });

  it("sums to 1, so the lane quotas fill a whole page", () => {
    const total = Object.values(EXPLORE_MIX).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it("reserves a real exploration share, bounded enough not to feel random", () => {
    expect(EXPLORE_MIX.exploration).toBeGreaterThan(0);
    expect(EXPLORE_MIX.exploration).toBeLessThanOrEqual(0.2);
  });

  it("produces at least one slot per lane on a standard page of 12", () => {
    for (const share of Object.values(EXPLORE_MIX)) {
      expect(Math.round(12 * share)).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("EXPLORE_POOL", () => {
  it("bounds the candidate pool", () => {
    expect(EXPLORE_POOL.candidateLimit).toBeGreaterThan(24);
    expect(EXPLORE_POOL.candidateLimit).toBeLessThanOrEqual(1000);
  });

  it("caps one creator well below a full page", () => {
    expect(EXPLORE_POOL.perCreatorShare).toBeGreaterThan(0);
    expect(EXPLORE_POOL.perCreatorShare).toBeLessThanOrEqual(0.34);
    // On a 12-card page that is at most 4 cards from one creator.
    expect(Math.ceil(12 * EXPLORE_POOL.perCreatorShare)).toBeLessThanOrEqual(4);
  });

  it("rotates the ranking seed often enough to feel alive, rarely enough to page", () => {
    expect(EXPLORE_POOL.seedRotationMinutes).toBeGreaterThanOrEqual(5);
    expect(EXPLORE_POOL.seedRotationMinutes).toBeLessThanOrEqual(240);
  });
});

describe("cursor", () => {
  const now = 1_700_000_000_000;
  const cursor = {
    version: 2 as const,
    seed: 1234567,
    filter: "for_you" as const,
    search: "سازنده",
    offset: 2,
    issuedAt: now,
    expiresAt: now + 30 * 60_000,
    snapshotIds: ["campaign-a", "campaign-b", "campaign-c"],
  };

  it("round-trips the pinned ranking context and offset exactly", () => {
    expect(decodeCursor(encodeCursor(cursor), now + 1)).toEqual(cursor);
  });

  it("is URL-safe and opaque", () => {
    const token = encodeCursor(cursor);
    expect(token).not.toContain("سازنده");
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("preserves offset zero, which is a legitimate position", () => {
    expect(decodeCursor(encodeCursor({ ...cursor, offset: 0 }), now + 1)?.offset).toBe(0);
  });

  it("keeps filter, search, seed and snapshot bound by the signature", () => {
    const decoded = decodeCursor(
      encodeCursor({ ...cursor, filter: "new", search: "ویدیو" }),
      now + 1
    );
    expect(decoded).toMatchObject({ filter: "new", search: "ویدیو", seed: cursor.seed, snapshotIds: cursor.snapshotIds });
  });

  it("rejects tampering and expiry", () => {
    const token = encodeCursor(cursor);
    const [payload, signature] = token.split(".");
    const tamperedPayload = `${payload.slice(0, -1)}${payload.endsWith("A") ? "B" : "A"}`;
    expect(decodeCursor(`${tamperedPayload}.${signature}`, now + 1)).toBeNull();
    expect(decodeCursor(token, cursor.expiresAt)).toBeNull();
  });

  it("rejects offset and snapshot bounds", () => {
    expect(decodeCursor(encodeCursor({ ...cursor, offset: 4 }), now + 1)).toBeNull();
    expect(
      decodeCursor(encodeCursor({ ...cursor, offset: 0, snapshotIds: Array.from({ length: 301 }, (_, i) => `id-${i}`) }), now + 1)
    ).toBeNull();
  });

  it("keeps page slices stable when the live candidate order mutates", () => {
    const decoded = decodeCursor(encodeCursor(cursor), now + 1)!;
    const mutatedLiveIds = ["new-campaign", "campaign-c", "campaign-a", "campaign-b"];
    const nextPage = decoded.snapshotIds.slice(decoded.offset, decoded.offset + 1).filter((id) => mutatedLiveIds.includes(id));
    expect(nextPage).toEqual(["campaign-c"]);
  });

  it("rejects garbage instead of throwing", () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor("not-a-cursor")).toBeNull();
    expect(decodeCursor(Buffer.from("only|two", "utf8").toString("base64url"))).toBeNull();
  });

  it("rejects malformed versions and offsets", () => {
    const encodeRaw = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    expect(decodeCursor(encodeRaw({ ...cursor, version: 2 }))).toBeNull();
    expect(decodeCursor(encodeRaw({ ...cursor, offset: -1 }))).toBeNull();
    expect(decodeCursor(encodeRaw({ ...cursor, offset: 1.5 }))).toBeNull();
    expect(decodeCursor(encodeRaw({ ...cursor, seed: "NaN" }))).toBeNull();
  });
});

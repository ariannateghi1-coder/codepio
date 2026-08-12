import { describe, expect, it } from "vitest";
import { safeEqual, safeEqualHashed, sha256, randomToken, encryptSecret, decryptSecret, derivedSecret } from "@/lib/crypto";

/**
 * Crypto primitives. These are small, but they sit under session handling, CSRF
 * and OAuth token storage, so their failure modes matter more than their size.
 */

describe("safeEqual", () => {
  it("matches identical values and rejects different ones", () => {
    expect(safeEqual("abc123", "abc123")).toBe(true);
    expect(safeEqual("abc123", "abc124")).toBe(false);
  });

  it("rejects a length mismatch without throwing", () => {
    expect(safeEqual("short", "considerably-longer")).toBe(false);
    expect(safeEqual("", "x")).toBe(false);
  });
});

describe("safeEqualHashed", () => {
  it("compares values of differing length without leaking the length", () => {
    expect(safeEqualHashed("a", "a")).toBe(true);
    expect(safeEqualHashed("short", "considerably-longer-secret")).toBe(false);
    expect(safeEqualHashed("", "")).toBe(true);
  });
});

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a value", () => {
    const plaintext = "ya29.a0AfH-example-access-token";
    expect(decryptSecret(encryptSecret(plaintext))).toBe(plaintext);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const a = encryptSecret("same-input");
    const b = encryptSecret("same-input");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(decryptSecret(b));
  });

  it("never contains the plaintext", () => {
    expect(encryptSecret("super-secret-token")).not.toContain("super-secret-token");
  });

  it("fails loudly when the ciphertext is tampered with", () => {
    const payload = encryptSecret("tamper-me");
    const [version, iv, tag, data] = payload.split(".");
    const flipped = data.slice(0, -2) + (data.endsWith("AA") ? "BB" : "AA");
    expect(() => decryptSecret([version, iv, tag, flipped].join("."))).toThrow();
  });

  it("rejects a malformed payload instead of returning garbage", () => {
    expect(() => decryptSecret("not-a-payload")).toThrow();
    expect(() => decryptSecret("v2.a.b.c")).toThrow();
  });

  it("handles unicode and empty input", () => {
    expect(decryptSecret(encryptSecret("توکن فارسی"))).toBe("توکن فارسی");
    expect(decryptSecret(encryptSecret(""))).toBe("");
  });
});

describe("derivedSecret", () => {
  it("is deterministic per purpose and different across purposes", () => {
    expect(derivedSecret("maintenance-endpoint")).toBe(derivedSecret("maintenance-endpoint"));
    expect(derivedSecret("maintenance-endpoint")).not.toBe(derivedSecret("something-else"));
  });

  it("is long enough to be used as a bearer credential", () => {
    expect(derivedSecret("maintenance-endpoint").length).toBeGreaterThanOrEqual(32);
  });
});

describe("sha256", () => {
  it("produces a stable 64-character hex digest", () => {
    const digest = sha256("value");
    expect(digest).toHaveLength(64);
    expect(digest).toMatch(/^[0-9a-f]+$/);
    expect(sha256("value")).toBe(digest);
    expect(sha256("value2")).not.toBe(digest);
  });
});

describe("randomToken", () => {
  it("is URL-safe and unique across calls", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => randomToken()));
    expect(tokens.size).toBe(200);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("scales with the requested byte length", () => {
    expect(randomToken(16).length).toBeLessThan(randomToken(48).length);
  });
});

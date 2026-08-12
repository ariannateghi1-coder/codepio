import { describe, expect, it } from "vitest";
import { safeNextPath } from "@/lib/redirect";
import { AppError, ConflictError, ForbiddenError, RateLimitError, UnauthorizedError, ValidationError, errorMessage } from "@/lib/errors";
import { redactLogValue } from "@/lib/logger";

/**
 * Security-relevant pure logic. Anything that needs cookies, argon2 or the
 * database lives in the integration/e2e layer instead.
 */

describe("safeNextPath — open redirect guard", () => {
  it("accepts internal absolute paths", () => {
    expect(safeNextPath("/dashboard")).toBe("/dashboard");
    expect(safeNextPath("/explore?filter=new")).toBe("/explore?filter=new");
    expect(safeNextPath("/members/ali")).toBe("/members/ali");
  });

  it("rejects external and protocol-relative targets", () => {
    expect(safeNextPath("https://evil.com")).toBeNull();
    expect(safeNextPath("//evil.com")).toBeNull();
    expect(safeNextPath("/\\evil.com")).toBeNull();
    expect(safeNextPath("http://evil.com/path")).toBeNull();
    expect(safeNextPath("javascript:alert(1)")).toBeNull();
  });

  it("rejects backslash normalisation tricks", () => {
    expect(safeNextPath("/\\/evil.com")).toBeNull();
    expect(safeNextPath("/path\\..\\admin")).toBeNull();
  });

  it("rejects relative and empty values", () => {
    expect(safeNextPath("dashboard")).toBeNull();
    expect(safeNextPath("")).toBeNull();
    expect(safeNextPath(null)).toBeNull();
    expect(safeNextPath(undefined)).toBeNull();
  });

  it("refuses to bounce back to an auth page", () => {
    expect(safeNextPath("/auth/login")).toBeNull();
    expect(safeNextPath("/auth/register")).toBeNull();
  });
});

describe("logger redaction", () => {
  it("redacts sensitive keys and token-shaped values recursively", () => {
    const redacted = redactLogValue({
      password: "hunter2",
      nested: {
        authorization: "Bearer abc.def.ghi",
        note: "access_token=super-secret",
        safe: "visible",
      },
    });

    expect(redacted).toEqual({
      password: "[redacted]",
      nested: {
        authorization: "[redacted]",
        note: "[redacted]",
        safe: "visible",
      },
    });
  });

  it("bounds arrays, depth, and long strings", () => {
    const redacted = redactLogValue({
      rows: Array.from({ length: 60 }, (_, index) => index),
      deep: { a: { b: { c: { d: { e: "hidden" } } } } },
      long: "x".repeat(600),
    }) as { rows: number[]; deep: unknown; long: string };

    expect(redacted.rows).toHaveLength(50);
    expect(JSON.stringify(redacted.deep)).toContain("[depth-limit]");
    expect(redacted.long).toHaveLength(524);
    expect(redacted.long).toMatch(/…\[truncated\]$/);
  });
});

describe("error taxonomy", () => {
  it("maps each error class to the right status and code", () => {
    expect(new UnauthorizedError().status).toBe(401);
    expect(new UnauthorizedError().code).toBe("UNAUTHORIZED");
    expect(new ForbiddenError().status).toBe(403);
    expect(new ValidationError().status).toBe(422);
    expect(new ConflictError().status).toBe(409);
    expect(new RateLimitError(60).status).toBe(429);
    expect(new RateLimitError(60).retryAfterSeconds).toBe(60);
  });

  it("keeps the internal message separate from the public one", () => {
    const error = new AppError({
      code: "SERVER_ERROR",
      status: 500,
      publicMessage: "خطای غیرمنتظره رخ داد.",
      internalMessage: "Prisma connection pool exhausted at pool.ts:42",
    });
    expect(errorMessage(error)).toBe("خطای غیرمنتظره رخ داد.");
    expect(errorMessage(error)).not.toContain("Prisma");
    expect(error.message).toContain("Prisma");
  });

  it("never leaks a raw unknown value through errorMessage", () => {
    expect(errorMessage(undefined)).toBe("خطای غیرمنتظره‌ای رخ داد.");
    expect(errorMessage({ secret: "token" })).toBe("خطای غیرمنتظره‌ای رخ داد.");
  });

  it("marks expected business failures as expected", () => {
    expect(new ConflictError().expected).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import {
  campaignCreateSchema,
  changePasswordSchema,
  emailSchema,
  loginSchema,
  nameSchema,
  passwordSchema,
  profileSchema,
  registerSchema,
  reportSchema,
  usernameSchema,
  videoSchema,
  watchHeartbeatSchema,
} from "@/lib/validators";

/** Helper: does this schema accept the value? */
const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

describe("usernameSchema", () => {
  it("normalises case and trims", () => {
    expect(usernameSchema.parse("  MyUser  ")).toBe("myuser");
  });

  it("rejects invalid characters and lengths", () => {
    expect(ok(usernameSchema, "ab")).toBe(false);
    expect(ok(usernameSchema, "a".repeat(31))).toBe(false);
    expect(ok(usernameSchema, "user name")).toBe(false);
    expect(ok(usernameSchema, "user-name")).toBe(false);
    expect(ok(usernameSchema, "کاربر")).toBe(false);
    expect(ok(usernameSchema, "____")).toBe(false);
  });
});

describe("emailSchema", () => {
  it("lowercases and trims", () => {
    expect(emailSchema.parse(" User@Example.COM ")).toBe("user@example.com");
  });

  it("rejects malformed addresses", () => {
    expect(ok(emailSchema, "not-an-email")).toBe(false);
    expect(ok(emailSchema, "a@b")).toBe(false);
  });
});

describe("passwordSchema", () => {
  it("requires a real length", () => {
    expect(ok(passwordSchema, "short")).toBe(false);
    expect(ok(passwordSchema, "123456789")).toBe(false);
  });

  it("rejects very common passwords even at sufficient length", () => {
    expect(ok(passwordSchema, "password123")).toBe(false);
    expect(ok(passwordSchema, "welcome123")).toBe(false);
    expect(ok(passwordSchema, "academy123")).toBe(false);
  });

  it("accepts a mixed password or a long passphrase", () => {
    expect(ok(passwordSchema, "Str0ngPass99")).toBe(true);
    // Length beats complexity: 16+ characters needs no symbol requirement.
    expect(ok(passwordSchema, "correct horse battery staple")).toBe(true);
  });

  it("rejects a composition-free short-ish password", () => {
    expect(ok(passwordSchema, "alllowercase")).toBe(false);
  });
});

describe("nameSchema", () => {
  it("strips invisible and bidi control characters used for spoofing", () => {
    const spoofed = "عل\u202Eی\u200B";
    const parsed = nameSchema.parse(spoofed);
    expect(parsed).not.toMatch(/[\u200B\u202E]/);
  });

  it("rejects a name that becomes too short after cleaning", () => {
    expect(ok(nameSchema, "\u200B\u200Ba")).toBe(false);
  });
});

describe("registerSchema", () => {
  const base = {
    name: "علی رضایی",
    username: "alireza",
    email: "ali@example.com",
    password: "Str0ngPass99",
    confirmPassword: "Str0ngPass99",
  };

  it("accepts a well-formed registration", () => {
    expect(ok(registerSchema, base)).toBe(true);
  });

  it("requires matching confirmation", () => {
    expect(ok(registerSchema, { ...base, confirmPassword: "Different99" })).toBe(false);
  });

  it("rejects a password containing the username", () => {
    expect(
      ok(registerSchema, {
        ...base,
        username: "alireza",
        password: "Alireza12345",
        confirmPassword: "Alireza12345",
      })
    ).toBe(false);
  });
});

describe("loginSchema", () => {
  it("accepts either an email or a username", () => {
    expect(ok(loginSchema, { emailOrUsername: "ali@example.com", password: "x" })).toBe(true);
    expect(ok(loginSchema, { emailOrUsername: "alireza", password: "x" })).toBe(true);
  });

  it("does not apply the password policy at login", () => {
    // Login must accept whatever the user has, including a legacy weak password.
    expect(ok(loginSchema, { emailOrUsername: "alireza", password: "old" })).toBe(true);
  });
});

describe("changePasswordSchema", () => {
  it("requires the new password to differ from the current one", () => {
    expect(
      ok(changePasswordSchema, {
        currentPassword: "Str0ngPass99",
        password: "Str0ngPass99",
        confirmPassword: "Str0ngPass99",
      })
    ).toBe(false);
  });
});

describe("profileSchema", () => {
  it("only accepts https avatar urls", () => {
    expect(ok(profileSchema, { avatarUrl: "https://cdn.example/a.png" })).toBe(true);
    expect(ok(profileSchema, { avatarUrl: "http://cdn.example/a.png" })).toBe(false);
    expect(ok(profileSchema, { avatarUrl: "javascript:alert(1)" })).toBe(false);
    expect(ok(profileSchema, { avatarUrl: "data:image/png;base64,AAA" })).toBe(false);
  });

  it("does not accept privileged fields (mass assignment guard)", () => {
    const parsed = profileSchema.parse({ name: "علی", role: "ADMIN", credits: 9999 } as never);
    expect(parsed).not.toHaveProperty("role");
    expect(parsed).not.toHaveProperty("credits");
  });
});

describe("videoSchema", () => {
  it("requires a parseable YouTube url", () => {
    expect(ok(videoSchema, { youtubeUrl: "https://youtu.be/dQw4w9WgXcQ" })).toBe(true);
    expect(ok(videoSchema, { youtubeUrl: "https://evil-youtube.com/watch?v=dQw4w9WgXcQ" })).toBe(false);
    expect(ok(videoSchema, { youtubeUrl: "https://vimeo.com/12345" })).toBe(false);
  });
});

describe("campaignCreateSchema", () => {
  const base = {
    videoId: "clx0000000000000000000",
    title: "کمپین تست",
    startAt: new Date().toISOString(),
    endAt: new Date(Date.now() + 86_400_000).toISOString(),
    tasks: [{ type: "WATCH_VIDEO", required: true }],
  };

  it("accepts a minimal valid campaign and applies defaults", () => {
    const parsed = campaignCreateSchema.parse(base);
    expect(parsed.requiredWatchPercent).toBe(90);
    expect(parsed.rewardCredits).toBe(10);
  });

  it("requires the end date after the start date", () => {
    expect(
      ok(campaignCreateSchema, { ...base, endAt: new Date(Date.now() - 1000).toISOString() })
    ).toBe(false);
  });

  it("caps the campaign span at one year", () => {
    expect(
      ok(campaignCreateSchema, { ...base, endAt: new Date(Date.now() + 400 * 86_400_000).toISOString() })
    ).toBe(false);
  });

  it("always requires the watch task", () => {
    expect(ok(campaignCreateSchema, { ...base, tasks: [{ type: "LIKE_VIDEO", required: true }] })).toBe(false);
  });

  it("rejects duplicate task types", () => {
    expect(
      ok(campaignCreateSchema, {
        ...base,
        tasks: [
          { type: "WATCH_VIDEO", required: true },
          { type: "WATCH_VIDEO", required: false },
        ],
      })
    ).toBe(false);
  });

  it("bounds the watch percentage and the reward", () => {
    expect(ok(campaignCreateSchema, { ...base, requiredWatchPercent: 10 })).toBe(false);
    expect(ok(campaignCreateSchema, { ...base, requiredWatchPercent: 150 })).toBe(false);
    expect(ok(campaignCreateSchema, { ...base, rewardCredits: 0 })).toBe(false);
    expect(ok(campaignCreateSchema, { ...base, rewardCredits: 9999 })).toBe(false);
  });
});

describe("watchHeartbeatSchema", () => {
  it("bounds the reported position", () => {
    const valid = { sessionId: "clx0000000000000000000", position: 42, playerState: "PLAYING", sequence: 1 };
    expect(ok(watchHeartbeatSchema, valid)).toBe(true);
    expect(ok(watchHeartbeatSchema, { ...valid, sequence: undefined })).toBe(false);
    expect(ok(watchHeartbeatSchema, { ...valid, position: -1 })).toBe(false);
    expect(ok(watchHeartbeatSchema, { ...valid, position: 1_000_000 })).toBe(false);
    expect(ok(watchHeartbeatSchema, { ...valid, playerState: "HACKED" })).toBe(false);
  });
});

describe("reportSchema", () => {
  it("requires a known target type and a reason", () => {
    const valid = { targetType: "USER", targetId: "clx0000000000000000000", reason: "spam" };
    expect(ok(reportSchema, valid)).toBe(true);
    expect(ok(reportSchema, { ...valid, targetType: "SOMETHING" })).toBe(false);
    expect(ok(reportSchema, { ...valid, reason: "a" })).toBe(false);
  });
});

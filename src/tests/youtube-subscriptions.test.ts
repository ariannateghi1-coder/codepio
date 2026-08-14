import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as EnvModule from "@/lib/env";

/**
 * Subscription checking at the HTTP layer.
 *
 * What is pinned here is the part that decides whether this feature is affordable
 * and whether it can produce a false accusation:
 *
 *   1. subscriptions.list is used, never search.list (1 quota unit vs 100).
 *   2. Many channels ride in ONE request, so a user with several obligations costs
 *      one unit rather than one per obligation.
 *   3. Every spent unit is recorded, so the sweep's budget means something.
 *   4. A failure is all-or-nothing: no channel is ever reported "not subscribed"
 *      off a request that did not complete.
 *
 * prisma and crypto are mocked so this runs with no database and no real key; only
 * the HTTP layer is exercised. No test in this file spends real YouTube quota.
 */

const account = {
  userId: "u1",
  state: "CONNECTED",
  accessTokenCipher: "cipher",
  refreshTokenCipher: "refresh-cipher",
  // In the past on purpose, so the refresh branch runs as well.
  accessTokenExpires: new Date(Date.now() - 60_000),
  failureCount: 0,
};

const quotaSpends: number[] = [];

vi.mock("@/lib/prisma", () => ({
  prisma: {
    youtubeAccount: {
      findUnique: vi.fn().mockResolvedValue(account),
      update: vi.fn().mockResolvedValue(account),
    },
  },
}));

vi.mock("@/lib/crypto", () => ({
  encryptSecret: (v: string) => `enc(${v})`,
  decryptSecret: (v: string) => `dec(${v})`,
}));

// The quota counter itself is exercised through the real service in the
// compliance suite; here it is stubbed so the assertion is "spend was recorded",
// independent of how it is stored.
vi.mock("@/lib/services/youtube-quota", () => ({
  QUOTA_COST: { subscriptionsList: 1 },
  recordQuotaSpend: async (units: number) => {
    quotaSpends.push(units);
    return units;
  },
}));

vi.mock("@/lib/env", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof EnvModule;
  return {
    ...actual,
    env: { ...actual.env, GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csecret", YOUTUBE_API_KEY: "key" },
    features: { ...actual.features, youtubeOAuth: true, youtubeDataApi: true },
  };
});

const ORIGINAL_FETCH = globalThis.fetch;
let requested: string[] = [];

function stubFetch(apiResponse: { status: number; body: unknown }) {
  requested = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    requested.push(url);
    if (url.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(apiResponse.body), {
      status: apiResponse.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

/** Data API calls only — the token refresh is not a quota-bearing request. */
function apiCalls(): string[] {
  return requested.filter((u) => u.includes("googleapis.com/youtube/v3"));
}

function subscriptionItem(channelId: string) {
  return { snippet: { resourceId: { channelId } } };
}

beforeEach(() => {
  vi.resetModules();
  quotaSpends.length = 0;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

async function checkMany(channels: string[]) {
  const mod = await import("@/lib/services/youtube-api");
  return mod.checkSubscriptions("u1", channels);
}

describe("checkSubscriptions — endpoint and cost", () => {
  it("uses subscriptions.list and never search.list", async () => {
    stubFetch({ status: 200, body: { items: [subscriptionItem("UC_a")] } });
    await checkMany(["UC_a"]);

    const calls = apiCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/youtube/v3/subscriptions");
    // search.list costs 100 units instead of 1 and would make the whole feature
    // unaffordable.
    expect(requested.some((u) => u.includes("/youtube/v3/search"))).toBe(false);
  });

  it("answers many channels with ONE request", async () => {
    stubFetch({ status: 200, body: { items: [subscriptionItem("UC_a"), subscriptionItem("UC_c")] } });
    const result = await checkMany(["UC_a", "UC_b", "UC_c"]);

    const calls = apiCalls();
    expect(calls).toHaveLength(1);
    expect(decodeURIComponent(calls[0])).toContain("forChannelId=UC_a,UC_b,UC_c");
    expect(result.subscribed.has("UC_a")).toBe(true);
    expect(result.subscribed.has("UC_b")).toBe(false);
    expect(result.subscribed.has("UC_c")).toBe(true);
  });

  it("requests enough results that a longer list cannot be truncated", async () => {
    // maxResults=1 with three channels would return one match and read as "not
    // subscribed" for the other two.
    stubFetch({ status: 200, body: { items: [] } });
    await checkMany(["UC_a", "UC_b", "UC_c"]);
    expect(apiCalls()[0]).toContain("maxResults=3");
  });

  it("deduplicates channels so a repeated obligation costs nothing extra", async () => {
    stubFetch({ status: 200, body: { items: [] } });
    await checkMany(["UC_a", "UC_a", "UC_a"]);
    expect(decodeURIComponent(apiCalls()[0])).toContain("forChannelId=UC_a");
    expect(apiCalls()[0]).toContain("maxResults=1");
  });

  it("makes NO request at all for an empty obligation list", async () => {
    stubFetch({ status: 200, body: { items: [] } });
    const result = await checkMany([]);

    expect(apiCalls()).toHaveLength(0);
    expect(quotaSpends).toHaveLength(0);
    expect(result.available).toBe(true);
    expect(result.subscribed.size).toBe(0);
  });

  it("records exactly one quota unit per call", async () => {
    stubFetch({ status: 200, body: { items: [subscriptionItem("UC_a")] } });
    await checkMany(["UC_a", "UC_b", "UC_c", "UC_d"]);
    // Four channels, one request, one unit — this is the batching win.
    expect(quotaSpends).toEqual([1]);
  });
});

describe("checkSubscriptions — verdicts", () => {
  it("reports only the channels that were asked about", async () => {
    // A stray item for an unrelated channel must not satisfy an obligation.
    stubFetch({ status: 200, body: { items: [subscriptionItem("UC_a"), subscriptionItem("UC_unrelated")] } });
    const result = await checkMany(["UC_a", "UC_b"]);

    expect([...result.subscribed]).toEqual(["UC_a"]);
    expect(result.subscribed.has("UC_unrelated")).toBe(false);
  });

  it("an empty response means subscribed to none, definitively", async () => {
    stubFetch({ status: 200, body: { items: [] } });
    const result = await checkMany(["UC_a", "UC_b"]);

    expect(result.outcome).toBe("VERIFIED");
    expect(result.available).toBe(true);
    expect(result.subscribed.size).toBe(0);
  });

  it("ignores items with no resource channel id rather than guessing", async () => {
    stubFetch({ status: 200, body: { items: [{ snippet: {} }, subscriptionItem("UC_b")] } });
    const result = await checkMany(["UC_a", "UC_b"]);
    expect([...result.subscribed]).toEqual(["UC_b"]);
  });
});

describe("checkSubscriptions — a failed call is never a verdict", () => {
  it("a 500 is TEMPORARY_ERROR with no channel marked either way", async () => {
    stubFetch({ status: 500, body: { error: { code: 500, message: "backendError" } } });
    const result = await checkMany(["UC_a", "UC_b"]);

    expect(result.outcome).toBe("TEMPORARY_ERROR");
    expect(result.available).toBe(false);
    // The critical assertion: an empty set here must NOT be read as "unsubscribed
    // from everything". `available: false` is what the caller keys on.
    expect(result.subscribed.size).toBe(0);
  });

  it("a 429 is TEMPORARY_ERROR", async () => {
    stubFetch({ status: 429, body: { error: { code: 429, message: "rateLimitExceeded" } } });
    const result = await checkMany(["UC_a"]);
    expect(result.outcome).toBe("TEMPORARY_ERROR");
    expect(result.available).toBe(false);
  });

  it("a 403 quotaExceeded is TEMPORARY_ERROR, not a failed check", async () => {
    stubFetch({
      status: 403,
      body: { error: { code: 403, errors: [{ reason: "quotaExceeded" }], message: "quotaExceeded" } },
    });
    const result = await checkMany(["UC_a"]);
    expect(result.outcome).toBe("TEMPORARY_ERROR");
    expect(result.available).toBe(false);
  });

  it("a 401 is REAUTH_REQUIRED", async () => {
    stubFetch({ status: 401, body: { error: { code: 401, message: "Invalid Credentials" } } });
    const result = await checkMany(["UC_a"]);
    expect(result.outcome).toBe("REAUTH_REQUIRED");
    expect(result.available).toBe(false);
  });

  it("counts the unit even when the call fails, because Google counts it too", async () => {
    stubFetch({ status: 500, body: {} });
    await checkMany(["UC_a"]);
    // Recorded before the request, deliberately: a failed request still consumes
    // quota upstream, and an optimistic counter would let a failing sweep spin.
    expect(quotaSpends).toEqual([1]);
  });
});

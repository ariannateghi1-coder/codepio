import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as EnvModule from "@/lib/env";

/**
 * Regression cover for the like check.
 *
 * The original implementation called `videos.getRating`. Google treats that as a
 * rating (write-adjacent) endpoint, so a `youtube.readonly` grant gets
 * `403 ACCESS_TOKEN_SCOPE_INSUFFICIENT`. The generic handler mapped that to
 * `UNAVAILABLE`/API_ERROR, and the UI showed "لایک تأیید نشد" — so a supporter
 * who really had liked the video could never clear the task, no matter how many
 * times they re-checked.
 *
 * Two properties are pinned here:
 *   1. which endpoint is called (playlistItems on LL, not videos/getRating), and
 *   2. that a scope failure is never reported as "the user did not do it".
 *
 * prisma and crypto are mocked so the check can run without a database or the
 * real encryption key; only the HTTP layer is exercised.
 */

const account = {
  userId: "u1",
  state: "CONNECTED",
  accessTokenCipher: "cipher",
  refreshTokenCipher: "refresh-cipher",
  // Deliberately in the past so the refresh path runs too.
  accessTokenExpires: new Date(Date.now() - 60_000),
  failureCount: 0,
};

const updateMock = vi.fn().mockResolvedValue(account);

vi.mock("@/lib/prisma", () => ({
  prisma: {
    youtubeAccount: {
      findUnique: vi.fn().mockResolvedValue(account),
      update: (...args: unknown[]) => updateMock(...args),
    },
  },
}));

vi.mock("@/lib/crypto", () => ({
  encryptSecret: (v: string) => `enc(${v})`,
  decryptSecret: (v: string) => `dec(${v})`,
}));

// Partial mock: only the three values this path reads are overridden, so
// unrelated exports (isProduction, used by the logger) keep working.
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

beforeEach(() => {
  vi.resetModules();
  updateMock.mockClear();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

async function callCheckLike() {
  const mod = await import("@/lib/services/youtube-api");
  return mod.checkLike("u1", "vid123");
}

function apiUrl(): string {
  const url = requested.find((u) => u.includes("googleapis.com/youtube/v3"));
  if (!url) throw new Error("no Data API call was made; requested: " + JSON.stringify(requested));
  return url;
}

describe("checkLike — which endpoint is used", () => {
  it("reads the liked-videos playlist and not videos/getRating", async () => {
    stubFetch({ status: 200, body: { items: [{ contentDetails: { videoId: "vid123" } }] } });
    await callCheckLike();

    const url = apiUrl();
    expect(url).toContain("/youtube/v3/playlistItems");
    expect(url).toContain("playlistId=LL");
    expect(url).toContain("videoId=vid123");
    // The endpoint that caused the bug must never be called again.
    expect(requested.some((u) => u.includes("getRating"))).toBe(false);
  });

  it("asks for one item only, so the check costs a single quota unit", async () => {
    stubFetch({ status: 200, body: { items: [] } });
    await callCheckLike();
    expect(apiUrl()).toContain("maxResults=1");
  });
});

describe("checkLike — verdicts", () => {
  it("VERIFIED when the playlist contains the video", async () => {
    stubFetch({ status: 200, body: { items: [{ contentDetails: { videoId: "vid123" } }] } });
    const result = await callCheckLike();
    expect(result).toMatchObject({ outcome: "VERIFIED", satisfied: true, available: true });
  });

  it("NOT_VERIFIED when the playlist is empty", async () => {
    stubFetch({ status: 200, body: { items: [] } });
    const result = await callCheckLike();
    expect(result).toMatchObject({ outcome: "NOT_VERIFIED", satisfied: false, available: true });
  });

  it("NOT_VERIFIED when the API returns some other video", async () => {
    // Defence in depth: the videoId filter is server-side, but a mismatched item
    // must never be read as a like for the video we asked about.
    stubFetch({ status: 200, body: { items: [{ contentDetails: { videoId: "someone-else" } }] } });
    const result = await callCheckLike();
    expect(result.satisfied).toBe(false);
    expect(result.outcome).toBe("NOT_VERIFIED");
  });
});

describe("checkLike — failures are never 'you did not do it'", () => {
  it("a scope 403 reports REAUTH_REQUIRED, not NOT_VERIFIED", async () => {
    stubFetch({
      status: 403,
      body: {
        error: {
          code: 403,
          message: "Request had insufficient authentication scopes.",
          errors: [{ reason: "insufficientPermissions" }],
          status: "PERMISSION_DENIED",
        },
      },
    });
    const result = await callCheckLike();
    expect(result.outcome).toBe("REAUTH_REQUIRED");
    expect(result.satisfied).toBe(false);
    // available:false is what stops the task being recorded as failed.
    expect(result.available).toBe(false);
    expect(result.detail).toMatchObject({ reason: "SCOPE_INSUFFICIENT" });
  });

  it("a scope 403 does not park the grant, because other checks still work", async () => {
    stubFetch({
      status: 403,
      body: { error: { code: 403, message: "Request had insufficient authentication scopes." } },
    });
    await callCheckLike();
    const parked = updateMock.mock.calls.some(
      (call) => (call[0] as { data?: { state?: string } })?.data?.state === "REAUTH_REQUIRED"
    );
    expect(parked).toBe(false);
  });

  it("a 500 reports TEMPORARY_ERROR", async () => {
    stubFetch({ status: 500, body: { error: { code: 500, message: "backendError" } } });
    const result = await callCheckLike();
    expect(result.outcome).toBe("TEMPORARY_ERROR");
    expect(result.available).toBe(false);
  });

  it("quota exhaustion reports TEMPORARY_ERROR, not a failed task", async () => {
    stubFetch({
      status: 403,
      body: { error: { code: 403, errors: [{ reason: "quotaExceeded" }], message: "quotaExceeded" } },
    });
    const result = await callCheckLike();
    expect(result.outcome).toBe("TEMPORARY_ERROR");
    expect(result.satisfied).toBe(false);
  });
});

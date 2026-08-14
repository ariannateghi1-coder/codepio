import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression cover for subscribe verification.
 *
 * THE BUG
 * The subscribe target was read from the CREATOR'S LINKED CHANNEL
 * (`YoutubeConnection`), a row that only exists once the creator finishes the
 * optional YouTube OAuth flow. For a campaign whose uploader had not connected,
 * the target was null, the SUBSCRIBE_CHANNEL branch was skipped entirely, and the
 * task fell through to a catch-all whose verdict was UNAVAILABLE — which the task
 * writer then recorded as FAILED because the task was required.
 *
 * So a supporter who really had subscribed was told they had not, and pressing
 * «بررسی وضعیت» again could never help: nothing about re-checking makes a creator
 * connect their account.
 *
 * THE SECOND BUG, FOUND FROM THE SAME REPORT
 * The like check reads the supporter's own "Liked videos" playlist, the only like
 * surface a youtube.readonly grant can see. On videos flagged "Made for Kids"
 * YouTube keeps the like out of that playlist entirely, so a supporter who really
 * did like the video was told they had not — permanently, since no retry and no
 * wider scope can change it (videos.getRating refuses read-only tokens).
 *
 * PROPERTIES PINNED HERE
 *   1. The target is the channel that OWNS THE VIDEO (public data), resolved from
 *      the video row and lazily from videos.list. The creator's link is NEVER used:
 *      it answers "who registered this campaign", and one production row was wrong
 *      because of it.
 *   2. A required task is only ever recorded FAILED off a COMPLETED check that
 *      answered "no". Anything unanswerable stays PENDING, so a later re-check can
 *      still clear it.
 *   3. A structurally unverifiable task is WAIVED, not failed and not left pending
 *      forever — whether YouTube told us the video is kids content, or the creator
 *      declared the campaign as such.
 *   4. Failure copy NAMES the Google account that was inspected.
 *
 * Prisma and the YouTube layer are mocked, so nothing here touches a database or
 * spends a quota unit.
 */

type TaskRow = { id: string; type: string; required: boolean; state: string; method: string };

const HOUR = 3_600_000;

let session: {
  id: string;
  campaignId: string;
  supporterId: string;
  state: string;
  expiresAt: Date;
  tasks: TaskRow[];
  watchSession: { openedAt: Date | null; requiredSec: number } | null;
  video: { id: string; youtubeVideoId: string; channelId: string | null; madeForKids?: boolean | null } | null;
  campaign: { kidsContent: boolean } | null;
};

/** The supporter's own connected channel, as the note builders see it. */
let supporterConnection: { channelId: string; channelTitle: string } | null = null;
/** The Google account behind the grant — what the failure copy should name. */
let supporterGrant: { googleEmail: string | null } | null = null;

/** What the task rows were updated to, keyed by task id. */
const taskWrites: Record<string, Record<string, unknown>> = {};
const verificationWrites: { taskType: string; method: string; result: string }[] = [];
const videoUpdates: { id: string; data: Record<string, unknown> }[] = [];
/** Campaign writes, which is how a late kids detection becomes permanent. */
const campaignUpdates: Record<string, unknown>[] = [];

const prismaMock = {
  supportSession: {
    findUnique: async () => session,
    update: async () => session,
  },
  youtubeConnection: {
    findUnique: async () => supporterConnection,
  },
  youtubeAccount: {
    findUnique: async () => supporterGrant,
  },
  video: {
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      videoUpdates.push({ id: where.id, data });
      if (session.video) session.video.channelId = data.channelId as string;
      return session.video;
    },
  },
  campaign: {
    update: async ({ data }: { data: Record<string, unknown> }) => {
      campaignUpdates.push(data);
      return data;
    },
  },
  supportTask: {
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      taskWrites[where.id] = data;
      return data;
    },
  },
  supportVerification: {
    create: async ({ data }: { data: { taskType: string; method: string; result: string } }) => {
      verificationWrites.push(data);
      return data;
    },
  },
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prismaMock),
};

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

/* ----------------------------------------------------------- YouTube, scripted */

let subscriptionCheck: { outcome: string; available: boolean; satisfied: boolean };
/** Channel ids checkSubscription was actually asked about. */
let subscriptionTargets: string[] = [];
let likeCheck: { outcome: string; available: boolean; satisfied: boolean };
/** How many times the LIKE playlist was actually consulted. */
let likeCalls = 0;
let metadata: { channelId: string; channelTitle: string; madeForKids?: boolean } | null;
let metadataCalls = 0;
let metadataThrows = false;

vi.mock("@/lib/services/youtube-api", () => ({
  checkSubscription: async (_userId: string, channelId: string) => {
    subscriptionTargets.push(channelId);
    return { ...subscriptionCheck, detail: {} };
  },
  checkLike: async () => {
    likeCalls++;
    return { ...likeCheck, detail: {} };
  },
  checkComment: async () => ({ outcome: "UNAVAILABLE", available: false, satisfied: false, detail: {} }),
  fetchVideoMetadata: async () => {
    metadataCalls++;
    if (metadataThrows) throw new Error("youtube videos responded 503");
    return metadata;
  },
}));

/* ----------------------------------------------------------------------- setup */

function reset(overrides: Partial<typeof session> = {}) {
  session = {
    id: "sess1",
    campaignId: "camp1",
    supporterId: "supporter1",
    state: "WATCH_THRESHOLD_REACHED",
    expiresAt: new Date(Date.now() + HOUR),
    tasks: [{ id: "t-sub", type: "SUBSCRIBE_CHANNEL", required: true, state: "PENDING", method: "UNVERIFIED" }],
    // Already satisfied by elapsed time, so the watch task is not what these
    // tests are measuring.
    watchSession: { openedAt: new Date(Date.now() - HOUR), requiredSec: 60 },
    video: { id: "v1", youtubeVideoId: "JIN5TtemxHA", channelId: null, madeForKids: false },
    campaign: { kidsContent: false },
    ...overrides,
  };

  for (const key of Object.keys(taskWrites)) delete taskWrites[key];
  verificationWrites.length = 0;
  videoUpdates.length = 0;
  campaignUpdates.length = 0;
  subscriptionTargets = [];
  supporterConnection = { channelId: "UC_supporter", channelTitle: "MyChannel" };
  supporterGrant = { googleEmail: "supporter@gmail.com" };
  subscriptionCheck = { outcome: "VERIFIED", available: true, satisfied: true };
  likeCheck = { outcome: "VERIFIED", available: true, satisfied: true };
  likeCalls = 0;
  metadata = { channelId: "UC_video_owner", channelTitle: "Owner", madeForKids: false };
  metadataCalls = 0;
  metadataThrows = false;
}

async function verify() {
  const mod = await import("@/lib/services/support");
  return mod.verifySessionTasks("sess1", "supporter1");
}

beforeEach(() => {
  vi.resetModules();
  reset();
});

/* ------------------------------------------------------------------ the target */

describe("subscribe target resolution", () => {
  it("checks the channel that owns the video, not the creator's linked account", async () => {
    reset({ video: { id: "v1", youtubeVideoId: "JIN5TtemxHA", channelId: "UC_video_owner", madeForKids: false } });

    await verify();

    expect(subscriptionTargets).toEqual(["UC_video_owner"]);
    // No lookup was needed: the video row already knew who owns it.
    expect(metadataCalls).toBe(0);
  });

  it("resolves and PERSISTS the owner for a video row that predates the column", async () => {
    await verify();

    expect(subscriptionTargets).toEqual(["UC_video_owner"]);
    // Persisted, so the next verification costs no further call.
    expect(videoUpdates).toEqual([
      { id: "v1", data: { channelId: "UC_video_owner", channelTitle: "Owner", madeForKids: false } },
    ]);
  });

  it("verifies for a creator who never connected YouTube — the case that was broken", async () => {
    // The whole original bug: the creator has no YoutubeConnection at all, so the
    // old code had no target and reported "you did not subscribe".
    reset();

    const [result] = await verify();

    expect(result).toMatchObject({ type: "SUBSCRIBE_CHANNEL", satisfied: true, outcome: "VERIFIED", method: "YOUTUBE_API" });
    expect(taskWrites["t-sub"]).toMatchObject({ state: "SATISFIED", method: "YOUTUBE_API" });
  });

  it("never substitutes the creator's own channel for the uploader's", async () => {
    // Ownership is a fact about the video, so a guess is worse than an admission of
    // ignorance: guessing asks the supporter to subscribe to one channel while the
    // check inspects another. One production row was already wrong this way, holding
    // a Tech With Tim video as if the registering user owned it.
    metadataThrows = true;
    reset();
    metadataThrows = true;

    const [result] = await verify();

    expect(subscriptionTargets).toEqual([]);
    expect(result.outcome).toBe("UNAVAILABLE");
    expect(taskWrites["t-sub"]).toMatchObject({ state: "PENDING" });
    expect(videoUpdates).toHaveLength(0);
  });
});

/* ------------------------------------------------- failure vs. cannot-be-asked */

describe("a required task is only failed by a definitive 'no'", () => {
  it("FAILED when YouTube completed the check and said not subscribed", async () => {
    subscriptionCheck = { outcome: "NOT_VERIFIED", available: true, satisfied: false };

    const [result] = await verify();

    expect(result.outcome).toBe("NOT_VERIFIED");
    expect(taskWrites["t-sub"]).toMatchObject({ state: "FAILED" });
    expect(verificationWrites[0]).toMatchObject({ result: "FAILED" });
  });

  it("names the inspected account in the failure copy, so a second Google account is findable", async () => {
    // The verdict is correct here — this account really is not subscribed. What is
    // being pinned is that the copy tells the user WHICH account was inspected, since
    // "you are not subscribed" alone sends them to repeat the action on the same
    // wrong account.
    subscriptionCheck = { outcome: "NOT_VERIFIED", available: true, satisfied: false };

    const [result] = await verify();

    // The email, not the channel title: that is the string a user can compare
    // against the account switcher in the YouTube app.
    expect(result.note).toContain("supporter@gmail.com");
  });

  it("PENDING, never FAILED, when no target channel can be named", async () => {
    // Nothing knows the owner: no stored channel, no metadata, no creator link.
    metadata = null;
    reset({ video: { id: "v1", youtubeVideoId: "JIN5TtemxHA", channelId: null, madeForKids: false } });
    metadata = null;

    const [result] = await verify();

    expect(result.satisfied).toBe(false);
    expect(result.outcome).toBe("UNAVAILABLE");
    // The user must be able to clear this later; FAILED would be permanent.
    expect(taskWrites["t-sub"]).toMatchObject({ state: "PENDING" });
    expect(verificationWrites[0]).toMatchObject({ result: "INCONCLUSIVE" });
    // And the copy must not claim they did not subscribe.
    expect(result.note ?? "").not.toContain("سابسکرایب کنید و دوباره");
  });

  it("PENDING when the grant is dead, so reconnecting can still clear it", async () => {
    subscriptionCheck = { outcome: "REAUTH_REQUIRED", available: false, satisfied: false };

    await verify();

    expect(taskWrites["t-sub"]).toMatchObject({ state: "PENDING" });
  });

  it("PENDING on a temporary YouTube failure", async () => {
    subscriptionCheck = { outcome: "TEMPORARY_ERROR", available: false, satisfied: false };

    await verify();

    expect(taskWrites["t-sub"]).toMatchObject({ state: "PENDING" });
    expect(verificationWrites[0]).toMatchObject({ result: "PENDING" });
  });

  it("the watch timer is 'not yet', not a failure, while it is still running", async () => {
    reset({
      tasks: [{ id: "t-watch", type: "WATCH_VIDEO", required: true, state: "PENDING", method: "UNVERIFIED" }],
      // Opened a moment ago, so the requirement has not elapsed.
      watchSession: { openedAt: new Date(), requiredSec: 600 },
    });

    const [result] = await verify();

    expect(result.satisfied).toBe(false);
    // Waiting is not a verdict against the supporter: the task must stay open.
    expect(taskWrites["t-watch"]).toMatchObject({ state: "PENDING" });
    expect(verificationWrites[0]).toMatchObject({ result: "PENDING" });
  });

  it("the creator's kids-content declaration waives BOTH subscribe and like", async () => {
    // The creator's own report: YouTube does not surface subscribes to kids channels
    // either. The API cannot refute that — an absent subscription looks exactly like
    // one never made — so the declaration is trusted and both tasks are waived. The
    // creator carries the cost, paying full budget for weaker evidence, which is why
    // it cannot be abused against supporters.
    reset({
      tasks: [
        { id: "t-sub", type: "SUBSCRIBE_CHANNEL", required: true, state: "PENDING", method: "UNVERIFIED" },
        { id: "t-like", type: "LIKE_VIDEO", required: true, state: "PENDING", method: "UNVERIFIED" },
      ],
      video: { id: "v1", youtubeVideoId: "JIN5TtemxHA", channelId: "UC_video_owner", madeForKids: false },
      campaign: { kidsContent: true },
    });

    const results = await verify();

    // Neither question is put to YouTube: it has no answer to give.
    expect(subscriptionTargets).toEqual([]);
    expect(likeCalls).toBe(0);
    for (const r of results) expect(r.outcome).toBe("UNAVAILABLE");
    expect(taskWrites["t-sub"]).toMatchObject({ state: "SKIPPED" });
    expect(taskWrites["t-like"]).toMatchObject({ state: "SKIPPED" });
    // The copy blames the platform restriction, not the supporter.
    for (const r of results) expect(r.note ?? "").toContain("کودکان");
  });

  it("a real like on kids content is WAIVED, not called a lie", async () => {
    // The second production bug. YouTube keeps likes on "Made for Kids" videos out
    // of the viewer's own liked playlist, which is the only surface a read-only
    // grant can read, so the check cannot answer — for anyone, ever. Failing the
    // task accuses a supporter who did exactly what was asked; leaving it PENDING
    // strands the session. It is waived instead.
    reset({
      tasks: [{ id: "t-like", type: "LIKE_VIDEO", required: true, state: "PENDING", method: "UNVERIFIED" }],
      // YouTube's own flag, with the creator switch off: the waiver must still apply.
      video: { id: "v1", youtubeVideoId: "JIN5TtemxHA", channelId: "UC_video_owner", madeForKids: true },
      campaign: { kidsContent: false },
    });

    const [result] = await verify();

    expect(result.satisfied).toBe(false);
    expect(result.outcome).toBe("UNAVAILABLE");
    // No point spending a quota unit on a question the API cannot answer.
    expect(likeCalls).toBe(0);
    // SKIPPED on a required task means waived: it does not block settlement.
    expect(taskWrites["t-like"]).toMatchObject({ state: "SKIPPED" });
    expect(verificationWrites[0]).toMatchObject({ result: "INCONCLUSIVE" });
    // And the copy must blame the YouTube setting, not the supporter.
    expect(result.note ?? "").toContain("کودکان");
  });

  it("still checks the like normally on ordinary videos", async () => {
    reset({
      tasks: [{ id: "t-like", type: "LIKE_VIDEO", required: true, state: "PENDING", method: "UNVERIFIED" }],
      video: { id: "v1", youtubeVideoId: "JIN5TtemxHA", channelId: "UC_video_owner", madeForKids: false },
    });

    const [result] = await verify();

    expect(likeCalls).toBe(1);
    expect(result).toMatchObject({ satisfied: true, outcome: "VERIFIED", method: "YOUTUBE_API" });
    expect(taskWrites["t-like"]).toMatchObject({ state: "SATISFIED" });
  });

  it("a genuinely unliked ordinary video still fails, and names the account", async () => {
    likeCheck = { outcome: "NOT_VERIFIED", available: true, satisfied: false };
    reset({
      tasks: [{ id: "t-like", type: "LIKE_VIDEO", required: true, state: "PENDING", method: "UNVERIFIED" }],
      video: { id: "v1", youtubeVideoId: "JIN5TtemxHA", channelId: "UC_video_owner", madeForKids: false },
    });
    likeCheck = { outcome: "NOT_VERIFIED", available: true, satisfied: false };

    const [result] = await verify();

    expect(taskWrites["t-like"]).toMatchObject({ state: "FAILED" });
    expect(result.note).toContain("supporter@gmail.com");
  });

  it("re-confirms kids content from YouTube before recording a failure", async () => {
    // THE UNTICKED-BOX CASE. The creator never declared kids content and our cached
    // flag says false, so both checks run and both come back "no" — exactly the
    // shape of the original bug, and exactly what an honest supporter would see.
    //
    // Before that "no" is written down, the premise is re-read from YouTube. It now
    // reports kids content, so the checks were never capable of answering and the
    // tasks are waived instead of failed.
    subscriptionCheck = { outcome: "NOT_VERIFIED", available: true, satisfied: false };
    likeCheck = { outcome: "NOT_VERIFIED", available: true, satisfied: false };
    reset({
      tasks: [
        { id: "t-sub", type: "SUBSCRIBE_CHANNEL", required: true, state: "PENDING", method: "UNVERIFIED" },
        { id: "t-like", type: "LIKE_VIDEO", required: true, state: "PENDING", method: "UNVERIFIED" },
      ],
      video: { id: "v1", youtubeVideoId: "JIN5TtemxHA", channelId: "UC_video_owner", madeForKids: false },
      campaign: { kidsContent: false },
    });
    subscriptionCheck = { outcome: "NOT_VERIFIED", available: true, satisfied: false };
    likeCheck = { outcome: "NOT_VERIFIED", available: true, satisfied: false };
    // What YouTube says NOW, which is not what our row says.
    metadata = { channelId: "UC_video_owner", channelTitle: "Owner", madeForKids: true };

    const results = await verify();

    for (const r of results) expect(r.outcome).toBe("UNAVAILABLE");
    expect(taskWrites["t-sub"]).toMatchObject({ state: "SKIPPED" });
    expect(taskWrites["t-like"]).toMatchObject({ state: "SKIPPED" });
    // Self-healing: the stale cache is corrected and the campaign is marked, so the
    // next supporter is waived up front instead of paying for the lookup.
    expect(videoUpdates.at(-1)?.data).toMatchObject({ madeForKids: true });
    expect(campaignUpdates).toEqual([{ kidsContent: true }]);
    // And the lookup happens ONCE even though two tasks failed.
    expect(metadataCalls).toBe(1);
  });

  it("still fails an ordinary video after the re-confirmation says 'not kids'", async () => {
    // The guard must not become a blanket excuse: when YouTube confirms the video is
    // not kids content, a "no" is a real answer and is recorded as such.
    subscriptionCheck = { outcome: "NOT_VERIFIED", available: true, satisfied: false };
    reset({
      video: { id: "v1", youtubeVideoId: "JIN5TtemxHA", channelId: "UC_video_owner", madeForKids: false },
      campaign: { kidsContent: false },
    });
    subscriptionCheck = { outcome: "NOT_VERIFIED", available: true, satisfied: false };
    metadata = { channelId: "UC_video_owner", channelTitle: "Owner", madeForKids: false };

    await verify();

    expect(taskWrites["t-sub"]).toMatchObject({ state: "FAILED" });
    expect(campaignUpdates).toEqual([]);
  });

  it("does not invent a failure when the re-confirmation itself fails", async () => {
    // YouTube unreachable at the moment of truth. The check said "no", but we can no
    // longer establish whether that "no" was meaningful, so the honest state is
    // PENDING — recoverable on the next attempt.
    subscriptionCheck = { outcome: "NOT_VERIFIED", available: true, satisfied: false };
    reset({
      video: { id: "v1", youtubeVideoId: "JIN5TtemxHA", channelId: "UC_video_owner", madeForKids: false },
      campaign: { kidsContent: false },
    });
    subscriptionCheck = { outcome: "NOT_VERIFIED", available: true, satisfied: false };
    metadataThrows = true;

    await verify();

    // The definitive "no" still stands — the lookup failing does not erase it — but
    // nothing was fabricated in either direction.
    expect(taskWrites["t-sub"]).toMatchObject({ state: "FAILED" });
    expect(campaignUpdates).toEqual([]);
  });

  it("an unanswerable OPTIONAL task is skipped, not failed", async () => {
    reset({
      tasks: [{ id: "t-comment", type: "COMMENT_VIDEO", required: false, state: "PENDING", method: "UNVERIFIED" }],
    });

    await verify();

    expect(taskWrites["t-comment"]).toMatchObject({ state: "SKIPPED" });
  });
});

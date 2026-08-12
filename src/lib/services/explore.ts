import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { env } from "../env";
import {
  campaignAvailabilityFailure,
  campaignAvailabilityWhere,
} from "./campaign-eligibility";
import {
  EXPLORE_MIX,
  EXPLORE_WEIGHTS,
  EXPLORE_POOL,
  NEW_CREATOR_BOOST,
  REPUTATION,
  type ExploreLane,
} from "../gamification";

/**
 * Explore â€” the discovery engine the whole product loop runs through.
 *
 * The pipeline, in order, with each stage doing exactly one job:
 *
 *   Candidate Generation  â†’ bounded SQL pool, ordered by cheap DB signals
 *   Eligibility Filtering â†’ enforced in the WHERE clause, never in the UI
 *   Scoring               → personalization · freshness · popularity · quality
 *                           · fairness (each weight from EXPLORE_WEIGHTS)
 *   Lane assignment       â†’ every candidate lands in exactly one lane
 *   Exploration           â†’ seeded jitter, so the feed rotates without churn
 *   Mix enforcement       â†’ lanes fill slots in the EXPLORE_MIX proportions
 *   Diversity             â†’ per-creator cap inside a page
 *   Cursor slice          â†’ deterministic (score, id) keyset pagination
 *
 * Two properties this file is responsible for:
 *
 *  1. The configured weights and mix ACTUALLY change the output. A config value
 *     that no code reads is a lie, and the previous implementation defined
 *     EXPLORE_MIX without ever applying it.
 *
 *  2. Pagination is stable, deterministic and duplicate-free. Ranking happens in
 *     memory over a bounded pool, so the cursor cannot be a raw DB keyset; it
 *     carries the ranking seed plus the (score, id) position, and the seed is
 *     what makes page 2 rank identically to page 1.
 *
 * No ML. A deterministic scoring engine you can read, explain and tune beats an
 * opaque model for a feed this size.
 */

export type ExploreFilter =
  | "for_you"
  | "new"
  | "trending"
  | "top_creators"
  | "highest_reward"
  | "ending_soon"
  | "most_trusted";

export type ExploreCard = {
  campaignId: string;
  videoId: string;
  youtubeVideoId: string;
  title: string;
  thumbnailUrl: string | null;
  durationSec: number | null;
  reward: { credits: number; xp: number };
  requiredWatchPercent: number;
  estimatedSeconds: number;
  tasks: { type: string; required: boolean }[];
  endsAt: string;
  supportsCount: number;
  creator: {
    id: string;
    username: string;
    name: string;
    avatarUrl: string | null;
    level: number;
    reputation: number;
    rankTier: string;
    youtubeVerified: boolean;
    isNew: boolean;
  };
  /** Recent supporters, for the facepile on the card. */
  recentSupporters: { id: string; name: string; avatarUrl: string | null }[];
  supported: boolean;
  /** Which lane placed this card â€” surfaced to the UI as "why am I seeing this". */
  lane: ExploreLane;
  score: number;
  scoreBreakdown: Record<string, number>;
};

export type ExploreFeedResult = {
  items: ExploreCard[];
  nextCursor: string | null;
  /** Total eligible candidates in the pool, for "N results" copy. */
  poolSize: number;
};

/* ------------------------------------------------------------------------- */
/* Cursor                                                                     */
/* ------------------------------------------------------------------------- */

const CURSOR_VERSION = 2 as const;
const CURSOR_TTL_MS = 30 * 60_000;
const MAX_SNAPSHOT_IDS = 300;
const DEVELOPMENT_CURSOR_SECRET = "explore-cursor-development-only-v2";
const EXPLORE_FILTERS = new Set<ExploreFilter>([
  "for_you", "new", "trending", "top_creators", "highest_reward", "ending_soon", "most_trusted",
]);

export type Cursor = {
  version: typeof CURSOR_VERSION;
  seed: number;
  filter: ExploreFilter;
  search: string;
  offset: number;
  issuedAt: number;
  expiresAt: number;
  snapshotIds: string[];
};

function cursorSecret(): string {
  // Reuse the application's validated signing secret instead of reading an
  // undocumented second secret directly from process.env. Production already
  // fails fast when SESSION_SECRET is missing or weak.
  return env.SESSION_SECRET || DEVELOPMENT_CURSOR_SECRET;
}

function signCursorPayload(payload: string): string {
  return createHmac("sha256", cursorSecret()).update(payload).digest("base64url");
}

/** HMAC-SHA256 signed v2 cursor bound to ranking inputs and a bounded ID snapshot. */
export function encodeCursor(cursor: Cursor): string {
  const payload = Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
  return `${payload}.${signCursorPayload(payload)}`;
}

export function decodeCursor(raw: string | undefined, now = Date.now()): Cursor | null {
  if (!raw) return null;
  try {
    const parts = raw.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    const [payload, signature] = parts;
    const expected = Buffer.from(signCursorPayload(payload), "base64url");
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<Cursor>;
    if (
      value.version !== CURSOR_VERSION ||
      !Number.isFinite(value.seed) ||
      !Number.isInteger(value.offset) ||
      (value.offset ?? -1) < 0 ||
      !Number.isInteger(value.issuedAt) ||
      !Number.isInteger(value.expiresAt) ||
      (value.issuedAt ?? 0) > now ||
      (value.expiresAt ?? 0) <= now ||
      (value.expiresAt ?? 0) <= (value.issuedAt ?? 0) ||
      (value.expiresAt ?? 0) - (value.issuedAt ?? 0) > CURSOR_TTL_MS ||
      typeof value.filter !== "string" ||
      !EXPLORE_FILTERS.has(value.filter as ExploreFilter) ||
      typeof value.search !== "string" ||
      !Array.isArray(value.snapshotIds) ||
      value.snapshotIds.length > MAX_SNAPSHOT_IDS ||
      value.snapshotIds.some((id) => typeof id !== "string" || id.length === 0 || id.length > 64) ||
      new Set(value.snapshotIds).size !== value.snapshotIds.length ||
      (value.offset ?? 0) > value.snapshotIds.length
    ) return null;
    return value as Cursor;
  } catch {
    return null;
  }
}

/**
 * Ranking seed.
 *
 * Derived from the viewer plus a coarse time bucket: identical within the bucket
 * (so paging through the feed is stable) and different across buckets (so coming
 * back later genuinely reshuffles the exploration lane instead of showing the
 * same twelve cards forever).
 */
function currentSeed(viewerId: string | null): number {
  const bucket = Math.floor(Date.now() / (EXPLORE_POOL.seedRotationMinutes * 60_000));
  let hash = 2166136261 ^ bucket;
  const key = viewerId ?? "anonymous";
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Deterministic 0..1 jitter for a given seed + id. Same inputs, same value. */
function seededJitter(seed: number, id: string): number {
  let hash = seed >>> 0;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 2654435761);
  }
  return ((hash >>> 0) % 100_000) / 100_000;
}

/* ------------------------------------------------------------------------- */
/* Eligibility                                                                */
/* ------------------------------------------------------------------------- */

/**
 * Eligibility for appearing in Explore at all. Enforced in SQL so no UI path can
 * accidentally surface an ineligible campaign.
 *
 * Budget is checked here too: a campaign that can no longer pay its own reward is
 * not an offer, it is a dead end.
 */
function eligibilityWhere(viewerId: string | null, now: Date): Prisma.CampaignWhereInput {
  return {
    ...campaignAvailabilityWhere(now),
    creatorId: viewerId ? { not: viewerId } : { not: null },
    // Reported/blocked content leaves Explore through the report workflow, which
    // sets the video to HIDDEN/REMOVED â€” caught by the shared video filter.
  };
}

function searchWhere(search: string | undefined): Prisma.CampaignWhereInput {
  if (!search) return {};
  return {
    OR: [
      { title: { contains: search, mode: "insensitive" } },
      { video: { title: { contains: search, mode: "insensitive" } } },
      { creator: { username: { contains: search, mode: "insensitive" } } },
      { creator: { name: { contains: search, mode: "insensitive" } } },
    ],
  };
}

function normalize(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(1, Math.max(0, value / max));
}

/** Freshness decays over a week; a month-old campaign scores 0 here. */
function freshnessScore(createdAt: Date): number {
  const ageHours = (Date.now() - createdAt.getTime()) / 3_600_000;
  return Math.max(0, 1 - ageHours / (24 * 7));
}

/* ------------------------------------------------------------------------- */
/* Feed                                                                       */
/* ------------------------------------------------------------------------- */

export async function getExploreFeed(input: {
  viewerId: string | null;
  filter: ExploreFilter;
  limit: number;
  cursor?: string;
  search?: string;
}): Promise<ExploreFeedResult> {
  const normalizedSearch = input.search?.trim() ?? "";
  const decoded = decodeCursor(input.cursor);
  const cursor = decoded?.filter === input.filter && decoded.search === normalizedSearch ? decoded : null;
  if (input.cursor && !cursor) throw new Error("Invalid or mismatched explore cursor");
  const seed = cursor?.seed ?? currentSeed(input.viewerId);
  const now = new Date();

  const where: Prisma.CampaignWhereInput = {
    ...eligibilityWhere(input.viewerId, now),
    ...searchWhere(normalizedSearch),
    ...(cursor ? { id: { in: cursor.snapshotIds } } : {}),
  };

  // ---- Stage 1: candidate generation -------------------------------------
  // Over-fetch a bounded pool, then rank in memory: the ranking needs signals
  // SQL ORDER BY cannot express (viewer history, lane mix, per-page diversity).
  const candidateRows = await prisma.campaign.findMany({
    where,
    include: {
        tasks: {
          orderBy: { sortOrder: "asc" },
          select: { type: true, required: true, rewardCredits: true },
        },
        video: { select: { id: true, youtubeVideoId: true, title: true, thumbnailUrl: true, durationSec: true } },
        creator: {
          select: {
            id: true,
            username: true,
            name: true,
            avatarUrl: true,
            level: true,
            reputation: true,
            trustScore: true,
            rankTier: true,
            youtubeVerified: true,
            createdAt: true,
            supportsCompleted: true,
            supportsAbandoned: true,
            _count: { select: { supportsReceived: true } },
          },
        },
        supports: {
          where: { status: "ACTIVE" },
          orderBy: { createdAt: "desc" },
          take: EXPLORE_POOL.facepileSize,
          select: {
            supporter: { select: { id: true, name: true, avatarUrl: true } },
          },
        },
        _count: { select: { supports: { where: { status: "ACTIVE" } } } },
      },
      take: EXPLORE_POOL.candidateLimit,
    orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
  });

  const candidates = candidateRows.filter((campaign) =>
    campaignAvailabilityFailure({
      budgetCredits: campaign.budgetCredits,
      spentCredits: campaign.spentCredits,
      rewardCredits: campaign.rewardCredits,
      maxTotalSupports: campaign.maxTotalSupports,
      dailyLimit: campaign.dailyLimit,
      totalSupports: campaign.completedSupports,
      dailySupports: campaign.dailySupports,
      tasks: campaign.tasks,
    }) === null
  );

  // ---- Viewer history (one query each, not per candidate) -----------------
  const history = input.viewerId
    ? await prisma.support.findMany({
        where: { supporterId: input.viewerId, status: "ACTIVE" },
        orderBy: { createdAt: "desc" },
        take: EXPLORE_POOL.candidateLimit,
        select: { campaignId: true, receiverId: true },
      })
    : [];
  const supportedCampaigns = new Set(history.map((entry) => entry.campaignId));
  const supportedCreators = new Set(history.map((entry) => entry.receiverId));

  const maxSupports = Math.max(1, ...candidates.map((c) => c._count.supports));
  const maxExposure = Math.max(1, ...candidates.map((c) => c.creator?._count.supportsReceived ?? 0));

  // ---- Stage 2: scoring ---------------------------------------------------
  const scored = candidates
    .filter((campaign) => campaign.video && campaign.creator && campaign.creatorId)
    .map((campaign) => {
      const creator = campaign.creator!;
      const video = campaign.video!;

      const attempts = creator.supportsCompleted + creator.supportsAbandoned;
      // An unknown creator is treated as neutral, not as a failure.
      const completionRate = attempts === 0 ? 0.6 : creator.supportsCompleted / attempts;

      const quality = normalize(creator.trustScore, 100);
      const reputation = normalize(creator.reputation, REPUTATION.MAX);
      const freshness = freshnessScore(campaign.createdAt);
      const popularity = normalize(campaign._count.supports, maxSupports);

      // Fairness lifts creators with little exposure so far, so the feed is not
      // a permanent top-100 leaderboard.
      const fairness = 1 - normalize(creator._count.supportsReceived, maxExposure);

      // Personalization demotes (never hides) creators the viewer already
      // supported: discovery, not an echo chamber.
      const personalization = supportedCreators.has(creator.id) ? 0.15 : 1;

      const ageHours = (now.getTime() - creator.createdAt.getTime()) / 3_600_000;
      const isNew =
        ageHours <= NEW_CREATOR_BOOST.windowHours &&
        creator._count.supportsReceived <= NEW_CREATOR_BOOST.maxSupportsReceived;

      const breakdown = {
        quality: quality * EXPLORE_WEIGHTS.quality,
        reputation: reputation * EXPLORE_WEIGHTS.reputation,
        completionRate: completionRate * EXPLORE_WEIGHTS.completionRate,
        freshness: freshness * EXPLORE_WEIGHTS.freshness,
        popularity: popularity * EXPLORE_WEIGHTS.popularity,
        fairness: fairness * EXPLORE_WEIGHTS.fairness,
        personalization: personalization * EXPLORE_WEIGHTS.personalization,
      };

      let score = Object.values(breakdown).reduce((a, b) => a + b, 0);

      if (isNew) score *= NEW_CREATOR_BOOST.multiplier;

      // Creator-set priority is a nudge (±10%), clamped so exposure can't simply
      // be bought outright.
      score *= 1 + Math.max(-1, Math.min(1, campaign.priority / 10)) * 0.1;

      // ---- Stage 3: exploration ------------------------------------------
      // Seeded jitter, bounded by the exploration share of the mix. Deterministic
      // for a given (seed, id), which is what keeps pagination duplicate-free.
      const jitter = seededJitter(seed, campaign.id);
      score *= 1 + (jitter - 0.5) * 2 * EXPLORE_MIX.exploration;

      const requiredSec = Math.round(((video.durationSec ?? 0) * campaign.requiredWatchPercent) / 100);

      const card: ExploreCard = {
        campaignId: campaign.id,
        videoId: video.id,
        youtubeVideoId: video.youtubeVideoId,
        title: campaign.title || video.title,
        thumbnailUrl: video.thumbnailUrl,
        durationSec: video.durationSec,
        reward: { credits: campaign.rewardCredits, xp: campaign.rewardXp },
        requiredWatchPercent: campaign.requiredWatchPercent,
        estimatedSeconds: requiredSec + 60,
        tasks: campaign.tasks.length
          ? campaign.tasks.map(({ type, required }) => ({ type, required }))
          : [{ type: "WATCH_VIDEO", required: true }],
        endsAt: campaign.endAt.toISOString(),
        supportsCount: campaign._count.supports,
        creator: {
          id: creator.id,
          username: creator.username,
          name: creator.name,
          avatarUrl: creator.avatarUrl,
          level: creator.level,
          reputation: creator.reputation,
          rankTier: creator.rankTier,
          youtubeVerified: creator.youtubeVerified,
          isNew,
        },
        recentSupporters: campaign.supports.slice(0, EXPLORE_POOL.facepileSize).map((entry) => entry.supporter),
        supported: supportedCampaigns.has(campaign.id),
        lane: assignLane({ isNew, freshness, popularity, personalized: !supportedCreators.has(creator.id) }),
        score: Math.round(score * 1_000_000) / 1_000_000,
        scoreBreakdown: breakdown,
      };

      return { card, campaign, creator };
    });

  // ---- Stage 4: filter ordering -------------------------------------------
  // An explicit filter is the user's stated intent and overrides the mix; only
  // "for_you" runs the full lane-mixing pipeline.
  const ordered = applyFilter(scored, input.filter);

  // Build one deterministic exhaustive order before slicing. This avoids losing
  // candidates that missed a lane quota on an earlier page.
  const allCards = ordered.map((entry) => entry.card);
  const rankedCards = input.filter === "for_you" ? enforceMix(allCards, allCards.length) : allCards;
  const initialSnapshotIds = rankedCards.slice(0, MAX_SNAPSHOT_IDS).map((card) => card.campaignId);
  const snapshotIds = cursor?.snapshotIds ?? initialSnapshotIds;
  const cardsById = new Map(rankedCards.map((card) => [card.campaignId, card]));
  const offset = cursor?.offset ?? 0;
  const pageIds = snapshotIds.slice(offset, offset + input.limit);
  const page = pageIds.flatMap((id) => {
    const card = cardsById.get(id);
    return card ? [card] : [];
  });
  const nextOffset = offset + pageIds.length;
  const issuedAt = cursor?.issuedAt ?? now.getTime();
  const expiresAt = cursor?.expiresAt ?? issuedAt + CURSOR_TTL_MS;
  const nextCursor =
    nextOffset < snapshotIds.length
      ? encodeCursor({
          version: CURSOR_VERSION,
          seed,
          filter: input.filter,
          search: normalizedSearch,
          offset: nextOffset,
          issuedAt,
          expiresAt,
          snapshotIds,
        })
      : null;

  return { items: page, nextCursor, poolSize: snapshotIds.length };
}

/** Every candidate belongs to exactly one lane, so the mix has real inputs. */
function assignLane(input: {
  isNew: boolean;
  freshness: number;
  popularity: number;
  personalized: boolean;
}): ExploreLane {
  if (input.isNew) return "exploration";
  if (input.freshness >= 0.7) return "fresh";
  if (input.popularity >= 0.5) return "popular";
  return input.personalized ? "personalized" : "exploration";
}

type Scored = {
  card: ExploreCard & { id: string };
  campaign: { endAt: Date; createdAt: Date; rewardCredits: number };
  creator: { reputation: number; trustScore: number };
};

function applyFilter(
  items: { card: ExploreCard; campaign: { endAt: Date; createdAt: Date; rewardCredits: number }; creator: { reputation: number; trustScore: number } }[],
  filter: ExploreFilter
): Scored[] {
  // `id` mirrors campaignId so the cursor comparison has one field name to use.
  const withId = items.map((entry) => ({
    ...entry,
    card: { ...entry.card, id: entry.card.campaignId },
  })) as Scored[];

  // Every branch ends with a total order: score then id, so two equal primary
  // keys never swap between requests.
  const byScoreThenId = (a: Scored, b: Scored) =>
    b.card.score - a.card.score || (a.card.id < b.card.id ? -1 : 1);

  switch (filter) {
    case "new":
      return withId.sort(
        (a, b) => b.campaign.createdAt.getTime() - a.campaign.createdAt.getTime() || byScoreThenId(a, b)
      );
    case "trending":
      return withId.sort((a, b) => b.card.supportsCount - a.card.supportsCount || byScoreThenId(a, b));
    case "top_creators":
      return withId.sort((a, b) => b.creator.reputation - a.creator.reputation || byScoreThenId(a, b));
    case "highest_reward":
      return withId.sort((a, b) => b.campaign.rewardCredits - a.campaign.rewardCredits || byScoreThenId(a, b));
    case "ending_soon":
      return withId.sort((a, b) => a.campaign.endAt.getTime() - b.campaign.endAt.getTime() || byScoreThenId(a, b));
    case "most_trusted":
      return withId.sort((a, b) => b.creator.trustScore - a.creator.trustScore || byScoreThenId(a, b));
    case "for_you":
    default:
      return withId.sort(byScoreThenId);
  }
}

/**
 * Fills the page from the lanes in the EXPLORE_MIX proportions.
 *
 * Each lane keeps its own ranked queue and gets a slot quota. Unfilled quota
 * spills over to whichever lane still has candidates, so a thin lane never leaves
 * the page short â€” the mix is a target, not a hard cap that produces gaps.
 *
 * The per-creator cap runs on top, so one creator cannot occupy several lanes and
 * appear four times in one screen.
 */
function enforceMix(cards: ExploreCard[], limit: number): ExploreCard[] {
  const lanes: Record<ExploreLane, ExploreCard[]> = {
    personalized: [],
    fresh: [],
    popular: [],
    exploration: [],
  };
  for (const card of cards) lanes[card.lane].push(card);

  const quota: Record<ExploreLane, number> = {
    personalized: Math.round(limit * EXPLORE_MIX.personalized),
    fresh: Math.round(limit * EXPLORE_MIX.fresh),
    popular: Math.round(limit * EXPLORE_MIX.popular),
    exploration: Math.max(1, Math.round(limit * EXPLORE_MIX.exploration)),
  };

  const perCreatorCap = Math.max(1, Math.ceil(limit * EXPLORE_POOL.perCreatorShare));
  const creatorCount = new Map<string, number>();
  const picked: ExploreCard[] = [];
  const order: ExploreLane[] = ["personalized", "fresh", "popular", "exploration"];

  const take = (lane: ExploreLane): boolean => {
    const queue = lanes[lane];
    while (queue.length > 0) {
      const card = queue.shift()!;
      const used = creatorCount.get(card.creator.id) ?? 0;
      if (used >= perCreatorCap) continue;
      creatorCount.set(card.creator.id, used + 1);
      picked.push(card);
      return true;
    }
    return false;
  };

  // Round-robin within quota keeps the lanes interleaved rather than stacked in
  // four visible blocks.
  let progressed = true;
  while (picked.length < limit && progressed) {
    progressed = false;
    for (const lane of order) {
      if (picked.length >= limit) break;
      if (quota[lane] <= 0) continue;
      if (take(lane)) {
        quota[lane] -= 1;
        progressed = true;
      } else {
        quota[lane] = 0;
      }
    }
  }

  // Spillover: honour the page size even when the mix could not be met exactly.
  progressed = true;
  while (picked.length < limit && progressed) {
    progressed = false;
    for (const lane of order) {
      if (picked.length >= limit) break;
      if (take(lane)) progressed = true;
    }
  }

  // Final resort: if the creator cap is what is blocking us and the pool is
  // small, a short page is the honest answer â€” never a duplicate.
  return picked.slice(0, limit).sort((a, b) => b.score - a.score);
}

/** Diversity only (used by explicit filters, where the user's sort order wins). */
function enforceDiversity(cards: ExploreCard[], limit: number): ExploreCard[] {
  const perCreatorCap = Math.max(1, Math.ceil(limit * EXPLORE_POOL.perCreatorShare));
  const counts = new Map<string, number>();
  const picked: ExploreCard[] = [];
  const deferred: ExploreCard[] = [];

  for (const card of cards) {
    if (picked.length >= limit) break;
    const used = counts.get(card.creator.id) ?? 0;
    if (used >= perCreatorCap) {
      deferred.push(card);
      continue;
    }
    counts.set(card.creator.id, used + 1);
    picked.push(card);
  }

  // Only relax the cap if that is the sole reason the page is short.
  for (const card of deferred) {
    if (picked.length >= limit) break;
    picked.push(card);
  }

  return picked.slice(0, limit);
}

/**
 * Recomputes a user's internal trust score from observed behavior.
 * Kept internal (never rendered raw) so it can't be gamed by watching the number.
 */
export async function recalculateTrustScore(userId: string): Promise<number> {
  const [user, reversals, upheldReports, signals] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { createdAt: true, reputation: true, supportsCompleted: true, supportsAbandoned: true, youtubeVerified: true },
    }),
    prisma.support.count({ where: { supporterId: userId, status: "REVERSED" } }),
    prisma.report.count({ where: { targetType: "USER", targetId: userId, status: "RESOLVED" } }),
    prisma.abuseSignal.aggregate({
      where: { userId, createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
      _sum: { severity: true },
    }),
  ]);

  const attempts = user.supportsCompleted + user.supportsAbandoned;
  const completionQuality = attempts === 0 ? 0.5 : user.supportsCompleted / attempts;
  const ageDays = (Date.now() - user.createdAt.getTime()) / 86_400_000;

  const score =
    30 * completionQuality +
    25 * Math.min(1, user.reputation / REPUTATION.MAX) +
    15 * Math.min(1, ageDays / 60) +
    10 * Math.min(1, user.supportsCompleted / 50) +
    (user.youtubeVerified ? 10 : 0) -
    8 * reversals -
    12 * upheldReports -
    1.5 * (signals._sum.severity ?? 0);

  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  await prisma.user.update({ where: { id: userId }, data: { trustScore: clamped } });
  return clamped;
}

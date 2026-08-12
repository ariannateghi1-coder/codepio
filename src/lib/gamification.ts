/**
 * Product economy configuration.
 *
 * Four deliberately separate concepts (see prisma/schema.prisma header):
 *   credits    — spendable economy
 *   xp/points  — progression, drives level
 *   reputation — trust/quality, drives Explore exposure
 *   rank tier  — competitive position, derived from reputation + activity
 *
 * Everything here is data, not logic, so tuning the economy never means editing
 * business rules. No file outside this module may hardcode a reward number.
 */

import type { RankTier, TaskType } from "@prisma/client";

/** Default per-task rewards. A campaign may override them per task. */
export const TASK_REWARDS: Record<TaskType, { credits: number; xp: number }> = {
  WATCH_VIDEO: { credits: 5, xp: 12 },
  SUBSCRIBE_CHANNEL: { credits: 3, xp: 8 },
  LIKE_VIDEO: { credits: 2, xp: 5 },
  COMMENT_VIDEO: { credits: 1, xp: 3 },
};

export const REWARDS = {
  /** Paid to the supporter when a session completes with all required tasks. */
  SUPPORT_COMPLETED: { credits: 10, xp: 25 },
  /** Paid to the creator when they receive a verified support. */
  SUPPORT_RECEIVED: { credits: 3, xp: 10 },
  /** Extra for a genuine two-way exchange (first time for a pair only). */
  MUTUAL_BONUS: { credits: 4, xp: 10 },
  /** Referral payout, released on the referred user's first verified support. */
  REFERRAL: { credits: 20, xp: 40 },
  /** Streak milestones, keyed by consecutive active days. */
  STREAK: {
    3: { credits: 3, xp: 10 },
    7: { credits: 8, xp: 30 },
    14: { credits: 18, xp: 70 },
    30: { credits: 40, xp: 150 },
  } as Record<number, { credits: number; xp: number }>,
} as const;

/**
 * Anti-farming: repeat support for the SAME pair pays progressively less.
 * Index = how many times this supporter has already supported this creator.
 * Beyond the table, the last multiplier applies.
 */
export const PAIR_DIMINISHING_MULTIPLIERS = [1, 0.6, 0.35, 0.2, 0.1] as const;

export function pairRewardMultiplier(previousSupportsForPair: number): number {
  const index = Math.min(previousSupportsForPair, PAIR_DIMINISHING_MULTIPLIERS.length - 1);
  return PAIR_DIMINISHING_MULTIPLIERS[index];
}

/** Cooldown before the same pair can be rewarded again. */
export const PAIR_COOLDOWN_HOURS = 24;

/** XP thresholds → level. Level is derived, never stored as truth. */
export const LEVELS = [
  { level: 1, xp: 0 },
  { level: 2, xp: 100 },
  { level: 3, xp: 250 },
  { level: 4, xp: 500 },
  { level: 5, xp: 1000 },
  { level: 6, xp: 2000 },
  { level: 7, xp: 3500 },
  { level: 8, xp: 5000 },
  { level: 9, xp: 8000 },
  { level: 10, xp: 12000 },
] as const;

export function calculateLevel(xp: number): number {
  let level = 1;
  for (const entry of LEVELS) if (xp >= entry.xp) level = entry.level;
  return level;
}

export function nextLevelProgress(xp: number) {
  const current = calculateLevel(xp);
  const currentThreshold = LEVELS.find((l) => l.level === current)?.xp ?? 0;
  const next = LEVELS.find((l) => l.level === current + 1) ?? null;
  if (!next) return { current, next: null, progress: 100, nextXp: null, currentXp: xp };
  const span = next.xp - currentThreshold;
  const progress = span <= 0 ? 100 : Math.min(100, Math.max(0, Math.round(((xp - currentThreshold) / span) * 100)));
  return { current, next: next.level, progress, nextXp: next.xp, currentXp: xp };
}

/** Reputation bounds. Everyone starts mid-scale and earns trust from behavior. */
export const REPUTATION = {
  MIN: 0,
  MAX: 1000,
  START: 100,
  /** Deltas per event type. Reversals cost more than a completion earns. */
  SUPPORT_VERIFIED: 4,
  SUPPORT_PARTIAL: 0,
  SUPPORT_REVERSED: -25,
  ABUSE_SIGNAL: -10,
  REPORT_UPHELD: -40,
  REPORT_DISMISSED: 2,
  CAMPAIGN_COMPLETED: 6,
  CHANNEL_VERIFIED: 15,
} as const;

export const RANK_TIERS: { tier: RankTier; label: string; minReputation: number; minSupports: number }[] = [
  { tier: "BRONZE", label: "برنز", minReputation: 0, minSupports: 0 },
  { tier: "SILVER", label: "نقره‌ای", minReputation: 150, minSupports: 5 },
  { tier: "GOLD", label: "طلایی", minReputation: 260, minSupports: 20 },
  { tier: "PLATINUM", label: "پلاتینیوم", minReputation: 400, minSupports: 50 },
  { tier: "DIAMOND", label: "الماس", minReputation: 600, minSupports: 120 },
  { tier: "ELITE", label: "نخبه", minReputation: 800, minSupports: 250 },
];

export function calculateRankTier(reputation: number, supportsCompleted: number): RankTier {
  let tier: RankTier = "BRONZE";
  for (const entry of RANK_TIERS) {
    if (reputation >= entry.minReputation && supportsCompleted >= entry.minSupports) tier = entry.tier;
  }
  return tier;
}

export function rankTierLabel(tier: RankTier): string {
  return RANK_TIERS.find((t) => t.tier === tier)?.label ?? "برنز";
}

/**
 * Explore ranking weights. Configuration-driven on purpose: the mix is a product
 * decision that gets tuned, and "more credits = always first" would let heavy
 * farmers dominate the feed.
 *
 * Every key here is read by src/lib/services/explore.ts. A weight nobody reads is
 * a lie about how the feed works, so the test suite asserts the set of keys used
 * in scoring matches this object exactly.
 */
export const EXPLORE_WEIGHTS = {
  quality: 0.24,
  reputation: 0.16,
  completionRate: 0.12,
  freshness: 0.16,
  popularity: 0.12,
  fairness: 0.1,
  personalization: 0.1,
} as const;

/**
 * Feed composition. Each candidate is assigned exactly one lane and the page is
 * filled in these proportions, with spillover so a thin lane never leaves gaps.
 * `exploration` doubles as the amplitude of the seeded score jitter.
 */
export const EXPLORE_MIX = {
  personalized: 0.4,
  fresh: 0.3,
  popular: 0.2,
  exploration: 0.1,
} as const;

export type ExploreLane = keyof typeof EXPLORE_MIX;

/** Candidate pool and per-page shaping limits. */
export const EXPLORE_POOL = {
  /** Rows pulled from SQL before in-memory ranking. Bounded on purpose. */
  candidateLimit: 300,
  /** Max share of one page a single creator may occupy. */
  perCreatorShare: 0.2,
  /** How long a ranking seed stays stable; also how often the feed reshuffles. */
  seedRotationMinutes: 30,
  /** Faces shown in a card's supporter facepile. */
  facepileSize: 4,
} as const;

/** New accounts get a temporary boost so a cold start isn't invisible forever. */
export const NEW_CREATOR_BOOST = {
  windowHours: 72,
  maxSupportsReceived: 5,
  multiplier: 1.35,
} as const;

export const BADGE_DEFINITIONS = [
  { code: "FIRST_SUPPORT", name: "اولین حمایت", description: "اولین حمایت تأییدشده خود را کامل کردید.", icon: "❤️", credits: 2, xp: 10 },
  { code: "SUPPORTS_10", name: "حامی فعال", description: "۱۰ حمایت تأییدشده انجام دادید.", icon: "🤝", credits: 5, xp: 25 },
  { code: "SUPPORTS_50", name: "همراه جامعه", description: "۵۰ حمایت تأییدشده انجام دادید.", icon: "🌱", credits: 15, xp: 80 },
  { code: "SUPPORTS_100", name: "قهرمان جامعه", description: "۱۰۰ حمایت تأییدشده انجام دادید.", icon: "🏆", credits: 40, xp: 200 },
  { code: "TRUSTED_SUPPORTER", name: "حامی مورد اعتماد", description: "اعتبار بالا با نرخ تکمیل عالی.", icon: "🛡️", credits: 20, xp: 100 },
  { code: "PERFECT_WEEK", name: "هفته بی‌نقص", description: "۷ روز فعالیت پیوسته.", icon: "🔥", credits: 10, xp: 50 },
  { code: "RISING_CREATOR", name: "سازنده در حال رشد", description: "۲۵ حمایت تأییدشده دریافت کردید.", icon: "🚀", credits: 15, xp: 75 },
  { code: "COMMUNITY_BUILDER", name: "سازنده جامعه", description: "۱۰ حمایت متقابل واقعی.", icon: "🌍", credits: 12, xp: 60 },
  { code: "VERIFIED_CREATOR", name: "کانال تأییدشده", description: "مالکیت کانال یوتیوب را تأیید کردید.", icon: "✅", credits: 10, xp: 40 },
] as const;

export type BadgeCode = (typeof BADGE_DEFINITIONS)[number]["code"];

export type BadgeMetric =
  | "SUPPORTS_COMPLETED"
  | "SUPPORTS_RECEIVED"
  | "MUTUAL_SUPPORTS"
  | "STREAK_DAYS"
  | "REPUTATION"
  | "CHANNEL_VERIFIED";

/**
 * Machine-readable requirements, kept apart from display copy so tuning a
 * threshold can't accidentally rewrite user-facing text.
 * `minCompletionRate` is an additional gate for quality-based badges.
 */
export const BADGE_REQUIREMENTS: Record<BadgeCode, { metric: BadgeMetric; threshold: number; minCompletionRate?: number }> = {
  FIRST_SUPPORT: { metric: "SUPPORTS_COMPLETED", threshold: 1 },
  SUPPORTS_10: { metric: "SUPPORTS_COMPLETED", threshold: 10 },
  SUPPORTS_50: { metric: "SUPPORTS_COMPLETED", threshold: 50 },
  SUPPORTS_100: { metric: "SUPPORTS_COMPLETED", threshold: 100 },
  TRUSTED_SUPPORTER: { metric: "REPUTATION", threshold: 300, minCompletionRate: 0.85 },
  PERFECT_WEEK: { metric: "STREAK_DAYS", threshold: 7 },
  RISING_CREATOR: { metric: "SUPPORTS_RECEIVED", threshold: 25 },
  COMMUNITY_BUILDER: { metric: "MUTUAL_SUPPORTS", threshold: 10 },
  VERIFIED_CREATOR: { metric: "CHANNEL_VERIFIED", threshold: 1 },
};

/** Watch-verification defaults. */
export const WATCH_RULES = {
  defaultRequiredPercent: 90,
  minRequiredPercent: 50,
  maxRequiredPercent: 100,
  /** Client heartbeat cadence; the server validates the interval it observes. */
  heartbeatSeconds: 10,
  /** Credited progress per heartbeat is capped at this multiple of wall time. */
  maxPlaybackRate: 1.25,
  /** A session must be finished within this window. */
  sessionTtlMinutes: 90,
  /** Missing heartbeats for longer than this marks the session abandoned. */
  staleAfterSeconds: 180,
} as const;

/** Risk thresholds mapping a session's risk score to a reward decision. */
export const RISK_THRESHOLDS = {
  /** At or above: hold the reward for manual review instead of paying instantly. */
  review: 40,
  /** At or above: deny the reward outright. */
  deny: 75,
} as const;

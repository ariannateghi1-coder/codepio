import "server-only";
import type { AbuseSignalType, Prisma } from "@prisma/client";
import { PAIR_COOLDOWN_HOURS, RISK_THRESHOLDS } from "../gamification";

/**
 * Anti-abuse engine.
 *
 * Honest premise: no browser-based system can prove a human watched a video.
 * A determined user can automate a browser, patch the client, or run many
 * accounts. The goal is therefore not "cheating is impossible" but:
 *
 *   make cheating expensive, detectable, and unrewarding.
 *
 * Layers implemented here:
 *   1. Physical impossibility (progress faster than wall-clock, seek jumps).
 *   2. Behavioural velocity (too many supports too fast, identical timings).
 *   3. Graph shape (reciprocal loops, single-pair farming, cluster reuse).
 *   4. Account quality (age, reputation, prior reversals, upheld reports).
 *
 * Output is a 0..100 risk score plus reasons; the reward decision derives from
 * it (instant / pending review / deny) rather than a silent ban.
 */

type Tx = Prisma.TransactionClient;

export type RiskReason = { type: AbuseSignalType; severity: number; note: string };

export type RiskAssessment = {
  score: number;
  reasons: RiskReason[];
  decision: "ALLOW" | "REVIEW" | "DENY";
};

/** Severity (1..10) → contribution to the 0..100 score. */
const SEVERITY_WEIGHT = 8;

export function scoreFromReasons(reasons: RiskReason[]): RiskAssessment {
  const score = Math.min(100, reasons.reduce((sum, r) => sum + r.severity * SEVERITY_WEIGHT, 0));
  const decision = score >= RISK_THRESHOLDS.deny ? "DENY" : score >= RISK_THRESHOLDS.review ? "REVIEW" : "ALLOW";
  return { score, reasons, decision };
}

export type SessionEvidence = {
  /** Wall-clock seconds between session start and completion. */
  elapsedSeconds: number;
  /** Seconds of unique timeline actually covered. */
  watchedSeconds: number;
  requiredSeconds: number;
  seekCount: number;
  heartbeats: number;
  impossibleProgressEvents: number;
  /** Heartbeats refused as replayed or out-of-order. */
  rejectedBeats?: number;
  /** Seconds the client reported the page as hidden/backgrounded. */
  hiddenSeconds?: number;
};

/**
 * Session-level signals, computed from the server's own watch accounting.
 * Pure function: unit-testable, no DB.
 */
export function assessSessionEvidence(evidence: SessionEvidence): RiskReason[] {
  const reasons: RiskReason[] = [];

  // Completed faster than the video could physically have been watched.
  if (evidence.watchedSeconds > evidence.elapsedSeconds + 5) {
    reasons.push({
      type: "IMPOSSIBLE_WATCH_SPEED",
      severity: 10,
      note: `watched ${Math.round(evidence.watchedSeconds)}s within ${Math.round(evidence.elapsedSeconds)}s of wall time`,
    });
  }

  if (evidence.impossibleProgressEvents > 0) {
    reasons.push({
      type: "CLIENT_TAMPERING",
      severity: Math.min(10, 4 + evidence.impossibleProgressEvents),
      note: `${evidence.impossibleProgressEvents} heartbeats reported non-physical progress`,
    });
  }

  // Excessive seeking with just-enough coverage is the classic scrub pattern.
  if (evidence.seekCount >= 8 && evidence.watchedSeconds < evidence.requiredSeconds * 1.05) {
    reasons.push({ type: "SEEK_JUMP_ABUSE", severity: 4, note: `${evidence.seekCount} seeks with minimal coverage` });
  }

  // Far fewer heartbeats than a genuine watch of this length would produce.
  const expectedHeartbeats = Math.floor(evidence.watchedSeconds / 20);
  if (expectedHeartbeats > 3 && evidence.heartbeats < expectedHeartbeats / 2) {
    reasons.push({
      type: "HEARTBEAT_ANOMALY",
      severity: 5,
      note: `${evidence.heartbeats} heartbeats for ${Math.round(evidence.watchedSeconds)}s of credited watch time`,
    });
  }

  // Repeated stale/duplicate sequence numbers. A couple can happen on a flaky
  // connection; a stream of them is a replay attempt.
  const rejected = evidence.rejectedBeats ?? 0;
  if (rejected >= 3) {
    reasons.push({
      type: "HEARTBEAT_REPLAY",
      severity: Math.min(8, 2 + rejected),
      note: `${rejected} heartbeats rejected as replayed or out-of-order`,
    });
  }

  // The tab was hidden for most of the "watch". Advisory: a hostile client can
  // simply not report this, so it lowers trust and never gates the reward alone.
  const hidden = evidence.hiddenSeconds ?? 0;
  if (evidence.watchedSeconds > 0 && hidden > evidence.watchedSeconds * 0.5) {
    reasons.push({
      type: "BACKGROUND_WATCH",
      severity: 3,
      note: `${Math.round(hidden)}s of ${Math.round(evidence.watchedSeconds)}s credited while the page was hidden`,
    });
  }

  return reasons;
}

export type GraphContext = {
  supporterId: string;
  receiverId: string;
  /** Prior supports from this supporter to this receiver. */
  pairSupportCount: number;
  /** Prior supports in the reverse direction. */
  reciprocalCount: number;
  lastPairSupportAt: Date | null;
  /** Supports created by this supporter in the last hour. */
  recentSupportCount: number;
  /** Distinct creators supported in the last 24h. */
  distinctRecentCreators: number;
  /** Total supports by this supporter in the last 24h. */
  dailySupportCount: number;
  supporterAccountAgeHours: number;
  supporterReputation: number;
  supporterReversals: number;
  sharedIpWithReceiver: boolean;
  /** Number of the receiver's currently valid sessions on the same IP. */
  sharedIpActiveSessions?: number;
  /**
   * Size of the closed support ring this pair sits in, beyond the direct pair.
   *
   * Pair counters alone cannot see A→B, B→C, C→A. This is the number of the
   * supporter's own recent supporters who are also people the receiver has
   * recently supported — i.e. the overlap that makes a cycle.
   */
  ringOverlap?: number;
  /** Distinct accounts in the bounded two-hop neighbourhood. */
  clusterMemberCount?: number;
  /** Active edges among those members in the same recent window. */
  clusterEdgeCount?: number;
  /** Highest distinct-neighbour degree inside the recent cluster. */
  clusterMaxDegree?: number;
  /** Age in hours of the newest edge in the cluster. */
  clusterNewestEdgeAgeHours?: number;
  /** Share of the supporter's recent edges that stay inside the cluster. */
  clusterConcentration?: number;
};

/** Graph/velocity/account signals. Pure function. */
export function assessGraph(context: GraphContext): RiskReason[] {
  const reasons: RiskReason[] = [];

  if (context.supporterId === context.receiverId) {
    reasons.push({ type: "SELF_SUPPORT_ATTEMPT", severity: 10, note: "supporter equals receiver" });
  }

  // Tight two-way ping-pong between the same accounts.
  if (context.reciprocalCount >= 2 && context.pairSupportCount >= 2) {
    reasons.push({
      type: "RECIPROCAL_LOOP",
      severity: Math.min(8, 3 + context.reciprocalCount),
      note: `${context.pairSupportCount} given / ${context.reciprocalCount} received with the same account`,
    });
  }

  if (context.pairSupportCount >= 3) {
    reasons.push({ type: "PAIR_FARMING", severity: 4, note: `${context.pairSupportCount} prior supports for this pair` });
  }

  if (context.lastPairSupportAt) {
    const hours = (Date.now() - context.lastPairSupportAt.getTime()) / 3_600_000;
    if (hours < PAIR_COOLDOWN_HOURS) {
      reasons.push({ type: "PAIR_FARMING", severity: 3, note: `pair cooldown active (${hours.toFixed(1)}h < ${PAIR_COOLDOWN_HOURS}h)` });
    }
  }

  if (context.recentSupportCount >= 10) {
    reasons.push({ type: "SUPPORT_VELOCITY", severity: 6, note: `${context.recentSupportCount} supports in the last hour` });
  } else if (context.recentSupportCount >= 6) {
    reasons.push({ type: "SUPPORT_VELOCITY", severity: 3, note: `${context.recentSupportCount} supports in the last hour` });
  }

  // High volume concentrated on very few creators = farming, not discovery.
  if (context.dailySupportCount >= 10 && context.distinctRecentCreators <= 2) {
    reasons.push({
      type: "PAIR_FARMING",
      severity: 5,
      note: `${context.dailySupportCount} daily supports across only ${context.distinctRecentCreators} creators`,
    });
  }

  if (context.supporterAccountAgeHours < 1) {
    reasons.push({ type: "ACCOUNT_TOO_NEW", severity: 3, note: "account younger than one hour" });
  }

  if (context.sharedIpWithReceiver) {
    // A shared IP alone is NOT proof (households, offices, carrier NAT), so it
    // contributes moderately and is never sufficient to deny on its own.
    const active = context.sharedIpActiveSessions ?? 0;
    reasons.push({
      type: "DUPLICATE_DEVICE",
      severity: active > 0 ? 4 : 2,
      note: active > 0
        ? `supporter and receiver share a recent network fingerprint (${active} active session${active === 1 ? "" : "s"})`
        : "supporter and receiver recently shared a network fingerprint",
    });
  }

  if (context.supporterReversals >= 3) {
    reasons.push({ type: "SUPPORT_VELOCITY", severity: 4, note: `${context.supporterReversals} previously reversed supports` });
  }

  if (context.supporterReputation < 40) {
    reasons.push({ type: "SUPPORT_VELOCITY", severity: 3, note: `low reputation (${context.supporterReputation})` });
  }

  // Closed ring: the direct pair looks innocent, but the group trades among
  // itself. Two shared members is coincidence; three or more is a pattern.
  const ring = context.ringOverlap ?? 0;
  if (ring >= 2) {
    reasons.push({
      type: "FARMING_RING",
      severity: Math.min(8, 2 + ring * 2),
      note: `${ring} accounts form a support cycle with this pair`,
    });
  }

  // Dense clusters are advisory unless they are sustained and concentrated.
  // This avoids punishing healthy large communities or one coincidental triangle.
  const members = context.clusterMemberCount ?? 0;
  const edges = context.clusterEdgeCount ?? 0;
  const concentration = context.clusterConcentration ?? 0;
  const possibleEdges = members > 1 ? members * (members - 1) : 0;
  const density = possibleEdges > 0 ? edges / possibleEdges : 0;
  if (members >= 4 && edges >= 8 && density >= 0.35 && concentration >= 0.7) {
    reasons.push({
      type: "FARMING_RING",
      severity: density >= 0.6 && concentration >= 0.85 ? 6 : 4,
      note: `dense support cluster: ${members} members, ${edges} edges, ${Math.round(density * 100)}% density, ${Math.round(concentration * 100)}% concentration`,
    });
  }

  return reasons;
}

/** Loads the graph context for a pair, then scores it. */
export async function assessSupportRisk(
  tx: Tx,
  input: { supporterId: string; receiverId: string; ipHash: string | null }
): Promise<RiskAssessment> {
  const now = Date.now();
  const hourAgo = new Date(now - 3_600_000);
  const dayAgo = new Date(now - 86_400_000);

  const [supporter, pair, reversePair, recentSupportCount, dailySupports, reversals, receiverSessions, graphFeatures] =
    await Promise.all([
      tx.user.findUniqueOrThrow({
        where: { id: input.supporterId },
        select: { createdAt: true, reputation: true },
      }),
      tx.supportPair.findUnique({ where: { supporterId_receiverId: { supporterId: input.supporterId, receiverId: input.receiverId } } }),
      tx.supportPair.findUnique({ where: { supporterId_receiverId: { supporterId: input.receiverId, receiverId: input.supporterId } } }),
      tx.support.count({ where: { supporterId: input.supporterId, createdAt: { gte: hourAgo } } }),
      tx.support.findMany({
        where: { supporterId: input.supporterId, createdAt: { gte: dayAgo } },
        select: { receiverId: true },
      }),
      tx.support.count({ where: { supporterId: input.supporterId, status: "REVERSED" } }),
      input.ipHash
        ? tx.session.count({ where: { userId: input.receiverId, ipHash: input.ipHash } })
        : Promise.resolve(0),
      loadGraphFeatures(tx, input.supporterId, input.receiverId),
    ]);

  const reasons = assessGraph({
    supporterId: input.supporterId,
    receiverId: input.receiverId,
    pairSupportCount: pair?.supportCount ?? 0,
    reciprocalCount: reversePair?.supportCount ?? 0,
    lastPairSupportAt: pair?.lastSupportAt ?? null,
    recentSupportCount,
    distinctRecentCreators: new Set(dailySupports.map((s) => s.receiverId)).size,
    dailySupportCount: dailySupports.length,
    supporterAccountAgeHours: (now - supporter.createdAt.getTime()) / 3_600_000,
    supporterReputation: supporter.reputation,
    supporterReversals: reversals,
    sharedIpWithReceiver: receiverSessions > 0,
    ringOverlap: graphFeatures.ringOverlap,
    clusterMemberCount: graphFeatures.clusterMemberCount,
    clusterEdgeCount: graphFeatures.clusterEdgeCount,
    clusterConcentration: graphFeatures.clusterConcentration,
  });

  return scoreFromReasons(reasons);
}

/**
 * Detects a closed support ring around this pair.
 *
 * A→B / B→A is caught by the pair counters. A→B, B→C, C→A is not: every
 * individual pair looks like a first-time support. This counts the accounts that
 * appear on BOTH sides — people who supported our supporter and were also
 * supported by our receiver — which is exactly the overlap a cycle produces.
 *
 * Bounded to the recent window and a fixed row cap so it stays a cheap query
 * rather than a graph traversal.
 */
async function loadGraphFeatures(tx: Tx, supporterId: string, receiverId: string) {
  const since = new Date(Date.now() - 14 * 86_400_000);
  const LIMIT = 200;
  const ordered = [{ createdAt: "desc" as const }, { id: "asc" as const }];

  const [inbound, outbound, supporterEdges] = await Promise.all([
    tx.support.findMany({
      where: { receiverId: supporterId, status: "ACTIVE", createdAt: { gte: since } },
      select: { supporterId: true },
      orderBy: ordered,
      take: LIMIT,
    }),
    tx.support.findMany({
      where: { supporterId: receiverId, status: "ACTIVE", createdAt: { gte: since } },
      select: { receiverId: true },
      orderBy: ordered,
      take: LIMIT,
    }),
    tx.support.findMany({
      where: { supporterId, status: "ACTIVE", createdAt: { gte: since } },
      select: { receiverId: true },
      orderBy: ordered,
      take: LIMIT,
    }),
  ]);

  const inboundIds = new Set(inbound.map((row) => row.supporterId));
  const outboundIds = new Set(outbound.map((row) => row.receiverId));
  const members = new Set([supporterId, receiverId, ...inboundIds, ...outboundIds]);
  let ringOverlap = 0;
  for (const id of outboundIds) if (id !== supporterId && inboundIds.has(id)) ringOverlap += 1;

  const memberIds = [...members].sort().slice(0, 50);
  const clusterEdges = await tx.support.findMany({
    where: {
      status: "ACTIVE",
      createdAt: { gte: since },
      supporterId: { in: memberIds },
      receiverId: { in: memberIds },
    },
    select: { supporterId: true, receiverId: true },
    orderBy: ordered,
    take: LIMIT,
  });
  const internalSupporterEdges = supporterEdges.filter((edge) => members.has(edge.receiverId)).length;

  return {
    ringOverlap,
    clusterMemberCount: memberIds.length,
    clusterEdgeCount: new Set(clusterEdges.map((edge) => `${edge.supporterId}:${edge.receiverId}`)).size,
    clusterConcentration: supporterEdges.length === 0 ? 0 : internalSupporterEdges / supporterEdges.length,
  };
}

/** Persists signals so moderators can review patterns rather than single events. */
export async function persistAbuseSignals(
  tx: Tx,
  input: { userId: string; sessionId?: string | null; reasons: RiskReason[] }
) {
  if (input.reasons.length === 0) return;
  await tx.abuseSignal.createMany({
    data: input.reasons.map((reason) => ({
      userId: input.userId,
      sessionId: input.sessionId ?? null,
      type: reason.type,
      severity: reason.severity,
      metadata: { note: reason.note },
    })),
  });
}

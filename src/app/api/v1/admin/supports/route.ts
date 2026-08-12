import { prisma } from "@/lib/prisma";
import { parseBody, parseQuery } from "@/lib/api";
import { moderator } from "@/lib/handler";
import { supportReverseSchema } from "@/lib/validators";
import { assertCan } from "@/lib/authz";
import { reverseSupport } from "@/lib/services/support";
import { z } from "zod";

/**
 * Moderation queue for supports.
 *
 * Sessions held at PENDING_REVIEW appear first: the anti-abuse layer holds risky
 * rewards for a human decision instead of silently denying or silently paying.
 *
 * Reversal delegates to the service, which reverses every ledger entry, adjusts
 * reputation, returns the campaign budget and notifies the user — the operation
 * this UI used to perform as a bare status flip.
 */
const listSchema = z.object({
  status: z.enum(["ALL", "ACTIVE", "REVERSED", "PENDING_REVIEW"]).default("ALL"),
  page: z.coerce.number().int().min(1).max(500).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const GET = moderator(
  "admin.supports.list",
  async ({ url }) => {
    const query = parseQuery(url, listSchema);
    const skip = (query.page - 1) * query.limit;

    if (query.status === "PENDING_REVIEW") {
      const [items, total] = await Promise.all([
        prisma.supportSession.findMany({
          where: { rewardState: "PENDING_REVIEW" },
          orderBy: { createdAt: "desc" },
          skip,
          take: query.limit,
          select: {
            id: true,
            state: true,
            riskScore: true,
            riskReasons: true,
            createdAt: true,
            supportId: true,
            supporter: { select: { username: true, name: true, reputation: true, trustScore: true } },
            creator: { select: { username: true, name: true } },
            campaign: { select: { id: true, title: true, rewardCredits: true } },
            watchSession: { select: { accumulatedSec: true, requiredSec: true, seekCount: true, heartbeats: true } },
          },
        }),
        prisma.supportSession.count({ where: { rewardState: "PENDING_REVIEW" } }),
      ]);
      return { mode: "PENDING_REVIEW", items, total, page: query.page, limit: query.limit };
    }

    const where = query.status === "ALL" ? {} : { status: query.status as "ACTIVE" | "REVERSED" };
    const [items, total] = await Promise.all([
      prisma.support.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: query.limit,
        select: {
          id: true,
          status: true,
          mutual: true,
          creditsAwarded: true,
          xpAwarded: true,
          createdAt: true,
          reversedAt: true,
          reversalReason: true,
          supporter: { select: { username: true, name: true, reputation: true } },
          receiver: { select: { username: true, name: true } },
          campaign: { select: { id: true, title: true } },
          session: { select: { id: true, riskScore: true, rewardState: true } },
        },
      }),
      prisma.support.count({ where }),
    ]);

    return { mode: "SUPPORTS", items, total, page: query.page, limit: query.limit };
  },
  { csrf: false }
);

export const POST = moderator(
  "admin.supports.reverse",
  async ({ req, actor }) => {
    assertCan(actor, "support:reverse");
    const data = await parseBody(req, supportReverseSchema);
    const support = await reverseSupport({ supportId: data.supportId, moderatorId: actor.id, reason: data.reason });
    return { support, message: "حمایت برگشت خورد و پاداش آن اصلاح شد." };
  },
  { rateLimit: "adminMutation" }
);

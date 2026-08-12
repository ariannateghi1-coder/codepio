import { prisma } from "@/lib/prisma";
import { parseBody, parseQuery } from "@/lib/api";
import { admin } from "@/lib/handler";
import { assertCan } from "@/lib/authz";
import { NotFoundError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { z } from "zod";

/**
 * Platform-wide campaign administration (any owner), separate from the creator's
 * own campaign endpoints. Requires campaign:manage_any, which only ADMIN and
 * above hold.
 */
const listSchema = z.object({
  status: z.enum(["ALL", "DRAFT", "ACTIVE", "PAUSED", "ENDED"]).default("ALL"),
  page: z.coerce.number().int().min(1).max(500).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const GET = admin(
  "admin.campaigns.list",
  async ({ url, actor }) => {
    assertCan(actor, "campaign:manage_any");
    const query = parseQuery(url, listSchema);
    const where = query.status === "ALL" ? {} : { status: query.status };

    const [items, total] = await Promise.all([
      prisma.campaign.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          id: true,
          title: true,
          status: true,
          startAt: true,
          endAt: true,
          rewardCredits: true,
          budgetCredits: true,
          spentCredits: true,
          requiredWatchPercent: true,
          creator: { select: { username: true, name: true, reputation: true } },
          video: { select: { title: true, youtubeVideoId: true, durationSec: true } },
          _count: { select: { supports: true, sessions: true } },
        },
      }),
      prisma.campaign.count({ where }),
    ]);

    return { items, total, page: query.page, limit: query.limit };
  },
  { csrf: false }
);

const actionSchema = z.object({
  campaignId: z.string().min(10),
  action: z.enum(["PAUSE", "END", "ACTIVATE"]),
  reason: z.string().trim().min(3).max(500),
});

export const POST = admin(
  "admin.campaigns.moderate",
  async ({ req, actor }) => {
    assertCan(actor, "campaign:manage_any");
    const data = await parseBody(req, actionSchema);

    const campaign = await prisma.campaign.findUnique({ where: { id: data.campaignId }, select: { id: true, status: true } });
    if (!campaign) throw new NotFoundError("این کمپین پیدا نشد.");

    const status = data.action === "PAUSE" ? "PAUSED" : data.action === "END" ? "ENDED" : "ACTIVE";
    await prisma.campaign.update({ where: { id: campaign.id }, data: { status } });

    await writeAudit({
      userId: actor.id,
      action: "ADMIN_ACTION",
      entity: "Campaign",
      entityId: campaign.id,
      req,
      metadata: { from: campaign.status, to: status, reason: data.reason },
    });

    return { message: "وضعیت کمپین بروزرسانی شد." };
  },
  { rateLimit: "adminMutation" }
);

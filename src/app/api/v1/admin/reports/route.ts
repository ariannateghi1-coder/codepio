import { prisma } from "@/lib/prisma";
import { parseBody, parseQuery } from "@/lib/api";
import { moderator } from "@/lib/handler";
import { reportResolveSchema } from "@/lib/validators";
import { assertCan } from "@/lib/authz";
import { NotFoundError } from "@/lib/errors";
import { ledgerKey, recordReputation } from "@/lib/services/ledger";
import { REPUTATION } from "@/lib/gamification";
import { writeAudit } from "@/lib/audit";
import { z } from "zod";

/**
 * Report moderation workflow: OPEN → UNDER_REVIEW → RESOLVED / DISMISSED.
 *
 * Resolving a report has real consequences: an upheld report costs the target
 * reputation (through the ledger) and hides the offending content, while a
 * dismissal restores a small amount to the wrongly-reported user. The previous
 * version only changed a status column.
 */
const listSchema = z.object({
  status: z.enum(["ALL", "OPEN", "UNDER_REVIEW", "RESOLVED", "DISMISSED"]).default("OPEN"),
  targetType: z.enum(["ALL", "USER", "VIDEO", "SUPPORT", "CAMPAIGN"]).default("ALL"),
  page: z.coerce.number().int().min(1).max(500).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const GET = moderator(
  "admin.reports.list",
  async ({ url, actor }) => {
    assertCan(actor, "report:review");
    const query = parseQuery(url, listSchema);

    const where = {
      ...(query.status === "ALL" ? {} : { status: query.status }),
      ...(query.targetType === "ALL" ? {} : { targetType: query.targetType }),
    };

    const [items, total, summary] = await Promise.all([
      prisma.report.findMany({
        where,
        orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          id: true,
          targetType: true,
          targetId: true,
          reason: true,
          description: true,
          status: true,
          severity: true,
          resolutionNote: true,
          createdAt: true,
          resolvedAt: true,
          reporter: { select: { username: true, name: true, reputation: true } },
          resolvedBy: { select: { username: true, name: true } },
        },
      }),
      prisma.report.count({ where }),
      prisma.report.groupBy({ by: ["status"], _count: { _all: true } }),
    ]);

    // Target preview, so a moderator can judge without leaving the queue.
    const previews = await Promise.all(items.map((report) => previewTarget(report.targetType, report.targetId)));

    return {
      items: items.map((report, index) => ({ ...report, preview: previews[index] })),
      total,
      page: query.page,
      limit: query.limit,
      summary: Object.fromEntries(summary.map((row) => [row.status, row._count._all])),
    };
  },
  { csrf: false }
);

export const POST = moderator(
  "admin.reports.resolve",
  async ({ req, actor }) => {
    assertCan(actor, "report:review");
    const data = await parseBody(req, reportResolveSchema);

    const report = await prisma.report.findUnique({ where: { id: data.reportId } });
    if (!report) throw new NotFoundError("این گزارش پیدا نشد.");

    await prisma.$transaction(async (tx) => {
      await tx.report.update({
        where: { id: report.id },
        data: {
          status: data.status,
          resolutionNote: data.resolutionNote ?? null,
          resolvedById: actor.id,
          resolvedAt: data.status === "UNDER_REVIEW" ? null : new Date(),
        },
      });

      if (data.status === "RESOLVED") {
        const targetUserId = await resolveTargetUser(report.targetType, report.targetId);
        if (targetUserId) {
          await recordReputation(tx, {
            userId: targetUserId,
            type: "REPORT_UPHELD",
            delta: REPUTATION.REPORT_UPHELD,
            idempotencyKey: ledgerKey(["report-upheld", report.id]),
            reason: data.resolutionNote?.slice(0, 200) ?? report.reason,
          });
        }
        // Hide the offending content so it leaves Explore immediately.
        if (report.targetType === "VIDEO") {
          await tx.video.update({ where: { id: report.targetId }, data: { status: "HIDDEN" } }).catch(() => null);
        }
        if (report.targetType === "CAMPAIGN") {
          await tx.campaign.update({ where: { id: report.targetId }, data: { status: "PAUSED" } }).catch(() => null);
        }
      }

      if (data.status === "DISMISSED") {
        const targetUserId = await resolveTargetUser(report.targetType, report.targetId);
        if (targetUserId) {
          await recordReputation(tx, {
            userId: targetUserId,
            type: "REPORT_DISMISSED",
            delta: REPUTATION.REPORT_DISMISSED,
            idempotencyKey: ledgerKey(["report-dismissed", report.id]),
            reason: "report dismissed",
          });
        }
      }
    });

    await writeAudit({
      userId: actor.id,
      action: "ADMIN_ACTION",
      entity: "Report",
      entityId: report.id,
      req,
      metadata: { status: data.status, targetType: report.targetType, targetId: report.targetId },
    });

    return { message: "گزارش بروزرسانی شد." };
  },
  { rateLimit: "adminMutation" }
);

async function previewTarget(type: string, id: string) {
  if (type === "USER") {
    return prisma.user.findUnique({ where: { id }, select: { username: true, name: true, status: true, reputation: true } });
  }
  if (type === "VIDEO") {
    return prisma.video.findUnique({
      where: { id },
      select: { title: true, status: true, youtubeVideoId: true, user: { select: { username: true } } },
    });
  }
  if (type === "CAMPAIGN") {
    return prisma.campaign.findUnique({
      where: { id },
      select: { title: true, status: true, creator: { select: { username: true } } },
    });
  }
  return prisma.support.findUnique({
    where: { id },
    select: { status: true, supporter: { select: { username: true } }, receiver: { select: { username: true } } },
  });
}

async function resolveTargetUser(type: string, id: string): Promise<string | null> {
  if (type === "USER") return id;
  if (type === "VIDEO") return (await prisma.video.findUnique({ where: { id }, select: { userId: true } }))?.userId ?? null;
  if (type === "CAMPAIGN") return (await prisma.campaign.findUnique({ where: { id }, select: { creatorId: true } }))?.creatorId ?? null;
  return (await prisma.support.findUnique({ where: { id }, select: { supporterId: true } }))?.supporterId ?? null;
}

import { prisma } from "@/lib/prisma";
import { parseBody } from "@/lib/api";
import { active } from "@/lib/handler";
import { reportSchema } from "@/lib/validators";
import { BusinessRuleError, ConflictError, NotFoundError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { Prisma } from "@prisma/client";

/**
 * User reports.
 *
 * Integrity checks: the target must exist, you cannot report yourself, and a
 * duplicate open report from the same reporter on the same target is rejected by
 * a unique index (rather than a read-then-write race).
 */
export const POST = active(
  "reports.create",
  async ({ req, user }) => {
    const data = await parseBody(req, reportSchema);

    const exists = await targetExists(data.targetType, data.targetId, user.id);
    if (!exists.found) throw new NotFoundError("موردی که گزارش کردید پیدا نشد.");
    if (exists.isSelf) throw new BusinessRuleError("نمی‌توانید محتوای خودتان را گزارش کنید.");

    try {
      const report = await prisma.report.create({
        data: {
          reporterId: user.id,
          targetType: data.targetType,
          targetId: data.targetId,
          reason: data.reason,
          description: data.description ?? null,
          status: "OPEN",
        },
        select: { id: true, status: true, createdAt: true },
      });

      await writeAudit({
        userId: user.id,
        action: "CREATE",
        entity: "Report",
        entityId: report.id,
        req,
        metadata: { targetType: data.targetType, targetId: data.targetId },
      });

      return { report, message: "گزارش شما ثبت شد و توسط تیم بررسی می‌شود." };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConflictError("گزارش شما برای این مورد قبلاً ثبت شده و در حال بررسی است.");
      }
      throw e;
    }
  },
  { rateLimit: "report" }
);

async function targetExists(type: string, id: string, viewerId: string) {
  if (type === "USER") {
    const user = await prisma.user.findUnique({ where: { id }, select: { id: true } });
    return { found: Boolean(user), isSelf: id === viewerId };
  }
  if (type === "VIDEO") {
    const video = await prisma.video.findUnique({ where: { id }, select: { userId: true } });
    return { found: Boolean(video), isSelf: video?.userId === viewerId };
  }
  if (type === "CAMPAIGN") {
    const campaign = await prisma.campaign.findUnique({ where: { id }, select: { creatorId: true } });
    return { found: Boolean(campaign), isSelf: campaign?.creatorId === viewerId };
  }
  const support = await prisma.support.findUnique({ where: { id }, select: { supporterId: true } });
  return { found: Boolean(support), isSelf: support?.supporterId === viewerId };
}

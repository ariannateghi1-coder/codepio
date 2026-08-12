import { prisma } from "@/lib/prisma";
import { active } from "@/lib/handler";
import { NotFoundError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";

/**
 * Soft-deletes a video the caller owns. Soft delete, because supports and ledger
 * entries reference it and history must stay readable; ACTIVE campaigns pointing
 * at it are ended so it can't keep appearing in Explore.
 */
export const DELETE = active<unknown, { id: string }>("videos.delete", async ({ req, user, params }) => {
  const { id } = await params();

  const video = await prisma.video.findFirst({ where: { id, userId: user.id }, select: { id: true } });
  if (!video) throw new NotFoundError("این ویدیو پیدا نشد.");

  await prisma.$transaction([
    prisma.video.update({ where: { id: video.id }, data: { status: "REMOVED" } }),
    prisma.campaign.updateMany({
      where: { videoId: video.id, status: { in: ["DRAFT", "ACTIVE", "PAUSED"] } },
      data: { status: "ENDED" },
    }),
  ]);

  await writeAudit({ userId: user.id, action: "DELETE", entity: "Video", entityId: video.id, req });
  return { message: "ویدیو حذف شد و کمپین‌های مرتبط پایان یافتند." };
});

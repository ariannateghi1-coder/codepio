import { prisma } from "@/lib/prisma";
import { active } from "@/lib/handler";
import { NotFoundError } from "@/lib/errors";
import { fetchVideoMetadata } from "@/lib/services/youtube-api";
import { writeAudit } from "@/lib/audit";

/** Re-syncs authoritative metadata (title/duration/thumbnail) from YouTube. */
export const POST = active<unknown, { id: string }>("videos.sync", async ({ req, user, params }) => {
  const { id } = await params();

  const video = await prisma.video.findFirst({
    where: { id, userId: user.id },
    select: { id: true, youtubeVideoId: true },
  });
  if (!video) throw new NotFoundError("این ویدیو پیدا نشد.");

  const metadata = await fetchVideoMetadata(video.youtubeVideoId);
  if (!metadata) throw new NotFoundError("اطلاعات این ویدیو از یوتیوب دریافت نشد.");

  const updated = await prisma.video.update({
    where: { id: video.id },
    data: {
      title: metadata.title,
      description: metadata.description,
      thumbnailUrl: metadata.thumbnailUrl,
      durationSec: metadata.durationSec,
      metadataSyncedAt: new Date(),
      // A video that stopped being public/embeddable can no longer support watch
      // verification, so it leaves Explore automatically.
      status: metadata.privacyStatus === "public" && metadata.embeddable ? "ACTIVE" : "HIDDEN",
    },
  });

  await writeAudit({ userId: user.id, action: "UPDATE", entity: "Video", entityId: video.id, req, metadata: { source: "YOUTUBE_API" } });
  return { video: updated };
});

import { prisma } from "@/lib/prisma";
import { parseBody } from "@/lib/api";
import { active, authed } from "@/lib/handler";
import { videoSchema } from "@/lib/validators";
import { extractYoutubeVideoId, youtubeThumbnailUrl, youtubeWatchUrl } from "@/lib/youtube";
import { fetchVideoMetadata, VideoMetadataError } from "@/lib/services/youtube-api";
import { BusinessRuleError, ConflictError } from "@/lib/errors";
import { features } from "@/lib/env";
import { writeAudit } from "@/lib/audit";
import { Prisma } from "@prisma/client";

/**
 * Creator videos.
 *
 * Metadata (title, duration, thumbnail, embeddability) is fetched from YouTube
 * rather than accepted from the client: duration is what watch verification is
 * measured against, so a client-supplied value would be a direct way to fake a
 * "90% watched" threshold.
 *
 * Ownership: a video may only be registered by the account that owns the channel
 * it belongs to, verified against the linked (OAuth-verified) channel id. Without
 * that link we still store the video but cannot treat the channel as verified.
 */

export const GET = authed(
  "videos.mine",
  async ({ user }) => ({
    items: await prisma.video.findMany({
      where: { userId: user.id, status: { not: "REMOVED" } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        title: true,
        thumbnailUrl: true,
        youtubeVideoId: true,
        youtubeUrl: true,
        durationSec: true,
        status: true,
        createdAt: true,
        metadataSyncedAt: true,
        _count: { select: { supports: true, campaigns: true } },
      },
    }),
  }),
  { csrf: false }
);

export const POST = active(
  "videos.create",
  async ({ req, user }) => {
    const data = await parseBody(req, videoSchema);
    const videoId = extractYoutubeVideoId(data.youtubeUrl);
    if (!videoId) throw new BusinessRuleError("آدرس ویدیوی یوتیوب معتبر نیست.");

    let metadata = null;
    if (features.youtubeDataApi) {
      try {
        metadata = await fetchVideoMetadata(videoId);
      } catch (error) {
        if (!(error instanceof VideoMetadataError)) throw error;
        const messages = {
          YOUTUBE_TIMEOUT: "دریافت اطلاعات ویدیو از یوتیوب زمان‌بر شد. چند لحظه دیگر دوباره تلاش کنید.",
          YOUTUBE_QUOTA_EXCEEDED: "سهمیه موقت یوتیوب تمام شده است. لطفاً بعداً دوباره تلاش کنید.",
          YOUTUBE_UPSTREAM_UNAVAILABLE: "یوتیوب موقتاً در دسترس نیست. چند لحظه دیگر دوباره تلاش کنید.",
          YOUTUBE_VIDEO_UNAVAILABLE: "این ویدیو پیدا نشد یا خصوصی، حذف‌شده یا در دسترس نیست.",
        } as const;
        throw new BusinessRuleError(messages[error.metadataCode], {
          code: error.retryable ? "UPSTREAM_ERROR" : "PRECONDITION_FAILED",
          status: error.retryable ? 503 : 422,
          details: { reason: error.metadataCode, retryable: error.retryable },
          rule: error.metadataCode,
        });
      }
    }

    if (metadata) {
      if (metadata.privacyStatus !== "public") {
        throw new BusinessRuleError("فقط ویدیوی عمومی می‌تواند در کمپین استفاده شود.");
      }
      if (!metadata.embeddable) {
        throw new BusinessRuleError("این ویدیو اجازه نمایش در سایت‌های دیگر را ندارد و امکان تأیید تماشا وجود ندارد.");
      }

      // Ownership check against the verified channel, when one is linked.
      const connection = await prisma.youtubeConnection.findUnique({
        where: { userId: user.id },
        select: { channelId: true, verified: true },
      });
      if (connection?.verified && connection.channelId !== metadata.channelId) {
        throw new BusinessRuleError("این ویدیو به کانال تأییدشده شما تعلق ندارد.");
      }
    }

    try {
      const video = await prisma.video.create({
        data: {
          userId: user.id,
          youtubeVideoId: videoId,
          youtubeUrl: youtubeWatchUrl(videoId),
          title: metadata?.title ?? data.title ?? "ویدیوی یوتیوب",
          description: metadata?.description ?? data.description ?? null,
          thumbnailUrl: metadata?.thumbnailUrl ?? youtubeThumbnailUrl(videoId),
          durationSec: metadata?.durationSec ?? null,
          metadataSyncedAt: metadata ? new Date() : null,
        },
      });

      await prisma.activity.create({
        data: { userId: user.id, actorId: user.id, type: "VIDEO_ADDED", targetId: video.id },
      });
      await writeAudit({ userId: user.id, action: "CREATE", entity: "Video", entityId: video.id, req });

      return {
        video,
        metadataSource: metadata ? "YOUTUBE_API" : "UNVERIFIED",
        warning: metadata
          ? null
          : "اطلاعات این ویدیو از یوتیوب دریافت نشد؛ تا زمان همگام‌سازی، امکان ساخت کمپین با تأیید تماشا وجود ندارد.",
      };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConflictError("این ویدیو قبلاً ثبت شده است.");
      }
      throw e;
    }
  },
  { rateLimit: "videoWrite" }
);

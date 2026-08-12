import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Calendar, Flame, Youtube } from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";
import { Section } from "@/components/layout/page";
import { Card, CardBody, CardFooter, CardHeader, CardMedia, CardTitle } from "@/components/ui/card";
import { Avatar } from "@/components/ui/avatar";
import { Pill, TierBadge, VerificationBadge } from "@/components/ui/badge";
import { ProgressBar } from "@/components/ui/progress";
import { EmptyState } from "@/components/ui/states";
import { Button } from "@/components/ui/button";
import { prisma } from "@/lib/prisma";
import { nextLevelProgress, rankTierLabel } from "@/lib/gamification";
import { formatDate, formatDuration, formatNumber } from "@/lib/cn";

/**
 * Public profile.
 *
 * Rendered as a Server Component reading the service layer directly, so there is
 * no needless Server Component → HTTP → API → DB hop.
 *
 * Only public fields are selected. Support counts filter on status ACTIVE, so a
 * reversed support never inflates a public profile, and the channel's verification
 * method is rendered verbatim rather than as a generic "verified" tick.
 */

type Params = { params: Promise<{ username: string }> };

async function getProfile(username: string) {
  return prisma.user.findFirst({
    where: { username: username.toLowerCase(), status: "ACTIVE" },
    select: {
      username: true,
      name: true,
      avatarUrl: true,
      bio: true,
      country: true,
      level: true,
      points: true,
      reputation: true,
      rankTier: true,
      youtubeVerified: true,
      currentStreakDays: true,
      longestStreakDays: true,
      createdAt: true,
      youtubeConnection: {
        select: { channelTitle: true, channelUrl: true, verified: true, verificationMethod: true, subscriberCount: true },
      },
      badges: {
        orderBy: { earnedAt: "desc" },
        select: { earnedAt: true, badge: { select: { code: true, name: true, icon: true, description: true } } },
      },
      videos: {
        where: { status: "ACTIVE" },
        orderBy: { createdAt: "desc" },
        take: 6,
        select: { id: true, title: true, thumbnailUrl: true, youtubeVideoId: true, durationSec: true },
      },
      campaigns: {
        where: { status: "ACTIVE", endAt: { gte: new Date() } },
        orderBy: { createdAt: "desc" },
        take: 3,
        select: { id: true, title: true, rewardCredits: true, requiredWatchPercent: true },
      },
      _count: {
        select: {
          supportsGiven: { where: { status: "ACTIVE" } },
          supportsReceived: { where: { status: "ACTIVE" } },
        },
      },
    },
  });
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { username } = await params;
  const user = await getProfile(username);
  if (!user) return { title: "کاربر پیدا نشد" };
  return {
    title: user.name,
    description: user.bio ?? `پروفایل ${user.name} در آکادمی حمایت`,
    alternates: { canonical: `/members/${user.username}` },
  };
}

export default async function MemberProfilePage({ params }: Params) {
  const { username } = await params;
  const user = await getProfile(username);
  if (!user) notFound();

  const progress = nextLevelProgress(user.points);

  return (
    <AppShell>
      <Card variant="raised" className="mb-6 p-5 sm:p-6">
        <div className="flex flex-wrap items-start gap-4">
          <Avatar src={user.avatarUrl} name={user.name} size="xl" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-black">{user.name}</h1>
              <TierBadge tier={user.rankTier} label={rankTierLabel(user.rankTier)} />
              {user.currentStreakDays > 0 && (
                <Pill tone="warning" icon={<Flame aria-hidden size={12} />}>
                  {formatNumber(user.currentStreakDays)} روز پیوسته
                </Pill>
              )}
            </div>
            <p className="latin mt-1 text-sm text-fg-subtle" dir="ltr">
              @{user.username}
            </p>
            {user.bio && <p className="mt-3 max-w-2xl text-sm leading-8 text-fg-muted">{user.bio}</p>}

            <p className="mt-3 flex flex-wrap items-center gap-4 text-xs text-fg-subtle">
              <span className="inline-flex items-center gap-1">
                <Calendar aria-hidden size={13} /> عضو از {formatDate(user.createdAt)}
              </span>
              {user.country && <span>{user.country}</span>}
            </p>
          </div>
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "اعتبار کیفی", value: formatNumber(user.reputation) },
            { label: "سطح", value: formatNumber(user.level) },
            { label: "حمایت داده", value: formatNumber(user._count.supportsGiven) },
            { label: "حمایت گرفته", value: formatNumber(user._count.supportsReceived) },
          ].map((item) => (
            <div key={item.label} className="rounded-lg bg-surface-sunken p-3 text-center">
              <dt className="text-xs text-fg-subtle">{item.label}</dt>
              <dd className="numeric mt-1 text-lg font-black">{item.value}</dd>
            </div>
          ))}
        </dl>

        <ProgressBar
          className="mt-5"
          label={progress.next ? `پیشرفت تا سطح ${formatNumber(progress.next)}` : "بالاترین سطح"}
          value={progress.progress}
          max={100}
        />
      </Card>

      {user.youtubeConnection && (
        <Card className="mb-6 flex-row flex-wrap items-center gap-3 p-4">
          <Youtube aria-hidden size={20} className="text-danger" />
          <div className="min-w-0 flex-1">
            <p className="truncate-1 text-sm font-bold">{user.youtubeConnection.channelTitle}</p>
            {user.youtubeConnection.subscriberCount !== null && (
              <p className="numeric text-xs text-fg-subtle">
                {formatNumber(user.youtubeConnection.subscriberCount)} سابسکرایبر
              </p>
            )}
          </div>
          {/* Honest label: only an OAuth-verified channel says "verified by YouTube". */}
          <VerificationBadge method={user.youtubeConnection.verificationMethod} />
          <a href={user.youtubeConnection.channelUrl} target="_blank" rel="noopener noreferrer">
            <Button variant="outline" size="sm">
              مشاهده کانال
            </Button>
          </a>
        </Card>
      )}

      {user.campaigns.length > 0 && (
        <Section title="کمپین‌های فعال" description="می‌توانید از این کمپین‌ها حمایت کنید.">
          <div className="grid gap-3 sm:grid-cols-3">
            {user.campaigns.map((campaign) => (
              <Card key={campaign.id} className="p-4">
                <CardTitle className="clamp-2 text-sm">{campaign.title}</CardTitle>
                <CardBody className="px-0 py-2 text-xs">
                  پاداش <span className="numeric font-bold">{formatNumber(campaign.rewardCredits)}</span> اعتبار · تماشا{" "}
                  <span className="numeric">{formatNumber(campaign.requiredWatchPercent)}٪</span>
                </CardBody>
                <CardFooter className="px-0 pb-0">
                  <Link href="/explore" className="w-full">
                    <Button size="sm" fullWidth>
                      حمایت از این کمپین
                    </Button>
                  </Link>
                </CardFooter>
              </Card>
            ))}
          </div>
        </Section>
      )}

      <Section title="ویدیوها">
        {user.videos.length === 0 ? (
          <EmptyState title="ویدیویی ثبت نشده" description="این عضو هنوز ویدیویی اضافه نکرده است." />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {user.videos.map((video) => (
              <Card key={video.id} className="overflow-hidden">
                <CardMedia>
                  <div className="relative aspect-video bg-surface-sunken">
                    {video.thumbnailUrl && (
                      <Image
                        src={video.thumbnailUrl}
                        alt={video.title}
                        fill
                        sizes="(max-width: 640px) 100vw, 33vw"
                        className="object-cover"
                      />
                    )}
                    {video.durationSec != null && (
                      <span className="numeric absolute bottom-2 end-2 rounded-md bg-black/75 px-1.5 py-0.5 text-xs font-bold text-white">
                        {formatDuration(video.durationSec)}
                      </span>
                    )}
                  </div>
                </CardMedia>
                <CardHeader>
                  <CardTitle className="clamp-2 text-sm leading-7">{video.title}</CardTitle>
                </CardHeader>
                <CardFooter>
                  <a
                    href={`https://www.youtube.com/watch?v=${video.youtubeVideoId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-full"
                  >
                    <Button variant="outline" size="sm" fullWidth>
                      تماشا در یوتیوب
                    </Button>
                  </a>
                </CardFooter>
              </Card>
            ))}
          </div>
        )}
      </Section>

      <Section title="نشان‌ها">
        {user.badges.length === 0 ? (
          <EmptyState title="نشانی کسب نشده" description="نشان‌ها از تاریخچه واقعی حمایت محاسبه می‌شوند." />
        ) : (
          <ul className="flex flex-wrap gap-2">
            {user.badges.map((entry) => (
              <li key={entry.badge.code} title={entry.badge.description}>
                <Pill tone="success">
                  {entry.badge.icon} {entry.badge.name}
                </Pill>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </AppShell>
  );
}

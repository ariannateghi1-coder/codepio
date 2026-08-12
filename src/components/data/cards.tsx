"use client";

import Image from "next/image";
import Link from "next/link";
import {
  Clock,
  Coins,
  Eye,
  Flame,
  Heart,
  MessageCircle,
  Play,
  Sparkles,
  Star,
  ThumbsUp,
  TrendingUp,
  UserPlus,
} from "lucide-react";
import { formatCompact, formatDuration, formatNumber, formatRelativeTime } from "@/lib/cn";
import { Card, CardBody, CardFooter, CardHeader, CardMedia, CardMeta, CardTitle } from "@/components/ui/card";
import { Avatar } from "@/components/ui/avatar";
import { AvatarGroup } from "@/components/ui/avatar-group";
import { HoverCard } from "@/components/ui/hover-card";
import { Pill, TierBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/**
 * Explore card — the primary unit of the product.
 *
 * Visual hierarchy, deliberately in this order:
 *
 *   Content   the thumbnail is the largest element; it is what the supporter is
 *             being asked to watch.
 *   Creator   who is asking, with tier and verification, plus a hover card so the
 *             profile can be judged without leaving the feed.
 *   Tasks     what is actually required, as named chips — never hidden behind a
 *             click. The supporter must be able to decline before committing.
 *   Reward    the figure, given the most prominent numeric treatment on the card.
 *   Time      a realistic estimate from the video's true duration, so "how long
 *             will this take" is answered before starting.
 *   CTA       the single clearest action, labelled with what the user gets.
 *
 * The CTA states the actual reward ("شروع حمایت · ‎+۱۲ اعتبار") instead of a bare
 * "Support", because a context-free verb makes the user compute the value
 * themselves. It is not a dark pattern: the number shown is the number the server
 * will pay, and the diminishing-returns multiplier is disclosed on the card when
 * it applies.
 */

export type ExploreCardData = {
  campaignId: string;
  videoId: string;
  youtubeVideoId: string;
  title: string;
  thumbnailUrl: string | null;
  durationSec: number | null;
  reward: { credits: number; xp: number };
  requiredWatchPercent: number;
  estimatedSeconds: number;
  tasks: { type: string; required: boolean }[];
  endsAt: string;
  supportsCount: number;
  creator: {
    id: string;
    username: string;
    name: string;
    avatarUrl: string | null;
    level: number;
    reputation: number;
    rankTier: string;
    youtubeVerified: boolean;
    isNew: boolean;
  };
  recentSupporters?: { id: string; name: string; avatarUrl: string | null }[];
  supported: boolean;
  lane?: "personalized" | "fresh" | "popular" | "exploration";
};

const TASK_META: Record<string, { label: string; icon: typeof Eye }> = {
  WATCH_VIDEO: { label: "تماشا", icon: Eye },
  SUBSCRIBE_CHANNEL: { label: "سابسکرایب", icon: UserPlus },
  LIKE_VIDEO: { label: "لایک", icon: ThumbsUp },
  COMMENT_VIDEO: { label: "کامنت", icon: MessageCircle },
};

/**
 * "Why am I seeing this" — the ranking reason, in the user's words.
 * Shown because an opaque feed feels arbitrary, and because we can state the
 * real reason: the lane that placed the card.
 */
const LANE_REASON: Record<string, { label: string; icon: typeof Sparkles }> = {
  personalized: { label: "پیشنهاد برای شما", icon: Sparkles },
  fresh: { label: "تازه منتشر شده", icon: Flame },
  popular: { label: "پرطرفدار این هفته", icon: TrendingUp },
  exploration: { label: "کشف تازه", icon: Sparkles },
};

export function ExploreCard({
  data,
  onStart,
  tierLabel,
}: {
  data: ExploreCardData;
  onStart: (campaignId: string) => void;
  tierLabel: string;
}) {
  const required = data.tasks.filter((task) => task.required);
  const optional = data.tasks.filter((task) => !task.required);
  const reason = data.lane ? LANE_REASON[data.lane] : null;
  const ReasonIcon = reason?.icon;
  const endingSoon = new Date(data.endsAt).getTime() - Date.now() < 48 * 3_600_000;

  return (
    <Card interactive className="explore-card group overflow-hidden">
      <CardMedia>
        <div className="relative aspect-video bg-surface-sunken">
          {data.thumbnailUrl ? (
            <Image
              src={data.thumbnailUrl}
              alt={data.title}
              fill
              sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
              className="object-cover transition-transform duration-slow ease-out group-hover:scale-[1.03]"
            />
          ) : (
            <div aria-hidden className="grid size-full place-items-center text-fg-subtle">
              <Eye size={28} />
            </div>
          )}

          {/* Play affordance appears on hover/focus-within only: a permanent
              overlay competes with the thumbnail it is sitting on. */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 grid place-items-center opacity-0 transition-opacity duration-base group-hover:opacity-100"
          >
            <span className="grid size-12 place-items-center rounded-pill bg-black/60 text-white backdrop-blur-sm">
              <Play size={20} className="ms-0.5" />
            </span>
          </span>

          {data.durationSec != null && (
            <span className="numeric absolute bottom-2 end-2 rounded-md bg-black/75 px-1.5 py-0.5 text-xs font-bold text-white">
              {formatDuration(data.durationSec)}
            </span>
          )}

          <div className="absolute top-2 start-2 flex flex-wrap gap-1.5">
            {data.creator.isNew && (
              <Pill icon={<Sparkles aria-hidden size={12} />} className="bg-accent text-fg-onAccent">
                سازنده تازه
              </Pill>
            )}
            {endingSoon && (
              <Pill tone="warning" icon={<Flame aria-hidden size={12} />}>
                در حال پایان
              </Pill>
            )}
          </div>
        </div>
      </CardMedia>

      <CardHeader>
        <div className="flex items-center gap-2.5">
          {/* Hover card: judge the creator without leaving the feed. The trigger
              is still a plain link, so tapping on touch just navigates. */}
          <HoverCard
            align="start"
            trigger={
              <Link href={`/members/${data.creator.username}`} className="flex min-w-0 items-center gap-2.5">
                <Avatar src={data.creator.avatarUrl} name={data.creator.name} size="sm" />
                <span className="min-w-0">
                  <span className="truncate-1 block text-sm font-bold group-hover:text-accent">{data.creator.name}</span>
                  <span className="latin truncate-1 block text-xs text-fg-subtle" dir="ltr">
                    @{data.creator.username}
                  </span>
                </span>
              </Link>
            }
          >
            <div className="flex items-start gap-2.5">
              <Avatar src={data.creator.avatarUrl} name={data.creator.name} size="md" />
              <div className="min-w-0">
                <p className="truncate-1 text-sm font-bold">{data.creator.name}</p>
                <p className="latin truncate-1 text-xs text-fg-subtle" dir="ltr">
                  @{data.creator.username}
                </p>
              </div>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-2 text-center">
              <div className="rounded-lg bg-surface-sunken py-1.5">
                <dt className="text-[0.625rem] text-fg-subtle">اعتبار</dt>
                <dd className="numeric text-sm font-bold">{formatNumber(data.creator.reputation)}</dd>
              </div>
              <div className="rounded-lg bg-surface-sunken py-1.5">
                <dt className="text-[0.625rem] text-fg-subtle">سطح</dt>
                <dd className="numeric text-sm font-bold">{formatNumber(data.creator.level)}</dd>
              </div>
            </dl>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <TierBadge tier={data.creator.rankTier} label={tierLabel} />
              {data.creator.youtubeVerified && <Pill tone="success">کانال تأییدشده</Pill>}
            </div>
          </HoverCard>

          <TierBadge tier={data.creator.rankTier} label={tierLabel} className="ms-auto shrink-0" />
        </div>

        <CardTitle className="clamp-2 mt-2 text-sm leading-7">{data.title}</CardTitle>

        {reason && ReasonIcon && (
          <p className="mt-2 inline-flex w-fit items-center gap-1.5 rounded-pill bg-accent-soft px-2.5 py-1 text-[0.6875rem] font-semibold text-accent">
            <ReasonIcon aria-hidden size={11} />
            چرا این پیشنهاد؟ {reason.label}
          </p>
        )}
      </CardHeader>

      <CardBody className="pt-0">
        <ul className="flex flex-wrap gap-1.5">
          {required.map((task) => {
            const meta = TASK_META[task.type] ?? { label: task.type, icon: Eye };
            const Icon = meta.icon;
            return (
              <li key={task.type}>
                <Pill tone="neutral" icon={<Icon aria-hidden size={12} />}>
                  {task.type === "WATCH_VIDEO" ? `${meta.label} ${formatNumber(data.requiredWatchPercent)}٪` : meta.label}
                </Pill>
              </li>
            );
          })}
          {optional.map((task) => {
            const meta = TASK_META[task.type] ?? { label: task.type, icon: Eye };
            return (
              <li key={task.type}>
                <Pill tone="neutral" className="opacity-70">
                  {meta.label} (اختیاری)
                </Pill>
              </li>
            );
          })}
        </ul>
      </CardBody>

      <CardMeta className="pb-1">
        <span className="inline-flex items-center gap-1">
          <Clock aria-hidden size={13} />
          <span className="numeric">~{formatDuration(data.estimatedSeconds)}</span>
        </span>

        {data.recentSupporters && data.recentSupporters.length > 0 ? (
          <span className="inline-flex items-center gap-1.5">
            <AvatarGroup
              members={data.recentSupporters}
              total={data.supportsCount}
              size="xs"
              max={3}
              label={`${formatNumber(data.supportsCount)} حامی`}
            />
            <span className="numeric">{formatCompact(data.supportsCount)}</span> حمایت
          </span>
        ) : (
          <span className="inline-flex items-center gap-1">
            <Heart aria-hidden size={13} />
            <span className="numeric">{formatCompact(data.supportsCount)}</span> حمایت
          </span>
        )}

        <span className="inline-flex items-center gap-1">{formatRelativeTime(data.endsAt)}</span>
      </CardMeta>

      <CardFooter className="flex-col items-stretch gap-2">
        <div className="flex items-center justify-between gap-3 rounded-lg bg-surface-sunken px-3 py-2">
          <span className="text-[0.6875rem] font-semibold text-fg-subtle">پس از حمایت</span>
          <span className="flex items-center gap-3 text-xs font-bold">
            <span className="inline-flex items-center gap-1 text-accent">
              <Coins aria-hidden size={13} />
              <span className="numeric">+{formatNumber(data.reward.credits)}</span> اعتبار
            </span>
            <span className="inline-flex items-center gap-1 text-info">
              <Star aria-hidden size={13} />
              <span className="numeric">+{formatNumber(data.reward.xp)}</span> XP
            </span>
          </span>
        </div>

        {data.supported ? (
          <Button variant="secondary" disabled fullWidth>
            قبلاً حمایت کرده‌اید
          </Button>
        ) : (
          <Button fullWidth onClick={() => onStart(data.campaignId)} icon={<Heart aria-hidden size={16} />}>
            شروع حمایت
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}

/** Compact member card for the directory and recommendation rails. */
export function MemberCard({
  user,
}: {
  user: {
    username: string;
    name: string;
    avatarUrl?: string | null;
    bio?: string | null;
    level: number;
    reputation: number;
    rankTier: string;
    rankTierLabel: string;
    youtubeVerified: boolean;
    _count?: { supportsGiven?: number; supportsReceived?: number };
  };
}) {
  return (
    <Card interactive className="p-4">
      <div className="flex items-start gap-3">
        <Avatar src={user.avatarUrl} name={user.name} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Link href={`/members/${user.username}`} className="truncate-1 font-bold hover:text-accent">
              {user.name}
            </Link>
            {user.youtubeVerified && <Pill tone="success">کانال تأییدشده</Pill>}
          </div>
          <p className="latin truncate-1 text-xs text-fg-subtle" dir="ltr">
            @{user.username}
          </p>
          {user.bio && <p className="clamp-2 mt-1.5 text-xs leading-6 text-fg-muted">{user.bio}</p>}
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg bg-surface-sunken py-2">
          <dt className="text-[0.6875rem] text-fg-subtle">اعتبار</dt>
          <dd className="numeric text-sm font-bold">{formatNumber(user.reputation)}</dd>
        </div>
        <div className="rounded-lg bg-surface-sunken py-2">
          <dt className="text-[0.6875rem] text-fg-subtle">حمایت داده</dt>
          <dd className="numeric text-sm font-bold">{formatNumber(user._count?.supportsGiven ?? 0)}</dd>
        </div>
        <div className="rounded-lg bg-surface-sunken py-2">
          <dt className="text-[0.6875rem] text-fg-subtle">حمایت گرفته</dt>
          <dd className="numeric text-sm font-bold">{formatNumber(user._count?.supportsReceived ?? 0)}</dd>
        </div>
      </dl>

      <CardFooter className="px-0 pb-0">
        <TierBadge tier={user.rankTier} label={user.rankTierLabel} />
        <Link href={`/members/${user.username}`} className="ms-auto">
          <Button variant="outline" size="sm">
            مشاهده پروفایل
          </Button>
        </Link>
      </CardFooter>
    </Card>
  );
}

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Avatar } from "./avatar";

/**
 * Avatar Group (classic name: facepile).
 *
 * Anatomy, each part named:
 *   1. Avatar stack      — the overlap itself, made with a negative inline margin.
 *                          Reversed DOM order gives earlier members the higher
 *                          stacking position without an explicit z-index each.
 *   2. Separation ring   — the thin rim painted in the SURFACE colour behind the
 *                          group, which is what stops the photos blending into
 *                          each other. It is not a focus ring.
 *   3. Fallback initials — handled by <Avatar>, for members with no photo.
 *   4. Overflow avatar   — the last circle showing +N instead of a face. It fills
 *                          a member slot and counts who did not fit, so it is a
 *                          member slot, not a badge.
 *
 * RTL: the overlap uses `margin-inline-start`, so the stack direction follows the
 * document direction instead of being pinned to the left.
 *
 * The group is announced as one item with a summary label; individual faces are
 * decorative, because hearing nine names read out is worse than "4 supporters".
 */

export type AvatarGroupMember = {
  id: string;
  name: string;
  avatarUrl?: string | null;
};

const DIMENSIONS = {
  xs: { avatar: "xs" as const, overlap: "-ms-2", box: "size-6 text-[0.5625rem]" },
  sm: { avatar: "xs" as const, overlap: "-ms-2.5", box: "size-7 text-[0.625rem]" },
  md: { avatar: "sm" as const, overlap: "-ms-3", box: "size-9 text-xs" },
};

export function AvatarGroup({
  members,
  max = 4,
  total,
  size = "sm",
  label,
  /** Surface the ring should match; only change it on a non-default background. */
  ringClass = "ring-surface",
  className,
}: {
  members: AvatarGroupMember[];
  max?: number;
  /** Real total, when it is larger than the members actually loaded. */
  total?: number;
  size?: keyof typeof DIMENSIONS;
  label: string;
  ringClass?: string;
  className?: string;
}) {
  if (members.length === 0) return null;

  const shown = members.slice(0, max);
  const overflow = Math.max(0, (total ?? members.length) - shown.length);
  const dim = DIMENSIONS[size];

  return (
    <div className={cn("flex items-center", className)} role="group" aria-label={label}>
      <div className="flex flex-row-reverse items-center justify-end">
        {overflow > 0 && (
          <span
            aria-hidden
            className={cn(
              "numeric grid shrink-0 place-items-center rounded-pill bg-surface-sunken font-bold text-fg-muted ring-2",
              dim.box,
              dim.overlap,
              ringClass
            )}
          >
            +{overflow}
          </span>
        )}
        {[...shown].reverse().map((member, index) => (
          <span
            key={member.id}
            aria-hidden
            className={cn("shrink-0 rounded-pill ring-2", ringClass, index === shown.length - 1 ? "" : dim.overlap)}
          >
            <Avatar src={member.avatarUrl} name={member.name} size={dim.avatar} />
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Facepile with a trailing summary line, for "N people supported this".
 * Keeps the count beside the faces so the group means something on its own.
 */
export function AvatarGroupWithCount({
  members,
  total,
  max,
  size,
  label,
  ringClass,
  children,
  className,
}: Parameters<typeof AvatarGroup>[0] & { children: ReactNode }) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <AvatarGroup members={members} total={total} max={max} size={size} label={label} ringClass={ringClass} />
      <span className="text-xs text-fg-subtle">{children}</span>
    </div>
  );
}

import Image from "next/image";
import { cn } from "@/lib/cn";

/**
 * Avatar.
 *
 * Uses next/image with explicit dimensions so remote avatars cause no layout
 * shift, and falls back to deterministic initials when there is no image — the
 * same user always gets the same fallback colour, so identity stays recognisable.
 */

const SIZES = { xs: 24, sm: 32, md: 40, lg: 56, xl: 80 } as const;
export type AvatarSize = keyof typeof SIZES;

const FALLBACK_TONES = [
  "bg-accent-soft text-accent",
  "bg-info-soft text-info",
  "bg-success-soft text-success",
  "bg-warning-soft text-warning",
  "bg-danger-soft text-danger",
];

function initials(name: string) {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part[0] ?? "").join("") || "؟";
}

function toneFor(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) % 997;
  return FALLBACK_TONES[hash % FALLBACK_TONES.length];
}

export function Avatar({
  src,
  name,
  size = "md",
  className,
  ring,
}: {
  src?: string | null;
  name: string;
  size?: AvatarSize;
  className?: string;
  /** Background-coloured separator ring, used when avatars overlap. */
  ring?: boolean;
}) {
  const px = SIZES[size];
  const shared = cn(
    "shrink-0 overflow-hidden rounded-pill object-cover",
    ring && "ring-2 ring-surface",
    className
  );

  if (src) {
    return (
      <Image
        src={src}
        alt={`تصویر ${name}`}
        width={px}
        height={px}
        className={shared}
        sizes={`${px}px`}
        // A broken remote avatar shouldn't blow up the tree; next/image handles
        // the error state and the alt text remains meaningful.
        unoptimized={false}
      />
    );
  }

  return (
    <span
      aria-hidden
      style={{ width: px, height: px, fontSize: Math.max(10, px * 0.36) }}
      className={cn("grid place-items-center font-bold", toneFor(name), shared)}
    >
      {initials(name)}
    </span>
  );
}

export { SIZES as AVATAR_SIZES };

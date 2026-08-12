import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Small labels, each picked by its JOB rather than its shape:
 *
 *   Badge — a count or status marker attached to another object (has an anchor).
 *   Pill  — short non-interactive status text in a capsule.
 *   Tag   — category metadata.
 *   Chip  — an interactive, selectable/removable token (see Chip below).
 */

type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

const TONES: Record<Tone, string> = {
  neutral: "bg-surface-sunken text-fg-muted",
  accent: "bg-accent-soft text-accent",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
};

/** Capsule status label. Non-interactive by design. */
export function Pill({
  tone = "neutral",
  className,
  children,
  icon,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone; icon?: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-pill px-2.5 py-0.5 text-xs font-semibold",
        TONES[tone],
        className
      )}
      {...props}
    >
      {icon}
      {children}
    </span>
  );
}

/** Category metadata label. */
export function Tag({ className, children, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn("inline-flex items-center rounded-md border border-border px-2 py-0.5 text-xs text-fg-muted", className)}
      {...props}
    >
      {children}
    </span>
  );
}

/**
 * Count badge attached to an anchor element. The anchor is the positioning
 * context; the badge floats at its corner and is announced as part of the
 * anchor's accessible name via the caller's aria-label.
 */
export function BadgeAnchor({
  count,
  max = 99,
  children,
  className,
}: {
  count: number;
  max?: number;
  children: ReactNode;
  className?: string;
}) {
  const display = count > max ? `+${max}` : String(count);
  return (
    <span className={cn("relative inline-flex", className)}>
      {children}
      {count > 0 && (
        <span
          aria-hidden
          className="numeric absolute -top-1 -end-1 grid min-w-4.5 place-items-center rounded-pill bg-danger px-1 text-[0.625rem] font-bold leading-4 text-white shadow-e1"
        >
          {display}
        </span>
      )}
    </span>
  );
}

/** A tiny presence dot, for "unread" without a number. */
export function Dot({ tone = "accent", className }: { tone?: Tone; className?: string }) {
  const color =
    tone === "accent" ? "bg-accent" : tone === "success" ? "bg-success" : tone === "danger" ? "bg-danger" : "bg-fg-subtle";
  return <span aria-hidden className={cn("inline-block size-2 rounded-pill", color, className)} />;
}

/**
 * Interactive token. Selection state is exposed through aria-pressed, and the
 * optional remove control is a separate button with its own accessible name.
 */
export function Chip({
  selected,
  onSelect,
  onRemove,
  children,
  className,
}: {
  selected?: boolean;
  onSelect?: () => void;
  onRemove?: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-pill border text-xs font-semibold transition-colors duration-fast",
        selected ? "border-accent bg-accent-soft text-accent" : "border-border bg-surface text-fg-muted hover:border-border-strong",
        className
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={onSelect ? Boolean(selected) : undefined}
        className="min-h-9 rounded-pill px-3"
      >
        {children}
      </button>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label="حذف فیلتر"
          className="grid size-6 place-items-center rounded-pill text-fg-subtle transition-colors hover:bg-surface-sunken hover:text-fg"
        >
          ×
        </button>
      )}
    </span>
  );
}

const TIER_STYLES: Record<string, string> = {
  BRONZE: "bg-tier-bronze/12 text-tier-bronze",
  SILVER: "bg-tier-silver/14 text-tier-silver",
  GOLD: "bg-tier-gold/16 text-tier-gold",
  PLATINUM: "bg-tier-platinum/14 text-tier-platinum",
  DIAMOND: "bg-tier-diamond/14 text-tier-diamond",
  ELITE: "bg-tier-elite/14 text-tier-elite",
};

/** Rank tier label, coloured per tier from the token scale. */
export function TierBadge({ tier, label, className }: { tier: string; label: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-pill px-2.5 py-0.5 text-xs font-bold", TIER_STYLES[tier] ?? TIER_STYLES.BRONZE, className)}>
      {label}
    </span>
  );
}

/**
 * Verification label — the product rule that we never overstate proof.
 * Each method gets distinct wording and colour so "observed by the platform" is
 * visibly not the same claim as "verified by YouTube".
 */
export function VerificationBadge({ method, className }: { method: string; className?: string }) {
  const map: Record<string, { label: string; tone: Tone }> = {
    YOUTUBE_API: { label: "تأییدشده توسط یوتیوب", tone: "success" },
    PLATFORM_OBSERVED: { label: "ثبت‌شده توسط پلتفرم", tone: "info" },
    SELF_REPORTED: { label: "اعلام‌شده توسط کاربر", tone: "warning" },
    UNVERIFIED: { label: "تأییدنشده", tone: "neutral" },
  };
  const entry = map[method] ?? map.UNVERIFIED;
  return (
    <Pill tone={entry.tone} className={className}>
      {entry.label}
    </Pill>
  );
}

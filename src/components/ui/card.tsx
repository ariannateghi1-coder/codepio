import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

/**
 * Card and its named regions.
 *
 * Every part of a card has a name and a slot: media, header (with optional
 * eyebrow), body, metadata row, footer. The footer is pinned with mt-auto inside
 * a flex column, which is what prevents the "chin" — the dead gap that collects
 * above an unpinned footer when a grid stretches cards to equal height.
 */

type CardProps = HTMLAttributes<HTMLDivElement> & {
  variant?: "default" | "raised" | "sunken" | "outline";
  /** Adds hover elevation; only for cards that are actually clickable. */
  interactive?: boolean;
};

export function Card({ className, variant = "default", interactive, ...props }: CardProps) {
  return (
    <div
      className={cn(
        "flex flex-col rounded-xl border transition-all duration-base ease-standard",
        variant === "default" && "border-border bg-surface shadow-e1",
        variant === "raised" && "border-border bg-surface-raised shadow-e2",
        variant === "sunken" && "border-border bg-surface-sunken",
        variant === "outline" && "border-border-strong bg-transparent",
        interactive && "hover:-translate-y-0.5 hover:border-border-strong hover:shadow-e2",
        className
      )}
      {...props}
    />
  );
}

/** Media slot: bleeds to the card edge and inherits the top corner radius. */
export function CardMedia({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("relative -mx-px -mt-px overflow-hidden rounded-t-xl", className)} {...props} />;
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1 p-4 pb-2", className)} {...props} />;
}

/** Small label above the title. */
export function CardEyebrow({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-xs font-semibold text-fg-subtle", className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("text-base font-bold text-fg", className)} {...props} />;
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-4 py-2 text-sm leading-8 text-fg-muted", className)} {...props} />;
}

/** Metadata row: compact, muted, separated from the body. */
export function CardMeta({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 px-4 text-xs text-fg-subtle", className)} {...props} />;
}

/** Footer, pinned to the bottom so equal-height grid cards keep no chin. */
export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mt-auto flex items-center gap-2 p-4 pt-3", className)} {...props} />;
}

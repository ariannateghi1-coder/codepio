import type { ReactNode } from "react";
import { AlertTriangle, Inbox, Loader2, SearchX } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "./button";

/**
 * Loading, empty and error states.
 *
 * A skeleton is used when the final layout is known (it preserves geometry, so
 * arriving data causes no layout shift); a spinner is used only when the shape of
 * the result is unknown. Neither is left on screen once a result or error exists.
 */

/** Skeleton block. Give it the size of the thing it stands in for. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("skeleton h-4 w-full", className)} />;
}

/** Skeleton line set for text, with a shorter final line like real paragraphs. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn("space-y-2", className)}>
      {Array.from({ length: lines }).map((_, index) => (
        <Skeleton key={index} className={index === lines - 1 ? "w-2/3" : "w-full"} />
      ))}
    </div>
  );
}

/** Card-shaped skeleton matching the Explore card geometry. */
export function SkeletonCard() {
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-surface" aria-hidden>
      <Skeleton className="aspect-video w-full rounded-none" />
      <div className="space-y-3 p-4">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
        <div className="flex gap-2 pt-1">
          <Skeleton className="h-6 w-20 rounded-pill" />
          <Skeleton className="h-6 w-16 rounded-pill" />
        </div>
        <Skeleton className="h-11 w-full rounded-lg" />
      </div>
    </div>
  );
}

/**
 * Region wrapper that marks itself busy while loading, so assistive tech knows
 * the content is in flight instead of merely absent.
 */
export function LoadingRegion({ loading, children }: { loading: boolean; children: ReactNode }) {
  return (
    <div aria-busy={loading || undefined} aria-live="polite">
      {children}
    </div>
  );
}

/** Indeterminate wait with no known result shape. */
export function Spinner({ label = "در حال بارگذاری…", className }: { label?: string; className?: string }) {
  return (
    <div role="status" className={cn("flex items-center justify-center gap-2 py-8 text-sm text-fg-muted", className)}>
      <Loader2 aria-hidden className="size-4 animate-spin" />
      <span>{label}</span>
    </div>
  );
}

/**
 * Empty state: a designed product state, not blank space. Explains the situation
 * without blame and offers exactly one recovery action.
 */
export function EmptyState({
  title,
  description,
  action,
  variant = "empty",
  className,
}: {
  title: string;
  description: string;
  action?: { label: string; onClick?: () => void; href?: string };
  variant?: "empty" | "no-results";
  className?: string;
}) {
  const Icon = variant === "no-results" ? SearchX : Inbox;
  return (
    <section
      aria-labelledby="empty-state-title"
      // A dynamically produced no-results message is announced without stealing focus.
      role={variant === "no-results" ? "status" : undefined}
      className={cn("flex flex-col items-center rounded-xl border border-border bg-surface px-6 py-14 text-center", className)}
    >
      <span aria-hidden className="mb-4 grid size-12 place-items-center rounded-xl bg-surface-sunken text-fg-subtle">
        <Icon size={22} />
      </span>
      <h3 id="empty-state-title" className="text-base font-bold text-fg">
        {title}
      </h3>
      <p className="mt-2 max-w-sm text-sm leading-8 text-fg-muted">{description}</p>
      {action &&
        (action.href ? (
          <a href={action.href} className="mt-5">
            <Button>{action.label}</Button>
          </a>
        ) : (
          <Button className="mt-5" onClick={action.onClick}>
            {action.label}
          </Button>
        ))}
    </section>
  );
}

/** Error state with a retry affordance; the message is user-facing copy. */
export function ErrorState({
  message = "دریافت اطلاعات ممکن نشد.",
  onRetry,
  className,
}: {
  message?: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn("flex flex-col items-center rounded-xl border border-danger/30 bg-danger-soft px-6 py-10 text-center", className)}
    >
      <AlertTriangle aria-hidden className="mb-3 text-danger" size={22} />
      <p className="text-sm font-semibold text-danger">{message}</p>
      {onRetry && (
        <Button variant="outline" className="mt-4" onClick={onRetry}>
          تلاش دوباره
        </Button>
      )}
    </div>
  );
}

/**
 * Inline alert / callout. `role="alert"` only for urgent interruptions;
 * advisory updates use `role="status"`, and a static callout needs neither.
 */
export function Alert({
  tone = "info",
  title,
  children,
  live,
  className,
}: {
  tone?: "info" | "success" | "warning" | "danger";
  title?: string;
  children: ReactNode;
  live?: "alert" | "status";
  className?: string;
}) {
  const tones = {
    info: "border-info/30 bg-info-soft text-info",
    success: "border-success/30 bg-success-soft text-success",
    warning: "border-warning/30 bg-warning-soft text-warning",
    danger: "border-danger/30 bg-danger-soft text-danger",
  } as const;

  return (
    <div
      role={live}
      className={cn("rounded-lg border border-s-4 px-4 py-3 text-sm leading-7", tones[tone], className)}
    >
      {title && <p className="mb-1 font-bold">{title}</p>}
      <div className="text-fg">{children}</div>
    </div>
  );
}

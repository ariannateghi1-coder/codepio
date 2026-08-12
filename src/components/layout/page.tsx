import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Page scaffolding: a consistent title block so every screen has the same
 * hierarchy and density. The heading is always an <h1>, so each page contributes
 * exactly one top-level landmark heading.
 */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-6 flex flex-wrap items-end justify-between gap-4", className)}>
      <div className="min-w-0">
        <h1 className="text-xl font-black tracking-tight sm:text-2xl">{title}</h1>
        {description && <p className="mt-1.5 max-w-2xl text-sm leading-8 text-fg-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Section grouping inside a page, with an h2 so the outline stays correct. */
export function Section({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("mb-8", className)}>
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            {title && <h2 className="text-base font-bold">{title}</h2>}
            {description && <p className="mt-1 text-sm text-fg-muted">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * Metric tile. The figure is the visual anchor (large, tabular) with the label
 * secondary, because a dashboard is read by scanning numbers first.
 */
export function Metric({
  label,
  value,
  hint,
  trend,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint?: string;
  /** Percentage change; null means "not enough history", which is shown as such. */
  trend?: number | null;
  tone?: "neutral" | "accent" | "success" | "warning";
}) {
  const tones = {
    neutral: "text-fg",
    accent: "text-accent",
    success: "text-success",
    warning: "text-warning",
  } as const;

  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <p className="text-xs font-semibold text-fg-subtle">{label}</p>
      <p className={cn("numeric mt-1.5 text-2xl font-black leading-none", tones[tone])}>{value}</p>
      <div className="mt-2 flex items-center gap-2 text-xs">
        {trend !== undefined && trend !== null && (
          <span
            className={cn(
              "numeric rounded-pill px-1.5 py-0.5 font-bold",
              trend >= 0 ? "bg-success-soft text-success" : "bg-danger-soft text-danger"
            )}
          >
            {trend >= 0 ? "+" : ""}
            {trend}%
          </span>
        )}
        {hint && <span className="text-fg-subtle">{hint}</span>}
      </div>
    </div>
  );
}

"use client";

import { ChevronRight, ChevronLeft, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Pagination.
 *
 * Anatomy:
 *   1. Page-number links — one per page, with exactly one carrying
 *                          aria-current="page".
 *   2. Previous / next   — step one page, disabled at the ends.
 *   3. Ellipsis          — a NON-interactive stand-in for the collapsed range,
 *                          with screen-reader text ("صفحات بیشتر") rather than a
 *                          bare "…" that reads as nothing.
 *
 * Wrapped in a <nav aria-label> landmark, so it is reachable as a landmark and
 * distinguishable from the other lists on the page.
 *
 * Two rules kept in one place each:
 *   • The visible page is 1-based; conversion to a 0-based offset happens in the
 *     caller's query layer only.
 *   • Whenever filters or totals change, the caller recomputes totalPages and
 *     clamps `page` — this component clamps defensively as well, so an out-of-range
 *     page can never render a broken control.
 *
 * RTL: "next" points to the inline end, which is visually LEFT in an RTL document,
 * so the chevrons are swapped rather than mirrored by a transform.
 */

export function Pagination({
  page,
  totalPages,
  onChange,
  label = "صفحه‌بندی",
  className,
}: {
  page: number;
  totalPages: number;
  onChange: (page: number) => void;
  label?: string;
  className?: string;
}) {
  const total = Math.max(1, Math.floor(totalPages));
  const current = Math.min(Math.max(1, Math.floor(page)), total);
  if (total <= 1) return null;

  const pages = pageWindow(current, total);

  return (
    <nav aria-label={label} className={cn("flex items-center justify-center gap-1", className)}>
      <button
        type="button"
        onClick={() => onChange(current - 1)}
        disabled={current === 1}
        aria-label="صفحه قبل"
        className={stepClass}
      >
        <ChevronRight aria-hidden size={17} />
      </button>

      <ul className="flex items-center gap-1">
        {pages.map((entry, index) =>
          entry === "ellipsis" ? (
            <li key={`gap-${index}`} aria-hidden className="grid min-h-9 min-w-9 place-items-center text-fg-subtle">
              <MoreHorizontal size={16} />
              <span className="sr-only">صفحات بیشتر</span>
            </li>
          ) : (
            <li key={entry}>
              <button
                type="button"
                onClick={() => onChange(entry)}
                aria-current={entry === current ? "page" : undefined}
                aria-label={`صفحه ${entry}`}
                className={cn(
                  "numeric min-h-9 min-w-9 rounded-lg px-2 text-sm font-semibold transition-colors duration-fast",
                  entry === current
                    ? "bg-accent text-fg-onAccent shadow-e1"
                    : "text-fg-muted hover:bg-surface-sunken hover:text-fg"
                )}
              >
                {entry}
              </button>
            </li>
          )
        )}
      </ul>

      <button
        type="button"
        onClick={() => onChange(current + 1)}
        disabled={current === total}
        aria-label="صفحه بعد"
        className={stepClass}
      >
        <ChevronLeft aria-hidden size={17} />
      </button>
    </nav>
  );
}

const stepClass =
  "grid min-h-9 min-w-9 place-items-center rounded-lg text-fg-muted transition-colors duration-fast hover:bg-surface-sunken hover:text-fg disabled:pointer-events-none disabled:opacity-40";

/**
 * Builds the visible window: always the first and last page, the current page
 * with a neighbour either side, and an ellipsis wherever a range was collapsed.
 */
function pageWindow(current: number, total: number): (number | "ellipsis")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);

  const out: (number | "ellipsis")[] = [1];
  const from = Math.max(2, current - 1);
  const to = Math.min(total - 1, current + 1);

  if (from > 2) out.push("ellipsis");
  for (let page = from; page <= to; page += 1) out.push(page);
  if (to < total - 1) out.push("ellipsis");

  out.push(total);
  return out;
}

/**
 * "Load more" — pagination's cousin, for a cursor-based feed where pages are not
 * addressable. Announces the loaded count through aria-live so a screen-reader
 * user knows something arrived, which an infinite list otherwise never says.
 */
export function LoadMore({
  onClick,
  loading,
  exhausted,
  loadedCount,
  className,
}: {
  onClick: () => void;
  loading: boolean;
  exhausted: boolean;
  loadedCount: number;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center gap-2", className)}>
      <p role="status" aria-live="polite" className="numeric text-xs text-fg-subtle">
        {loading ? "در حال بارگذاری…" : `${loadedCount} مورد نمایش داده شد`}
      </p>
      {!exhausted && (
        <button
          type="button"
          onClick={onClick}
          disabled={loading}
          className="min-h-11 rounded-lg border border-border-strong bg-surface px-6 text-sm font-semibold transition-colors duration-fast hover:bg-surface-sunken disabled:opacity-55"
        >
          نمایش بیشتر
        </button>
      )}
    </div>
  );
}

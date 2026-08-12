import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Bento Grid.
 *
 * One CSS grid where tiles span different numbers of cells, so a hero tile sits
 * among small ones like compartments in a lunchbox. The tell versus a plain card
 * grid is the SPANNING: at least one tile takes 2×2 or 2×1 cells while everything
 * stays aligned to the same tracks and the same single gap.
 *
 * Anatomy:
 *   1. Spanning tile — a normal grid item told to take two columns and/or rows.
 *   2. Gap (gutter)  — one grid-level value, never per-tile margins. That is what
 *                      makes a bento look machine-packed rather than hand-placed.
 *
 * Failure modes handled here:
 *   • Holes in the grid when a span exceeds the remaining columns in its row —
 *     `grid-auto-flow: dense` backfills them. It reorders visually relative to the
 *     DOM, which is acceptable for a dashboard of independent tiles and would NOT
 *     be for a reading order that carries meaning.
 *   • The hero tile collapsing on small screens — spans are reduced at the
 *     breakpoints, so on mobile everything is a single column.
 *   • Mismatched radii or translucent backgrounds breaking the lunchbox look —
 *     every tile shares one radius and an opaque surface, enforced by BentoTile.
 */

export function BentoGrid({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        // One gap value for the whole grid; dense flow closes accidental holes.
        "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4 [grid-auto-flow:dense]",
        className
      )}
    >
      {children}
    </div>
  );
}

/**
 * A tile. `span` reduces itself at each breakpoint, so nothing overflows at 320px.
 */
export function BentoTile({
  span = "1x1",
  children,
  className,
}: {
  span?: "1x1" | "2x1" | "1x2" | "2x2";
  children: ReactNode;
  className?: string;
}) {
  const spans = {
    "1x1": "",
    "2x1": "sm:col-span-2",
    "1x2": "sm:row-span-2",
    "2x2": "sm:col-span-2 sm:row-span-2",
  } as const;

  return (
    <div
      className={cn(
        // Identical radius + opaque surface on every tile: the composition has to
        // read as one rounded box of compartments.
        "flex flex-col rounded-xl border border-border bg-surface p-4 shadow-e1",
        spans[span],
        className
      )}
    >
      {children}
    </div>
  );
}

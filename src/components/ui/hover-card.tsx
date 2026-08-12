"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Hover Card (a.k.a. hover preview / profile preview).
 *
 * A rich preview of a linked object — more than a tooltip, less than a dialog:
 * it may carry passive metadata and it leaves the page fully usable underneath.
 *
 * Anatomy:
 *   1. Preview trigger — the element that reveals the card.
 *   2. Preview content — the richer preview panel.
 *
 * The classic failure modes, each handled deliberately:
 *
 *   • Closing while the pointer travels from trigger to card. There is a close
 *     DELAY plus a bridging gap-free wrapper, so crossing the gap keeps it open.
 *   • Flicker on skim. An open delay means brushing past a row of usernames does
 *     not fire a card per name.
 *   • Touch devices never opening it — there is no hover. Focus opens it too, and
 *     the trigger stays a real link/button, so tapping just navigates. The preview
 *     is strictly supplementary: nothing lives only inside it.
 *   • Trapped under another stacking context — the content is positioned in the
 *     same wrapper with an explicit z-index rather than portaled.
 *
 * `aria-describedby` links trigger to content, so a screen reader hears the
 * preview as a description of the link instead of as an unrelated region.
 */

const OPEN_DELAY_MS = 240;
const CLOSE_DELAY_MS = 180;

export function HoverCard({
  trigger,
  children,
  align = "start",
  className,
}: {
  trigger: ReactNode;
  children: ReactNode;
  align?: "start" | "center" | "end";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);

  function clearTimers() {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current);
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  }

  useEffect(() => clearTimers, []);

  function scheduleOpen() {
    clearTimers();
    openTimer.current = window.setTimeout(() => setOpen(true), OPEN_DELAY_MS);
  }

  function scheduleClose() {
    clearTimers();
    closeTimer.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  }

  return (
    <span
      className="relative inline-flex"
      onPointerEnter={(event) => {
        // Ignore touch: there is no hover, and the trigger's own action wins.
        if (event.pointerType === "touch") return;
        scheduleOpen();
      }}
      onPointerLeave={scheduleClose}
      onFocus={() => setOpen(true)}
      onBlur={scheduleClose}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          clearTimers();
          setOpen(false);
        }
      }}
    >
      <span aria-describedby={open ? contentId : undefined}>{trigger}</span>

      {open && (
        <span
          id={contentId}
          role="tooltip"
          className={cn(
            // pt-2 is the bridge: the pointer crosses padding, never a dead gap.
            "absolute top-full z-50 block pt-2",
            align === "start" && "start-0",
            align === "center" && "start-1/2 -translate-x-1/2",
            align === "end" && "end-0"
          )}
        >
          <span
            className={cn(
              "animate-pop-in block w-64 rounded-xl border border-border bg-surface-raised p-3 text-start shadow-e3",
              className
            )}
          >
            {children}
          </span>
        </span>
      )}
    </span>
  );
}

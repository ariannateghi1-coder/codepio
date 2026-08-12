"use client";

import { cn } from "@/lib/cn";

/**
 * Toggle group used as a segmented control for Explore filters and leaderboard
 * modes.
 *
 * Exposed as role="radiogroup" with role="radio" items and aria-checked, because
 * exactly one option is selectable; arrow keys move between segments and only the
 * active one stays in the tab order, so it behaves like a single control rather
 * than a row of buttons.
 */

export type ToggleOption<T extends string> = { value: T; label: string; hint?: string };

export function ToggleGroup<T extends string>({
  options,
  value,
  onChange,
  label,
  size = "md",
  className,
}: {
  options: ToggleOption<T>[];
  value: T;
  onChange: (next: T) => void;
  label: string;
  size?: "sm" | "md";
  className?: string;
}) {
  function onKeyDown(event: React.KeyboardEvent, index: number) {
    // RTL-aware: ArrowLeft moves forward visually in an RTL row.
    const forward = event.key === "ArrowLeft" || event.key === "ArrowDown";
    const backward = event.key === "ArrowRight" || event.key === "ArrowUp";
    if (!forward && !backward) return;
    event.preventDefault();
    const next = forward ? (index + 1) % options.length : (index - 1 + options.length) % options.length;
    onChange(options[next].value);
    const container = event.currentTarget.parentElement;
    const target = container?.children[next];
    if (target instanceof HTMLElement) target.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        "no-scrollbar flex max-w-full gap-1 overflow-x-auto rounded-pill border border-border bg-surface-sunken p-1",
        className
      )}
    >
      {options.map((option, index) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            title={option.hint}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "shrink-0 whitespace-nowrap rounded-pill font-semibold transition-all duration-fast ease-standard",
              size === "sm" ? "min-h-8 px-3 text-xs" : "min-h-9 px-4 text-sm",
              active ? "bg-surface text-fg shadow-e1" : "text-fg-muted hover:text-fg"
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

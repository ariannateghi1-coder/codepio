"use client";

import { cn } from "@/lib/cn";

/**
 * Progress indicators.
 *
 * A determinate bar exposes its value through role="progressbar" with
 * aria-valuenow, and the visible percentage is the same number that is announced.
 * Segmented steps use an ordered list with aria-current="step" on the active
 * stage, driven from one zero-based index so completed/current/upcoming are all
 * derived rather than tracked separately.
 */

export function ProgressBar({
  value,
  max = 100,
  label,
  tone = "accent",
  showValue = true,
  className,
}: {
  value: number;
  max?: number;
  label: string;
  tone?: "accent" | "success" | "warning";
  showValue?: boolean;
  className?: string;
}) {
  const percent = Math.min(100, Math.max(0, (value / Math.max(1, max)) * 100));
  const tones = { accent: "bg-accent", success: "bg-success", warning: "bg-warning" } as const;

  return (
    <div className={className}>
      <div className="mb-1.5 flex items-center justify-between text-xs">
        <span className="font-semibold text-fg-muted">{label}</span>
        {showValue && <span className="numeric font-bold text-fg">{Math.round(percent)}%</span>}
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-2 overflow-hidden rounded-pill bg-surface-sunken"
      >
        <div
          className={cn("h-full rounded-pill transition-[width] duration-slow ease-out", tones[tone])}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

export type Step = {
  label: string;
  state: "completed" | "current" | "upcoming" | "failed";
  detail?: string;
};

/**
 * Vertical step list used for live support verification: each task shows its real
 * state, so the user always knows what is done, what is in progress, and what
 * failed — never a fabricated animation.
 */
export function Steps({ steps, className }: { steps: Step[]; className?: string }) {
  return (
    <ol className={cn("flex flex-col gap-3", className)}>
      {steps.map((step, index) => {
        const isCurrent = step.state === "current";
        return (
          <li
            key={`${step.label}-${index}`}
            aria-current={isCurrent ? "step" : undefined}
            className="flex items-start gap-3"
          >
            <span
              aria-hidden
              className={cn(
                "numeric mt-0.5 grid size-6 shrink-0 place-items-center rounded-pill text-xs font-bold transition-colors duration-base",
                step.state === "completed" && "bg-success text-white",
                step.state === "current" && "bg-accent text-fg-onAccent",
                step.state === "failed" && "bg-danger text-white",
                step.state === "upcoming" && "bg-surface-sunken text-fg-subtle"
              )}
            >
              {step.state === "completed" ? "✓" : step.state === "failed" ? "!" : index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  "text-sm font-semibold",
                  step.state === "upcoming" ? "text-fg-subtle" : step.state === "failed" ? "text-danger" : "text-fg"
                )}
              >
                {step.label}
              </p>
              {step.detail && <p className="mt-0.5 text-xs leading-6 text-fg-muted">{step.detail}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Compact circular progress ring, for tight spaces like card corners. */
export function ProgressRing({ percent, size = 44, label }: { percent: number; size?: number; label: string }) {
  const clamped = Math.min(100, Math.max(0, percent));
  const stroke = 4;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      className="relative grid place-items-center"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={stroke} className="stroke-surface-sunken" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - clamped / 100)}
          className="stroke-accent transition-[stroke-dashoffset] duration-slow ease-out"
        />
      </svg>
      <span className="numeric absolute text-[0.625rem] font-bold text-fg">{Math.round(clamped)}%</span>
    </div>
  );
}

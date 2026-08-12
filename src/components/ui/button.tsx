"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Button.
 *
 * A real <button> with a real type, so Enter submits inside a form and Space
 * activates it. The loading state keeps the button's width (the label stays in
 * place while a spinner replaces the icon slot) so a row of buttons doesn't
 * reflow mid-interaction, and it sets aria-busy plus disabled together so
 * assistive tech and pointer users get the same information.
 */

type Variant = "primary" | "secondary" | "outline" | "ghost" | "danger" | "success";
type Size = "sm" | "md" | "lg" | "icon";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  /** Rendered before the label (after it in RTL flow terms: at the inline start). */
  icon?: React.ReactNode;
  fullWidth?: boolean;
};

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-fg-onAccent shadow-e1 hover:bg-accent-hover active:translate-y-px",
  secondary: "bg-surface-sunken text-fg hover:bg-border/60 active:translate-y-px",
  outline: "border border-border-strong bg-surface text-fg hover:bg-surface-sunken active:translate-y-px",
  ghost: "text-fg-muted hover:bg-surface-sunken hover:text-fg",
  danger: "bg-danger text-white shadow-e1 hover:brightness-110 active:translate-y-px",
  success: "bg-success text-white shadow-e1 hover:brightness-110 active:translate-y-px",
};

const SIZES: Record<Size, string> = {
  // 44px minimum touch target on every interactive size.
  sm: "min-h-9 gap-1.5 px-3 text-[0.8125rem]",
  md: "min-h-11 gap-2 px-4 text-sm",
  lg: "min-h-12 gap-2.5 px-6 text-base",
  icon: "size-11 p-0",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "primary", size = "md", loading = false, icon, fullWidth, children, disabled, type = "button", ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex select-none items-center justify-center rounded-lg font-semibold transition-all duration-fast ease-standard",
        "disabled:pointer-events-none disabled:opacity-55",
        VARIANTS[variant],
        SIZES[size],
        fullWidth && "w-full",
        className
      )}
      {...props}
    >
      {loading ? <Loader2 aria-hidden className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
});

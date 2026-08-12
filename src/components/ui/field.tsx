"use client";

import { forwardRef, useId, useState, type InputHTMLAttributes, type TextareaHTMLAttributes, type SelectHTMLAttributes, type ReactNode } from "react";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Form field and its named parts.
 *
 * All five parts are wired properly rather than merely positioned: the label is a
 * real <label for>, the required marker is decoration while the input itself
 * carries `required`, helper text and the validation message are linked through
 * aria-describedby, and an invalid field sets aria-invalid. That wiring is what
 * makes the field usable with a screen reader, not just visually complete.
 *
 * The placeholder is treated as an example, never as a substitute for the label.
 */

type FieldProps = {
  label: string;
  htmlFor: string;
  required?: boolean;
  /** Persistent hint under the control. */
  hint?: string;
  /** Replaces the hint when present, and is announced. */
  error?: string;
  children: ReactNode;
  className?: string;
};

export function Field({ label, htmlFor, required, hint, error, children, className }: FieldProps) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-sm font-semibold text-fg">
        {label}
        {required && (
          <span aria-hidden className="ms-1 text-danger">
            *
          </span>
        )}
      </label>
      {children}
      {error ? (
        <p id={`${htmlFor}-error`} role="alert" className="text-xs font-medium text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${htmlFor}-hint`} className="text-xs text-fg-subtle">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

const CONTROL = [
  "w-full rounded-lg border bg-surface px-3 text-fg transition-colors duration-fast",
  "placeholder:text-fg-subtle",
  "hover:border-border-strong",
  "disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:opacity-70",
  "aria-[invalid=true]:border-danger",
].join(" ");

export type InputProps = InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean };

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ className, invalid, ...props }, ref) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      aria-describedby={props.id ? (invalid ? `${props.id}-error` : `${props.id}-hint`) : undefined}
      className={cn(CONTROL, "min-h-11", className)}
      {...props}
    />
  );
});

/**
 * Password input with a visibility toggle.
 *
 * The toggle is a type="button" with an accessible name, so it never submits the
 * form, and the autocomplete token is load-bearing: it is what lets password
 * managers recognise and fill the field.
 */
export const PasswordInput = forwardRef<HTMLInputElement, InputProps>(function PasswordInput(
  { className, invalid, ...props },
  ref
) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <input
        ref={ref}
        type={visible ? "text" : "password"}
        aria-invalid={invalid || undefined}
        aria-describedby={props.id ? (invalid ? `${props.id}-error` : `${props.id}-hint`) : undefined}
        className={cn(CONTROL, "min-h-11 pe-12", className)}
        {...props}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "پنهان کردن رمز عبور" : "نمایش رمز عبور"}
        aria-pressed={visible}
        className="absolute inset-y-0 end-0 grid w-11 place-items-center rounded-lg text-fg-subtle transition-colors hover:text-fg"
      >
        {visible ? <EyeOff aria-hidden size={17} /> : <Eye aria-hidden size={17} />}
      </button>
    </div>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(
  function Textarea({ className, invalid, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        aria-invalid={invalid || undefined}
        aria-describedby={props.id ? (invalid ? `${props.id}-error` : `${props.id}-hint`) : undefined}
        // resize-y so dragging the size grip can never break the layout horizontally.
        className={cn(CONTROL, "min-h-24 resize-y py-2.5 leading-8", className)}
        {...props}
      />
    );
  }
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...props },
  ref
) {
  return (
    <select ref={ref} className={cn(CONTROL, "min-h-11 cursor-pointer appearance-none pe-8", className)} {...props}>
      {children}
    </select>
  );
});

/**
 * Switch for a binary setting: a native checkbox with role="switch", so the
 * checked state comes from the control itself rather than from styling.
 */
export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <label htmlFor={id} className="flex-1 cursor-pointer">
        <span className="block text-sm font-semibold text-fg">{label}</span>
        {description && <span className="mt-0.5 block text-xs leading-6 text-fg-subtle">{description}</span>}
      </label>
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className={cn(
          "relative h-6 w-11 shrink-0 cursor-pointer appearance-none rounded-pill border transition-colors duration-base",
          "before:absolute before:top-0.5 before:size-4.5 before:rounded-pill before:bg-white before:transition-all before:duration-base before:content-['']",
          // RTL-aware: the knob travels from the inline start, so it reads correctly
          // in both directions instead of appearing to move backwards.
          "before:end-0.5 checked:before:end-[1.375rem]",
          checked ? "border-accent bg-accent" : "border-border-strong bg-surface-sunken",
          "disabled:cursor-not-allowed disabled:opacity-60"
        )}
      />
    </div>
  );
}

"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { CheckCircle2, Info, TriangleAlert, XCircle } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Toast (snackbar).
 *
 * Rendered into a single role="status" live region in a fixed corner, so success
 * confirmations are announced without stealing focus and without covering page
 * content. Auto-dismiss applies only to non-essential messages, and the timer is
 * paused while the toast is hovered or contains keyboard focus.
 */

type Tone = "success" | "error" | "info" | "warning";
type Toast = { id: number; tone: Tone; message: string; persistent?: boolean };

const ToastContext = createContext<{ push: (toast: Omit<Toast, "id">) => void } | null>(null);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used inside <ToastProvider>");
  return context;
}

const AUTO_DISMISS_MS = 5000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [paused, setPaused] = useState(false);

  const remove = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (toast: Omit<Toast, "id">) => {
      const id = Date.now() + Math.random();
      setToasts((current) => [...current, { ...toast, id }]);
      if (!toast.persistent) {
        // Errors stay until dismissed; informational messages retire themselves.
        const delay = toast.tone === "error" ? AUTO_DISMISS_MS * 2 : AUTO_DISMISS_MS;
        window.setTimeout(() => {
          if (!paused) remove(id);
        }, delay);
      }
    },
    [paused, remove]
  );

  const value = useMemo(() => ({ push }), [push]);

  const icons = {
    success: <CheckCircle2 aria-hidden size={18} className="text-success" />,
    error: <XCircle aria-hidden size={18} className="text-danger" />,
    warning: <TriangleAlert aria-hidden size={18} className="text-warning" />,
    info: <Info aria-hidden size={18} className="text-info" />,
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        role="status"
        aria-live="polite"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        onFocus={() => setPaused(true)}
        onBlur={() => setPaused(false)}
        className="pointer-events-none fixed bottom-4 start-4 z-[100] flex w-[min(92vw,22rem)] flex-col gap-2"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cn(
              "pointer-events-auto flex items-start gap-2.5 rounded-lg border border-border bg-surface p-3 text-sm shadow-e2 animate-rise"
            )}
          >
            {icons[toast.tone]}
            <p className="flex-1 leading-7 text-fg">{toast.message}</p>
            <button
              type="button"
              onClick={() => remove(toast.id)}
              aria-label="بستن پیام"
              className="grid size-6 place-items-center rounded-md text-fg-subtle transition-colors hover:bg-surface-sunken hover:text-fg"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

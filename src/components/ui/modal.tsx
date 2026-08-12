"use client";

import { useCallback, useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Modal dialog / drawer / sheet.
 *
 * Built on the native <dialog> element opened with showModal(), so the browser
 * itself provides the top layer, makes the rest of the page inert, renders the
 * ::backdrop scrim, and handles Esc — rather than a div that reimplements focus
 * trapping badly.
 *
 * Variants differ only in placement:
 *   dialog — centred, for a short decision or focused task
 *   drawer — attached to the inline edge, keeps more context (RTL-aware)
 *   sheet  — rises from the bottom, for compact/mobile actions
 *
 * On close, focus returns to the element that opened it.
 */

type Variant = "dialog" | "drawer" | "sheet";

export function Modal({
  open,
  onClose,
  title,
  description,
  variant = "dialog",
  footer,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  variant?: Variant;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  const id = useId();
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      opener.current = document.activeElement;
      dialog.showModal();
      // Body scroll lock while a modal surface is open.
      document.body.style.overflow = "hidden";
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  const handleClose = useCallback(() => {
    document.body.style.overflow = "";
    if (opener.current instanceof HTMLElement) opener.current.focus();
    onClose();
  }, [onClose]);

  // Esc triggers the native cancel event; route it through our close handler so
  // scroll lock and focus restoration always run.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const onCancel = (event: Event) => {
      event.preventDefault();
      handleClose();
    };
    dialog.addEventListener("cancel", onCancel);
    dialog.addEventListener("close", handleClose);
    return () => {
      dialog.removeEventListener("cancel", onCancel);
      dialog.removeEventListener("close", handleClose);
    };
  }, [handleClose]);

  const placement =
    variant === "drawer"
      ? "me-auto h-dvh max-h-dvh w-[min(92vw,26rem)] rounded-none rounded-s-2xl animate-drawer"
      : variant === "sheet"
        ? "mt-auto mb-0 w-full max-w-none rounded-b-none rounded-t-2xl animate-rise sm:mx-auto sm:w-[min(96vw,34rem)]"
        : "m-auto w-[min(94vw,32rem)] rounded-2xl animate-pop-in";

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      // Clicking the backdrop (the dialog element's own padding area) dismisses.
      onClick={(event) => {
        if (event.target === ref.current) handleClose();
      }}
      className={cn(
        "max-h-[92dvh] max-w-none border border-border bg-surface p-0 text-fg shadow-e3",
        "backdrop:bg-[hsl(var(--overlay))] backdrop:backdrop-blur-sm",
        placement,
        className
      )}
    >
      <div className="flex max-h-[inherit] flex-col">
        <header className="flex items-start justify-between gap-4 border-b border-border p-4">
          <div>
            <h2 id={titleId} className="text-base font-bold">
              {title}
            </h2>
            {description && (
              <p id={descriptionId} className="mt-1 text-sm leading-7 text-fg-muted">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={handleClose}
            aria-label="بستن"
            className="grid size-9 shrink-0 place-items-center rounded-lg text-fg-subtle transition-colors hover:bg-surface-sunken hover:text-fg"
          >
            <X aria-hidden size={18} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>

        {footer && (
          <footer className="flex flex-col-reverse gap-2 border-t border-border p-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
            {footer}
          </footer>
        )}
      </div>
    </dialog>
  );
}

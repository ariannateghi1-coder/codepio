import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Shared shell for the auth pages: a single column, generous spacing, and no
 * app chrome, so the form is the only thing competing for attention.
 */
export function AuthShell({ title, description, children, footer }: { title: string; description: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <main id="main" className="grid min-h-dvh place-items-center px-4 py-12">
      <div className="w-full max-w-md">
        <Link href="/" className="mb-8 flex items-center justify-center gap-2.5">
          <span aria-hidden className="grid size-10 place-items-center rounded-lg bg-accent text-sm font-black text-fg-onAccent">
            AS
          </span>
          <b className="text-base">آکادمی حمایت</b>
        </Link>

        <div className="rounded-2xl border border-border bg-surface p-6 shadow-e2 sm:p-8">
          <h1 className="text-xl font-black">{title}</h1>
          <p className="mb-6 mt-2 text-sm leading-8 text-fg-muted">{description}</p>
          {children}
        </div>

        {footer && <div className="mt-5 text-center text-sm text-fg-muted">{footer}</div>}
      </div>
    </main>
  );
}

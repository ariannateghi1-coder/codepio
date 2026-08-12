"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/states";
import { useEffect } from "react";

/**
 * Route error boundary.
 *
 * The user gets a recovery action, never a raw stack trace. The real error is
 * logged to the browser console in development only; in production the server has
 * already recorded it with a request id.
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") console.error(error);
  }, [error]);

  return (
    <main id="main" className="grid min-h-dvh place-items-center px-4">
      <div className="w-full max-w-md text-center">
        <h1 className="mb-2 text-xl font-black">مشکلی پیش آمد</h1>
        <p className="mb-6 text-sm leading-8 text-fg-muted">
          این خطا ثبت شد. می‌توانید دوباره تلاش کنید یا به صفحه اصلی بازگردید.
        </p>
        <ErrorState message="بارگذاری این بخش ممکن نشد." onRetry={reset} />
        <Link href="/" className="mt-4 inline-block">
          <Button variant="ghost">بازگشت به خانه</Button>
        </Link>
        {error.digest && (
          <p className="latin mt-4 text-xs text-fg-subtle" dir="ltr">
            ref: {error.digest}
          </p>
        )}
      </div>
    </main>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { AuthShell } from "../auth-shell";
import { ResetPasswordForm } from "@/components/data/password-reset-forms";
import { isResetTokenUsable } from "@/lib/services/password-reset";
import { Alert } from "@/components/ui/states";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "تعیین رمز عبور جدید",
  description: "رمز عبور جدید خود را انتخاب کنید.",
  robots: { index: false, follow: false },
};

/**
 * Reset page.
 *
 * The token is validated on the server before the form is rendered, so a dead or
 * already-used link produces a clear explanation and a way forward instead of a
 * form that can only fail on submit.
 *
 * This is a Server Component and force-dynamic: the token arrives in the query
 * string and its validity changes over time, so any caching or prerendering of
 * this page would be wrong. The probe returns a boolean only — it never reveals
 * which address the token belongs to.
 */
export const dynamic = "force-dynamic";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token = "" } = await searchParams;
  const usable = await isResetTokenUsable(token);

  if (!usable) {
    return (
      <AuthShell title="پیوند معتبر نیست" description="این پیوند بازیابی منقضی شده، قبلاً استفاده شده یا نادرست است.">
        <div className="space-y-4">
          <Alert tone="warning" live="status">
            پیوندهای بازیابی ۳۰ دقیقه اعتبار دارند و فقط یک‌بار قابل استفاده‌اند. یک درخواست تازه ثبت کنید.
          </Alert>
          <Link href="/auth/forgot-password">
            <Button fullWidth>درخواست پیوند جدید</Button>
          </Link>
          <Link href="/auth/login">
            <Button variant="outline" fullWidth>
              بازگشت به ورود
            </Button>
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="تعیین رمز عبور جدید"
      description="یک رمز عبور تازه انتخاب کنید. پس از ثبت، همه نشست‌های قبلی بسته می‌شوند."
    >
      <ResetPasswordForm token={token} />
    </AuthShell>
  );
}

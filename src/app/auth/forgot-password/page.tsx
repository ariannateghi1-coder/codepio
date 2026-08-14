import type { Metadata } from "next";
import Link from "next/link";
import { AuthShell } from "../auth-shell";
import { ForgotPasswordForm } from "@/components/data/password-reset-forms";

export const metadata: Metadata = {
  title: "بازیابی رمز عبور",
  description: "پیوند بازیابی رمز عبور را دریافت کنید.",
  robots: { index: false, follow: false },
};

export default function ForgotPasswordPage() {
  return (
    <AuthShell
      title="بازیابی رمز عبور"
      description="ایمیل حساب خود را وارد کنید تا پیوند تعیین رمز جدید برایتان ارسال شود."
      footer={
        <>
          رمز عبور را به یاد آوردید؟{" "}
          <Link href="/auth/login" className="font-bold text-accent">
            ورود
          </Link>
        </>
      }
    >
      <ForgotPasswordForm />
    </AuthShell>
  );
}

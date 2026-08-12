import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AuthShell } from "../auth-shell";
import { LoginForm } from "@/components/data/auth-forms";

export const metadata: Metadata = {
  title: "ورود",
  description: "به حساب خود وارد شوید.",
  robots: { index: false, follow: false },
};

export default function LoginPage() {
  return (
    <AuthShell
      title="ورود به آکادمی"
      description="وارد شوید تا حمایت‌ها، اعتبار و رتبه خود را دنبال کنید."
      footer={
        <>
          حساب ندارید؟{" "}
          <Link href="/auth/register" className="font-bold text-accent">
            ثبت‌نام کنید
          </Link>
        </>
      }
    >
      {/* useSearchParams needs a Suspense boundary during static rendering. */}
      <Suspense fallback={<div className="skeleton h-56 w-full rounded-lg" />}>
        <LoginForm />
      </Suspense>
      <div className="mt-5 text-center">
      </div>
    </AuthShell>
  );
}

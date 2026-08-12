import type { Metadata } from "next";
import Link from "next/link";
import { AuthShell } from "../auth-shell";
import { RegisterForm } from "@/components/data/auth-forms";

export const metadata: Metadata = {
  title: "ثبت‌نام",
  description: "حساب خود را بسازید و وارد اکوسیستم حمایت واقعی شوید.",
  robots: { index: false, follow: false },
};

export default function RegisterPage() {
  return (
    <AuthShell
      title="ساخت حساب"
      description="پس از ثبت‌نام، ایمیل خود را تأیید کنید تا امکان ثبت حمایت فعال شود."
      footer={
        <>
          حساب دارید؟{" "}
          <Link href="/auth/login" className="font-bold text-accent">
            ورود
          </Link>
        </>
      }
    >
      <RegisterForm />
    </AuthShell>
  );
}

import type { Metadata } from "next";
import { AppShell } from "@/components/layout/app-shell";
import { PageHeader } from "@/components/layout/page";
import { ProfileForm } from "@/components/data/profile-form";
import { requireUserForPage } from "@/lib/security";

export const metadata: Metadata = { title: "پروفایل", robots: { index: false, follow: false } };

export default async function ProfileSettingsPage() {
  await requireUserForPage();
  return (
    <AppShell>
      <PageHeader title="پروفایل" description="اطلاعات نمایشی حساب شما در پروفایل عمومی." />
      <ProfileForm />
    </AppShell>
  );
}

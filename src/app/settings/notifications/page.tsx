import type { Metadata } from "next";
import { AppShell } from "@/components/layout/app-shell";
import { PageHeader } from "@/components/layout/page";
import { PushSettings } from "@/components/data/push-settings";
import { requireUserForPage } from "@/lib/security";

export const metadata: Metadata = { title: "اعلان‌ها", robots: { index: false, follow: false } };

export default async function NotificationSettingsPage() {
  await requireUserForPage();
  return (
    <AppShell>
      <PageHeader title="تنظیمات اعلان" description="کنترل اعلان‌های مرورگر برای رویدادهای حساب." />
      <PushSettings />
    </AppShell>
  );
}

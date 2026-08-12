import type { Metadata } from "next";
import { AppShell } from "@/components/layout/app-shell";
import { PageHeader } from "@/components/layout/page";
import { NotificationsView } from "@/components/data/notifications-view";
import { requireUserForPage } from "@/lib/security";

export const metadata: Metadata = {
  title: "اعلان‌ها",
  robots: { index: false, follow: false },
};

export default async function NotificationsPage() {
  await requireUserForPage();

  return (
    <AppShell>
      <PageHeader title="اعلان‌ها" description="رویدادهای حساب، حمایت‌ها و پیام‌های سیستمی." />
      <NotificationsView />
    </AppShell>
  );
}

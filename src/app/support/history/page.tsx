import type { Metadata } from "next";
import { AppShell } from "@/components/layout/app-shell";
import { PageHeader } from "@/components/layout/page";
import { SupportHistoryView } from "@/components/data/support-history-view";
import { requireUserForPage } from "@/lib/security";

export const metadata: Metadata = {
  title: "تاریخچه حمایت",
  robots: { index: false, follow: false },
};

export default async function SupportHistoryPage() {
  await requireUserForPage();

  return (
    <AppShell>
      <PageHeader
        title="تاریخچه حمایت"
        description="همه حمایت‌ها با جزئیات پاداش. حمایت‌های برگشت‌خورده نمایش داده می‌شوند اما در آمار محاسبه نمی‌شوند."
      />
      <SupportHistoryView />
    </AppShell>
  );
}

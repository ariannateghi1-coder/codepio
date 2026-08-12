import type { Metadata } from "next";
import { AppShell } from "@/components/layout/app-shell";
import { PageHeader } from "@/components/layout/page";
import { AdminBroadcastForm } from "@/components/admin/admin-broadcast-form";
import { requireStaffForPage } from "@/lib/security";

export const metadata: Metadata = { title: "اعلان همگانی", robots: { index: false, follow: false } };

export default async function AdminNotificationsPage() {
  await requireStaffForPage(["ADMIN", "SUPER_ADMIN"]);
  return (
    <AppShell>
      <PageHeader title="اعلان همگانی" description="ارسال اطلاعیه به گروهی از کاربران. هر ارسال در گزارش عملیات ثبت می‌شود." />
      <AdminBroadcastForm />
    </AppShell>
  );
}

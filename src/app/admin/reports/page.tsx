import type { Metadata } from "next";
import { AppShell } from "@/components/layout/app-shell";
import { PageHeader } from "@/components/layout/page";
import { AdminReportsTable } from "@/components/admin/admin-reports-table";
import { requireStaffForPage } from "@/lib/security";

export const metadata: Metadata = { title: "گزارش‌ها", robots: { index: false, follow: false } };

export default async function AdminReportsPage() {
  await requireStaffForPage();
  return (
    <AppShell>
      <PageHeader title="گزارش‌ها" description="گردش‌کار بررسی تخلف با اثر واقعی روی اعتبار و محتوا." />
      <AdminReportsTable />
    </AppShell>
  );
}

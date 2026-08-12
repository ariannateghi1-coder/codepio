import type { Metadata } from "next";
import { AppShell } from "@/components/layout/app-shell";
import { PageHeader } from "@/components/layout/page";
import { AdminOverview } from "@/components/admin/admin-overview";

export const metadata: Metadata = { title: "مدیریت", robots: { index: false, follow: false } };

export default function AdminPage() {
  return (
    <AppShell>
      <PageHeader title="کنسول مدیریت" description="وضعیت پلتفرم، صف بررسی و سلامت اقتصاد اعتبار." />
      <AdminOverview />
    </AppShell>
  );
}

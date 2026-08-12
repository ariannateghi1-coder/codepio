import type { Metadata } from "next";
import { AppShell } from "@/components/layout/app-shell";
import { PageHeader } from "@/components/layout/page";
import { AdminCampaignsTable } from "@/components/admin/admin-campaigns-table";
import { requireStaffForPage } from "@/lib/security";

export const metadata: Metadata = { title: "کمپین‌ها", robots: { index: false, follow: false } };

export default async function AdminCampaignsPage() {
  await requireStaffForPage(["ADMIN", "SUPER_ADMIN"]);
  return (
    <AppShell>
      <PageHeader title="کمپین‌ها" description="نظارت بر همه کمپین‌های پلتفرم و بودجه پاداش آن‌ها." />
      <AdminCampaignsTable />
    </AppShell>
  );
}

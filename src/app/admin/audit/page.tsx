import type { Metadata } from "next";
import { AppShell } from "@/components/layout/app-shell";
import { PageHeader } from "@/components/layout/page";
import { AdminAuditTable } from "@/components/admin/admin-audit-table";
import { requireStaffForPage } from "@/lib/security";

export const metadata: Metadata = { title: "گزارش عملیات", robots: { index: false, follow: false } };

export default async function AdminAuditPage() {
  await requireStaffForPage(["ADMIN", "SUPER_ADMIN"]);
  return (
    <AppShell>
      <PageHeader title="گزارش عملیات" description="ردگیری اقدامات حساس: ورود، تغییر رمز، برگشت حمایت و اصلاح اعتبار." />
      <AdminAuditTable />
    </AppShell>
  );
}

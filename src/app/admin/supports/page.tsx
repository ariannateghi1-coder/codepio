import type { Metadata } from "next";
import { AppShell } from "@/components/layout/app-shell";
import { PageHeader } from "@/components/layout/page";
import { AdminSupportsTable } from "@/components/admin/admin-supports-table";
import { requireStaffForPage } from "@/lib/security";

export const metadata: Metadata = { title: "مدیریت حمایت‌ها", robots: { index: false, follow: false } };

type Filter = "PENDING_REVIEW" | "ALL" | "ACTIVE" | "REVERSED";

export default async function AdminSupportsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  await requireStaffForPage();
  const { status } = await searchParams;
  const allowed: Filter[] = ["PENDING_REVIEW", "ALL", "ACTIVE", "REVERSED"];
  const initial = allowed.includes(status as Filter) ? (status as Filter) : "PENDING_REVIEW";

  return (
    <AppShell>
      <PageHeader
        title="حمایت‌ها"
        description="صف بررسی پاداش‌های نگه‌داشته‌شده و امکان برگشت حمایت با اصلاح کامل دفتر حساب."
      />
      <AdminSupportsTable initialFilter={initial} />
    </AppShell>
  );
}

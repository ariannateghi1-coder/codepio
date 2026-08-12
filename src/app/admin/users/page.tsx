import type { Metadata } from "next";
import { AppShell } from "@/components/layout/app-shell";
import { PageHeader } from "@/components/layout/page";
import { AdminUsersTable } from "@/components/admin/admin-users-table";
import { requireStaffForPage } from "@/lib/security";

export const metadata: Metadata = { title: "مدیریت کاربران", robots: { index: false, follow: false } };

export default async function AdminUsersPage() {
  // The viewer's role is resolved server-side and passed down, so the client never
  // decides for itself which privileged actions to offer.
  const user = await requireStaffForPage();

  return (
    <AppShell>
      <PageHeader title="کاربران" description="وضعیت، سطح دسترسی و سلامت حساب‌ها. هر اقدام در گزارش عملیات ثبت می‌شود." />
      <AdminUsersTable viewerRole={user.role} />
    </AppShell>
  );
}

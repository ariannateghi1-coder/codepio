import type { Metadata } from "next";
import { AppShell } from "@/components/layout/app-shell";
import { PageHeader } from "@/components/layout/page";
import { DashboardView } from "@/components/data/dashboard-view";
import { requireUserForPage } from "@/lib/security";

export const metadata: Metadata = {
  title: "داشبورد",
  robots: { index: false, follow: false },
};

/**
 * Server-side guard first: the page redirects unauthenticated visitors before any
 * markup renders. The middleware only provides the fast path — this is the real
 * check, since it can actually validate the session against the database.
 */
export default async function DashboardPage() {
  const user = await requireUserForPage();

  return (
    <AppShell>
      <PageHeader title="داشبورد" description={`مرکز کنترل فعالیت، اعتبار و کمپین‌های ${user.name}.`} />
      <DashboardView />
    </AppShell>
  );
}

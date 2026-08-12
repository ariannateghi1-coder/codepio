import type { Metadata } from "next";
import { AppShell } from "@/components/layout/app-shell";
import { PageHeader } from "@/components/layout/page";
import { SecuritySettings } from "@/components/data/security-settings";
import { requireUserForPage } from "@/lib/security";

export const metadata: Metadata = { title: "امنیت", robots: { index: false, follow: false } };

export default async function SecuritySettingsPage() {
  await requireUserForPage();
  return (
    <AppShell>
      <PageHeader title="امنیت" description="رمز عبور، نشست‌های فعال و وضعیت حساب." />
      <SecuritySettings />
    </AppShell>
  );
}

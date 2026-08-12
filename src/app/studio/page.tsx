import type { Metadata } from "next";
import { AppShell } from "@/components/layout/app-shell";
import { PageHeader } from "@/components/layout/page";
import { StudioView } from "@/components/data/studio-view";
import { requireUserForPage } from "@/lib/security";

export const metadata: Metadata = {
  title: "استودیو",
  robots: { index: false, follow: false },
};

export default async function StudioPage() {
  await requireUserForPage();

  return (
    <AppShell>
      <PageHeader title="استودیو" description="ویدیوها و کمپین‌های خود را مدیریت کنید و آمار واقعی حمایت‌ها را ببینید." />
      <StudioView />
    </AppShell>
  );
}

import type { Metadata } from "next";
import { AppShell } from "@/components/layout/app-shell";
import { PageHeader } from "@/components/layout/page";
import { YoutubeSettings } from "@/components/data/youtube-settings";
import { requireUserForPage } from "@/lib/security";

export const metadata: Metadata = { title: "کانال یوتیوب", robots: { index: false, follow: false } };

export default async function YoutubeSettingsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  await requireUserForPage();
  const { status } = await searchParams;

  return (
    <AppShell>
      <PageHeader
        title="کانال یوتیوب"
        description="اتصال حساب، تأیید مالکیت کانال و مشاهده دقیق اینکه چه چیزی قابل تأیید است."
      />
      <YoutubeSettings status={status} />
    </AppShell>
  );
}

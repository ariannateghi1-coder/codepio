import type { Metadata } from "next";
import { AppShell } from "@/components/layout/app-shell";
import { PageHeader } from "@/components/layout/page";
import { MembersView } from "@/components/data/members-view";

export const metadata: Metadata = {
  title: "اعضا",
  description: "اعضای فعال آکادمی حمایت را پیدا کنید.",
};

export default function MembersPage() {
  return (
    <AppShell>
      <PageHeader title="اعضا" description="اعضای فعال را بر اساس اعتبار و فعالیت واقعی پیدا کنید." />
      <MembersView />
    </AppShell>
  );
}

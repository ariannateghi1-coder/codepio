import type { Metadata } from "next";
import { AppShell } from "@/components/layout/app-shell";
import { PageHeader } from "@/components/layout/page";
import { LeaderboardView } from "@/components/data/leaderboard-view";

export const metadata: Metadata = {
  title: "رتبه‌بندی",
  description: "حامیان و سازندگان برتر بر اساس امتیاز واقعی دوره.",
};

export default function LeaderboardPage() {
  return (
    <AppShell>
      <PageHeader
        title="رتبه‌بندی"
        description="امتیاز هر دوره از دفتر حساب واقعی محاسبه می‌شود؛ حمایت‌های برگشتی در آن اثر ندارند."
      />
      <LeaderboardView />
    </AppShell>
  );
}

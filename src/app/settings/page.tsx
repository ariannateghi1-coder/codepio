import type { Metadata } from "next";
import Link from "next/link";
import { Bell, ShieldCheck, UserRound, Youtube } from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";
import { PageHeader } from "@/components/layout/page";
import { Card } from "@/components/ui/card";
import { requireUserForPage } from "@/lib/security";

export const metadata: Metadata = {
  title: "تنظیمات",
  robots: { index: false, follow: false },
};

const SECTIONS = [
  { href: "/settings/profile", title: "پروفایل", description: "نام، بیوگرافی، آواتار و کشور.", icon: UserRound },
  { href: "/settings/youtube", title: "کانال یوتیوب", description: "اتصال حساب و تأیید مالکیت کانال.", icon: Youtube },
  { href: "/settings/notifications", title: "اعلان‌ها", description: "اعلان مرورگر و رویدادهای لحظه‌ای.", icon: Bell },
  { href: "/settings/security", title: "امنیت", description: "رمز عبور، نشست‌های فعال و غیرفعال‌سازی حساب.", icon: ShieldCheck },
] as const;

export default async function SettingsPage() {
  const user = await requireUserForPage();

  return (
    <AppShell>
      <PageHeader title="تنظیمات" description={`حساب و ترجیحات ${user.name} را مدیریت کنید.`} />

      <ul className="grid gap-4 sm:grid-cols-2">
        {SECTIONS.map((section) => {
          const Icon = section.icon;
          return (
            <li key={section.href}>
              <Link href={section.href}>
                <Card interactive className="h-full p-5">
                  <span aria-hidden className="mb-3 grid size-10 place-items-center rounded-lg bg-accent-soft text-accent">
                    <Icon size={18} />
                  </span>
                  <h2 className="text-sm font-bold">{section.title}</h2>
                  <p className="mt-1.5 text-sm leading-7 text-fg-muted">{section.description}</p>
                </Card>
              </Link>
            </li>
          );
        })}
      </ul>
    </AppShell>
  );
}

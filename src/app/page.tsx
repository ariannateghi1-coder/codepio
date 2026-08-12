import type { Metadata } from "next";
import Link from "next/link";
import { unstable_cache } from "next/cache";
import { ArrowLeft, BadgeCheck, Compass, Eye, Heart, ShieldCheck, ThumbsUp, TrendingUp, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/badge";
import { prisma } from "@/lib/prisma";
import { formatCompact } from "@/lib/cn";

export const metadata: Metadata = {
  title: "آکادمی حمایت — حمایت واقعی، اعتبار واقعی",
  description:
    "اکوسیستمی که در آن حمایت با تماشا، سابسکرایب و لایک تأییدشده انجام می‌شود؛ اعتبار می‌سازید و در کاوش دیده می‌شوید.",
  alternates: { canonical: "/" },
};

/**
 * Landing page.
 *
 * The stats are real aggregates, not decorative numbers, and the copy states
 * plainly what the platform can and cannot verify — the same honesty rule the
 * product enforces internally. Nothing here claims a metric that isn't measured.
 *
 * Rendered per request with the aggregate query cached for 5 minutes. It is
 * deliberately NOT statically prerendered: a build would then need a reachable
 * database, and the first visitors after a deploy would be served whatever the
 * numbers happened to be at build time.
 */
export const dynamic = "force-dynamic";

const getPublicStats = unstable_cache(
  async () => {
    const [creators, supports, campaigns] = await Promise.all([
      prisma.user.count({ where: { status: "ACTIVE" } }),
      prisma.support.count({ where: { status: "ACTIVE" } }),
      prisma.campaign.count({ where: { status: "ACTIVE", endAt: { gte: new Date() } } }),
    ]);
    return { creators, supports, campaigns };
  },
  ["landing-public-stats"],
  { revalidate: 300, tags: ["public-stats"] }
);

const LOOP = [
  { icon: Compass, title: "کشف کن", body: "در کاوش، کمپین‌های فعال سازندگان واقعی را می‌بینی." },
  { icon: Eye, title: "تماشا کن", body: "میزان تماشای واقعی سمت سرور محاسبه می‌شود، نه با کلیک ساده." },
  { icon: UserPlus, title: "سابسکرایب و لایک", body: "با اتصال حساب یوتیوب، این دو مورد با API رسمی بررسی می‌شوند." },
  { icon: Heart, title: "اعتبار بگیر", body: "پاداش‌ها در دفتر حساب ثبت می‌شوند و قابل ردیابی‌اند." },
  { icon: TrendingUp, title: "دیده شو", body: "اعتبار و کیفیت، شانس نمایش محتوای تو در کاوش را بالا می‌برد." },
] as const;

const FAQ = [
  {
    q: "آیا واقعاً می‌فهمید ویدیو را دیده‌ام؟",
    a: "میزان تماشا را خودمان از رویدادهای پلیر یوتیوب و بر اساس بخش‌هایی از تایم‌لاین که واقعاً پخش شده محاسبه می‌کنیم. پرش به دقیقه آخر به‌عنوان تماشا حساب نمی‌شود. این «ثبت‌شده توسط پلتفرم» است و ما آن را «تأییدشده توسط یوتیوب» نمی‌نامیم، چون هیچ API رسمی چنین چیزی را گزارش نمی‌دهد.",
  },
  {
    q: "سابسکرایب و لایک چطور بررسی می‌شود؟",
    a: "با اتصال حساب یوتیوب شما و از طریق API رسمی گوگل، وضعیت اشتراک و لایک بررسی می‌شود. بدون این اتصال، ما حرف کاربر را به‌عنوان اثبات نمی‌پذیریم و آن کار «تأییدنشده» می‌ماند.",
  },
  {
    q: "آیا این یک شبکه «سابسکرایب متقابل» است؟",
    a: "نه. حمایت تکراری بین دو حساب مشخص، پاداش نزولی می‌گیرد و الگوهای حلقه‌ای شناسایی می‌شوند. کیفیت حمایت مهم‌تر از تعداد آن است.",
  },
  {
    q: "اگر حمایتی جعلی تشخیص داده شود چه می‌شود؟",
    a: "حمایت برگشت می‌خورد و تمام پاداش‌های مربوط به آن در دفتر حساب معکوس می‌شود؛ اعتبار کیفی هم کاهش می‌یابد.",
  },
];

export default async function LandingPage() {
  const stats = await getPublicStats();

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-40 border-b border-border bg-surface/85 backdrop-blur-lg">
        <div className="mx-auto flex h-16 max-w-content items-center justify-between px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <span aria-hidden className="grid size-9 place-items-center rounded-lg bg-accent text-xs font-black text-fg-onAccent">
              AS
            </span>
            <b className="text-sm">آکادمی حمایت</b>
          </Link>
          <div className="flex items-center gap-2">
            <Link href="/explore">
              <Button variant="ghost" size="sm">
                کاوش
              </Button>
            </Link>
            <Link href="/auth/login">
              <Button variant="outline" size="sm">
                ورود
              </Button>
            </Link>
            <Link href="/auth/register">
              <Button size="sm">شروع</Button>
            </Link>
          </div>
        </div>
      </header>

      <main id="main">
        {/* Hero */}
        <section className="mx-auto max-w-content px-4 py-16 sm:px-6 lg:py-24">
          <div className="grid gap-12 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
            <div>
              <Pill tone="accent" icon={<ShieldCheck aria-hidden size={13} />}>
                حمایت تأییدشده، نه کلیک ساده
              </Pill>
              <h1 className="mt-5 text-3xl font-black leading-[1.35] sm:text-4xl lg:text-5xl">
                محتوا را کشف کن، حمایت واقعی انجام بده، اعتبار بساز و دیده شو.
              </h1>
              <p className="mt-5 max-w-xl text-base leading-9 text-fg-muted">
                آکادمی حمایت یک اکوسیستم رقابتی و قابل اعتماد است: هر حمایت یک اقدام واقعی و قابل‌ردیابی است، پاداش‌ها در دفتر حساب ثبت
                می‌شوند، و اعتبار شما تعیین می‌کند محتوایتان چقدر دیده شود.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link href="/auth/register">
                  <Button size="lg" icon={<ArrowLeft aria-hidden size={18} />}>
                    شروع رایگان
                  </Button>
                </Link>
                <Link href="/explore">
                  <Button size="lg" variant="outline">
                    دیدن کاوش
                  </Button>
                </Link>
              </div>

              <dl className="mt-10 grid max-w-lg grid-cols-3 gap-3">
                {[
                  { label: "عضو فعال", value: stats.creators },
                  { label: "حمایت تأییدشده", value: stats.supports },
                  { label: "کمپین فعال", value: stats.campaigns },
                ].map((item) => (
                  <div key={item.label} className="rounded-xl border border-border bg-surface p-4">
                    <dt className="text-xs text-fg-subtle">{item.label}</dt>
                    <dd className="numeric mt-1 text-xl font-black">{formatCompact(item.value)}</dd>
                  </div>
                ))}
              </dl>
            </div>

            {/* Product preview: a static, honest rendition of a real Explore card. */}
            <div className="rounded-2xl border border-border bg-surface p-4 shadow-e3">
              <div className="mb-3 flex items-center gap-2 text-xs text-fg-subtle">
                <Compass aria-hidden size={14} /> نمونه کارت کاوش
              </div>
              <div className="overflow-hidden rounded-xl border border-border">
                <div aria-hidden className="grid aspect-video place-items-center bg-surface-sunken text-fg-subtle">
                  <Eye size={26} />
                </div>
                <div className="space-y-3 p-4">
                  <p className="text-sm font-bold">چطور اولین محصولم را ساختم</p>
                  <div className="flex flex-wrap gap-1.5">
                    <Pill icon={<Eye aria-hidden size={12} />}>تماشا ۹۰٪</Pill>
                    <Pill icon={<UserPlus aria-hidden size={12} />}>سابسکرایب</Pill>
                    <Pill icon={<ThumbsUp aria-hidden size={12} />}>لایک</Pill>
                    <Pill className="opacity-70">کامنت (اختیاری)</Pill>
                  </div>
                  <div className="flex items-center justify-between rounded-lg bg-accent-soft px-3 py-2">
                    <span className="text-xs font-semibold text-accent">پاداش</span>
                    <span className="numeric text-sm font-black text-accent">+۱۲ اعتبار</span>
                  </div>
                </div>
              </div>
              <p className="mt-3 flex items-start gap-2 text-xs leading-6 text-fg-subtle">
                <BadgeCheck aria-hidden size={14} className="mt-1 shrink-0 text-success" />
                سطح تأیید هر کار روی کارت مشخص است: چه چیزی با API یوتیوب تأیید شده و چه چیزی توسط پلتفرم ثبت شده.
              </p>
            </div>
          </div>
        </section>

        {/* Loop */}
        <section className="border-y border-border bg-bg-subtle py-16">
          <div className="mx-auto max-w-content px-4 sm:px-6">
            <h2 className="text-xl font-black">چرخه محصول</h2>
            <p className="mt-2 max-w-2xl text-sm leading-8 text-fg-muted">
              کشف → حمایت → تأیید → پاداش → اعتبار → دیده‌شدن. هر مرحله سمت سرور بررسی می‌شود.
            </p>
            <ol className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              {LOOP.map((step, index) => {
                const Icon = step.icon;
                return (
                  <li key={step.title} className="rounded-xl border border-border bg-surface p-4">
                    <span aria-hidden className="mb-3 grid size-10 place-items-center rounded-lg bg-accent-soft text-accent">
                      <Icon size={18} />
                    </span>
                    <p className="numeric text-xs font-bold text-fg-subtle">{index + 1}</p>
                    <h3 className="mt-1 text-sm font-bold">{step.title}</h3>
                    <p className="mt-1.5 text-xs leading-6 text-fg-muted">{step.body}</p>
                  </li>
                );
              })}
            </ol>
          </div>
        </section>

        {/* FAQ */}
        <section className="mx-auto max-w-content px-4 py-16 sm:px-6">
          <h2 className="text-xl font-black">پرسش‌های رایج</h2>
          <div className="mt-6 grid gap-3 lg:grid-cols-2">
            {FAQ.map((item) => (
              // <details>/<summary> gives native keyboard behaviour and needs no
              // redundant aria-expanded.
              <details key={item.q} className="group rounded-xl border border-border bg-surface p-4">
                <summary className="cursor-pointer list-none text-sm font-bold marker:content-none">
                  <span className="flex items-center justify-between gap-3">
                    {item.q}
                    <span aria-hidden className="text-fg-subtle transition-transform group-open:rotate-180">
                      ⌄
                    </span>
                  </span>
                </summary>
                <p className="mt-3 text-sm leading-8 text-fg-muted">{item.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="border-t border-border bg-bg-subtle py-16">
          <div className="mx-auto max-w-content px-4 text-center sm:px-6">
            <h2 className="text-2xl font-black">آماده‌ای اعتبار واقعی بسازی؟</h2>
            <p className="mx-auto mt-3 max-w-xl text-sm leading-8 text-fg-muted">
              ثبت‌نام کن، کانالت را متصل کن، اولین کمپین را بساز و از جامعه حمایت تأییدشده بگیر.
            </p>
            <Link href="/auth/register" className="mt-7 inline-block">
              <Button size="lg">ساخت حساب</Button>
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-border py-8">
        <div className="mx-auto flex max-w-content flex-wrap items-center justify-between gap-4 px-4 text-xs text-fg-subtle sm:px-6">
          <p>© {new Date().getFullYear()} آکادمی حمایت</p>
          <nav aria-label="پیوندهای پانویس" className="flex gap-4">
            <Link href="/explore">کاوش</Link>
            <Link href="/leaderboard">رتبه‌بندی</Link>
            <Link href="/badges">نشان‌ها</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}

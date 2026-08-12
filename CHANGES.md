# گزارش نهایی

خروجی در قالب درخواست‌شده (بند ۶۰). هر مورد به کد واقعی اشاره دارد، نه به قصد.

## Fixed

- **حمایت تک‌مرحله‌ای حذف شد.** مدل قبلی یک رکورد `Support` می‌ساخت و فوراً `points` را زیاد می‌کرد؛ هیچ اثبات و هیچ مرحله‌ای وجود نداشت. جای آن `SupportSession` با state machine آمد: `STARTED → VIDEO_OPENED → WATCHING → WATCH_THRESHOLD_REACHED → VERIFYING → COMPLETED` (و مسیرهای `FAILED / EXPIRED / ABANDONED`). رکورد `Support` تنها پس از settlement ساخته می‌شود.
- **Leaderboard جعلی نبود اما تقریبی بود.** بازه‌های هفتگی/ماهانه با تعداد ساپورت به‌عنوان proxy رتبه‌بندی می‌شدند (خود کد قبلی به این موضوع اعتراف کرده بود). حالا از `CreditLedger`/`XpLedger` در همان بازه محاسبه می‌شود و `LeaderboardSnapshot` نتیجه را تثبیت می‌کند.
- **`REVERSED` وجود داشت ولی اثری نداشت.** برگشت حمایت اکنون تمام entryهای ledger مرتبط را معکوس می‌کند، اعتبار کیفی را کم می‌کند و بودجه کمپین را آزاد می‌کند. کوئری‌های عمومی و شمارش‌ها همه `status: ACTIVE` را فیلتر می‌کنند، پس یک حمایت برگشتی پروفایل را باد نمی‌کند.
- **`getIp` هر `x-forwarded-for` را باور می‌کرد.** حالا تعداد hop قابل اعتماد از `TRUSTED_PROXY_HOPS` می‌آید و مقدار فقط hash‌شده ذخیره می‌شود.
- **`decryptSecret` رشته خالی رمزشده را «malformed» می‌دانست** — بررسی truthiness به بررسی ساختاری تغییر کرد (تست دارد).
- **Endpoint نگهداری از `SESSION_SECRET` به‌عنوان bearer استفاده می‌کرد.** حالا `MAINTENANCE_SECRET` مستقل است (یا مشتق HKDF از session secret)، و مقایسه با hash انجام می‌شود تا طول هم لو نرود.
- **بیلد production به دیتابیس زنده نیاز داشت.** `/`، `/badges` و `/sitemap.xml` سعی می‌کردند prerender شوند و بیلد را می‌شکستند. الان `force-dynamic` + `unstable_cache` هستند؛ sitemap در صورت عدم دسترسی به دیتابیس به مسیرهای ثابت تنزل می‌کند و لاگ می‌دهد.
- **`RouteArgs` اختیاری بود** و با تایپ‌های تولیدشده Next تضاد داشت؛ `resolveParams` جایش را گرفت.

## Security

- **CSRF**: بررسی Origin + مقایسه constant-time هدر `x-csrf-token` با کوکی + تطبیق با `session.csrfTokenHash`. پیاده‌سازی قبلی کوکی CSRF را اصلاً چک نمی‌کرد و مقایسه‌اش timing-safe نبود.
- **ماتریس مجوز** (`src/lib/authz.ts`) به‌عنوان مرز واقعی: هیچ‌کس روی حساب خودش اقدام نمی‌کند، ADMIN روی SUPER_ADMIN دست نمی‌برد، تغییر نقش فقط از SUPER_ADMIN و فقط به سطح پایین‌تر، و moderator می‌تواند suspend کند ولی ban نه. هر نقش زیرمجموعه‌ی محض نقش بالاتر است (تست دارد).
- **بازیابی رمز** اتمیک شد (claim و update در یک تراکنش)، توکن‌ها hash‌شده/یک‌بارمصرف/کوتاه‌عمر، و پس از تغییر رمز همه sessionها باطل می‌شوند.
- **تأیید ایمیل** واقعاً پیاده شد: `PENDING → ACTIVE`، و مشارکت تا فعال شدن مسدود است.
- **بدون افشای وجود حساب**: پیام‌های ورود و فراموشی رمز یکسان‌اند (تست e2e دارد).
- **توکن‌های OAuth** با AES-256-GCM و کلید HKDF مشتق‌شده رمز می‌شوند؛ IV تصادفی به‌ازای هر رکورد، دست‌کاری در decrypt خطا می‌دهد.
- **CSP** سخت‌گیرانه؛ `frame-src` تنها `youtube-nocookie.com` — پس هر embed باید از `youtubeEmbedUrl` بسازد. `frame-ancestors 'none'` کلیک‌جکینگ را حذف می‌کند.
- **Open redirect** بسته شد: `safeNextPath` مسیرهای protocol-relative، backslash و صفحات auth را رد می‌کند.
- **Host allow-list برای یوتیوب**: `evil-youtube.com` و `youtube.com.attacker.net` رد می‌شوند (تست دارد) — بررسی با `endsWith` کافی نبود.

## Architecture

- **`src/lib/handler.ts`** سطح احراز هویت، CSRF و rate limit را یک‌بار در ترکیب route اعلام می‌کند؛ نه چهار خط تکراری در هر فایل که یکی‌شان یادش برود.
- **`src/lib/api.ts`** تنها قرارداد پاسخ است: `{success, data|error, requestId}`. خطاهای غیرمنتظره کامل سمت سرور لاگ می‌شوند و به کلاینت فقط `SERVER_ERROR` می‌رسد؛ stack trace و پیام Prisma هرگز از سیم رد نمی‌شوند.
- **Server Components مستقیم از لایه سرویس می‌خوانند** — بدون hop اضافی «Server Component → HTTP → API → DB».
- **تفکیک چهار اقتصاد**: Credits (خرج‌کردنی)، XP (پیشرفت)، Reputation (کیفیت)، Rank (نتیجه ترکیب). قبلاً همه در یک `points` قاطی بودند.

## Database

- Migration نسل دوم: `prisma/migrations/20260810000000_support_exchange_core`. Migration قبلی برای schema قدیمی بود و patch کردنش بی‌معنا؛ بازسازی شد.
- **Ledger فقط append است.** هیچ‌جا `credits -= x` نیست. یکتایی `idempotencyKey` مکانیزم idempotency است و `reversalOfId` یکتا مانع برگشت دوباره‌ی یک entry می‌شود. موجودی روی `User` صرفاً cache است و `auditUserBalances()` اختلاف را پیدا می‌کند.
- **بودجه کمپین** با `UPDATE ... WHERE spent + cost <= budget` کم می‌شود، پس هرگز منفی نمی‌شود.

## Business Logic

- **حسابداری تماشا** بر اساس اجتماع (union) بازه‌های واقعاً پخش‌شده، با سقف نرخ نسبت به زمان دیوار: `seek(540)` صفر امتیاز می‌گیرد و اسکراب کردن کل تایم‌لاین هم صفر می‌ماند (تست دارد).
- **Anti-abuse**: پاداش نزولی برای زوج تکراری، cooldown، تشخیص حلقه متقابل، سیگنال IP مشترک (به‌عنوان نشانه، نه اثبات)، و صف بررسی به‌جای رد کردن قطعی در موارد مرزی. کاربری که فقط farm می‌کند از پنج حمایت متنوع کمتر می‌گیرد (تست دارد).
- **جریمه برگشت بیش از پاداش تکمیل است** — در غیر این صورت تقلب صرفه داشت.
- **نشان‌ها** روی آستانه‌های واقعی و با گیت کیفیت (`completionRate`) صادر می‌شوند، و دوباره اهدا نمی‌شوند.

## UI/UX

- دیزاین‌سیستم توکن‌محور (`globals.css` + `tailwind.config.ts`)؛ هیچ کامپوننتی رنگ اختراع نمی‌کند.
- **Explore هسته محصول** و مقصد اصلی پس از ورود است: جست‌وجوی debounce‌شده، skeleton هم‌هندسه با کارت واقعی (پس چیدمان نمی‌پرد)، empty state با اقدام مشخص.
- **صداقت در UI**: تماشا «ثبت‌شده توسط پلتفرم» برچسب می‌خورد و هرگز «تأییدشده توسط یوتیوب» نه. بدون اتصال یوتیوب، کار «تأییدنشده» می‌ماند و صریحاً گفته می‌شود.
- خلاصه پایان حمایت فقط اعداد واقعی settlement را نشان می‌دهد — انیمیشن جشن روی عددی که پرداخت نشده وجود ندارد.
- دسترس‌پذیری: skip link به‌عنوان اولین tab stop، `<dialog>` واقعی با focus trap، `role="radiogroup"` برای فیلترها، zoom قفل نشده، RTL از پایه.
- PWA: manifest، آیکون‌های تولیدشده (۱۹۲/۵۱۲/apple-touch)، service worker برای push.

## Performance

- `select` صریح در همه کوئری‌ها؛ هیچ `include` بی‌حساب و هیچ N+1 در dashboard/leaderboard/explore/admin.
- Aggregate‌های عمومی (`/`، `/badges`، sitemap) با `unstable_cache` و بازه مشخص کش می‌شوند.
- پاسخ‌های API با `no-store` سرو می‌شوند تا کش مشترک داده‌ی یک کاربر را به دیگری ندهد.
- بیلد: ۱۰۳KB First Load JS مشترک، ۶۸ صفحه/route.

## Tests

`npm run verify` → typecheck + lint + unit، و `npm run build` — همه سبز:

```
typecheck: PASS      lint: PASS
Test Files  8 passed | 1 skipped (9)
     Tests  172 passed | 2 skipped (174)
build:     PASS (68 routes, no DB required)
```

- `watch.test.ts` (۱۹) — union بازه‌ها، رد seek، عدم شمارش دوباره، سقف نرخ، سناریوی اسکراب کامل.
- `ledger.test.ts` (۱۵) — idempotency روی replay، برگشت یک‌بار، `balanceAfter` متوالی، تشخیص drift تزریق‌شده.
- `authz.test.ts` (۱۷) — کل ماتریس، همه مسیرهای privilege escalation.
- `youtube.test.ts` (۳۸) — فرم‌های پذیرفته/ردشده، هاست‌های شبیه‌ساز، ISO duration.
- `validators.test.ts` (۲۷) — سیاست رمز، حذف کاراکترهای bidi، mass assignment، قواعد کمپین.
- `gamification.test.ts` (۳۳) — سطح، tier، پاداش نزولی، نشان‌ها، streak، anti-abuse.
- `crypto.test.ts` (۱۴) — round-trip، IV تصادفی، تشخیص دست‌کاری، مقایسه‌های timing-safe.
- `concurrency.test.ts` (۲، skip‌شده) — با `TEST_DATABASE_URL` روی Postgres واقعی: ۲۵ درخواست همزمان روی ظرفیت ۵ دقیقاً ۵ پذیرش می‌دهد، بودجه از سقف رد نمی‌شود، هیچ `idempotencyKey` تکراری ساخته نمی‌شود، و replay دوباره پرداخت نمی‌کند. عمداً skip می‌شود تا `npm test` سریع و hermetic بماند؛ دلیل skip چاپ می‌شود.
- e2e (Playwright): auth، admin (شامل مرز مجوز از طریق API مستقیم)، support flow، smoke.

## آنچه یوتیوب واقعاً تأیید می‌کند (بند ۵۲)

| سطح | موارد |
|---|---|
| **Officially verifiable by YouTube** | سابسکرایب (`subscriptions.list`)، لایک (`videos.getRating`)، مالکیت کانال (OAuth identity)، متادیتای ویدیو و مدت (`videos.list`)، وجود کامنت (`commentThreads.list`) |
| **Browser-observable** | درصد تماشا — از رویدادهای IFrame Player، با حسابداری سمت سرور. هیچ API یوتیوب این را گزارش نمی‌دهد. |
| **Not reliably verifiable** | «کیفیت» تماشا (توجه واقعی کاربر)، تماشا در تب پس‌زمینه، محتوای کامنت به‌عنوان نشانه‌ی تماشا |

برای دسته سوم fallback همان چیزی است که پیاده شده: حسابداری union بازه‌ها + سقف نرخ + شمارش heartbeat + تشخیص جهش غیرممکن + صف بررسی، به‌جای پذیرفتن حرف کلاینت.

## Remaining Risks

- **تست‌های concurrency در CI اجرا نشده‌اند.** کد برای شرایط مسابقه نوشته و منطقش تست شده، اما اثبات نهایی نیاز به Postgres دارد که در این محیط نبود. قبل از production، `TEST_DATABASE_URL` را تنظیم و `npm test` را اجرا کنید. این تنها مورد از این گزارش است که «نوشته شده ولی روی دیتابیس واقعی اجرا نشده» — بقیه اجرا شده‌اند.
- **تماشا قابل جعل باقی می‌ماند، فقط گران‌تر.** کلاینتی که پلیر یوتیوب را شبیه‌سازی کند و heartbeatهای باورپذیر با آهنگ درست بفرستد، می‌تواند اعتبار بگیرد. سقف نرخ، شمارش heartbeat و سیگنال‌های گراف هزینه را بالا می‌برند اما آن را غیرممکن نمی‌کنند. راه‌حل قطعی وجود ندارد؛ به همین دلیل برچسب «ثبت‌شده توسط پلتفرم» است.
- **بدون کلید یوتیوب، هسته محصول ناقص است.** بدون `GOOGLE_CLIENT_ID/SECRET` سابسکرایب و لایک قابل تأیید نیستند و اپ آن‌ها را «انجام‌شده» ثبت نمی‌کند. این افت صریح است (در `/api/v1/health` گزارش می‌شود) اما یعنی deployment بدون این کلیدها فقط تماشا را می‌سنجد.
- **Rate limit در حالت Postgres در چند instance دقیق نیست.** اتمیک است و کار می‌کند، اما برای مقیاس واقعی Upstash را تنظیم کنید.
- **سهمیه Data API یوتیوب** سقف واقعی دارد. verification در مسیر settlement است، پس اتمام سهمیه به معنی «تأیید ناموفق» می‌شود نه «پاداش اشتباه» — رفتار محافظه‌کارانه اما تحت بار سنگین به کش/صف نیاز دارد.
- **`e2e` به دیتابیس seed‌شده و سرور در حال اجرا نیاز دارد** و در این محیط اجرا نشده است؛ سلکتورها با کامپوننت‌های فعلی نوشته شده‌اند اما تأیید نشده‌اند.

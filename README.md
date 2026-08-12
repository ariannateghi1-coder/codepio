# آکادمی حمایت

پلتفرم حمایت متقابل و **قابل تأیید** برای سازندگان یوتیوب: کشف محتوا در «کاوش»، انجام حمایت واقعی (تماشا + سابسکرایب + لایک)، و ساختن اعتبار قابل ردیابی.

اصل حاکم بر محصول: **هیچ‌وقت چیزی را «تأییدشده» نشان نمی‌دهیم که واقعاً تأیید نشده باشد.** میزان تماشا «ثبت‌شده توسط پلتفرم» است، سابسکرایب و لایک با API رسمی گوگل «تأییدشده توسط یوتیوب» می‌شوند، و اگر اتصال یوتیوب نباشد کار به‌جای «انجام‌شده»، «تأییدنشده» می‌ماند.

## معماری در یک نگاه

| لایه | مسئولیت |
|---|---|
| `src/app/(pages)` | Server Components؛ خواندن مستقیم از سرویس‌ها بدون hop اضافی به API |
| `src/app/api/v1/*` | تنها قرارداد HTTP؛ همه پاسخ‌ها `{success, data|error, requestId}` |
| `src/lib/handler.ts` | ترکیب route: سطح احراز هویت، CSRF، rate limit — یک‌بار، نه در هر فایل |
| `src/lib/services/*` | منطق دامنه: session حمایت، حسابداری تماشا، ledger، anti-abuse، badges |
| `src/lib/authz.ts` | ماتریس مجوز؛ مرز واقعی دسترسی (UI فقط بازتاب آن است) |
| `prisma/schema.prisma` | مدل داده حول چرخه حمایت و چهار اقتصاد مستقل |

چهار مفهوم که عمداً از هم جدا شده‌اند:

- **Credits** — واحد قابل خرج؛ در `CreditLedger` ثبت می‌شود.
- **XP** — پیشرفت؛ فقط بالا می‌رود، سطح از آن مشتق می‌شود.
- **Reputation** — کیفیت؛ با حمایت تأییدشده بالا و با برگشت خوردن پایین می‌رود.
- **Rank** — نتیجه ترکیب اعتبار و حجم واقعی حمایت.

هیچ‌جای کد `credits -= x` وجود ندارد. هر تغییر موجودی یک entry در ledger با `idempotencyKey` یکتاست و موجودی روی `User` فقط cache است؛ `auditUserBalances()` اختلاف را پیدا می‌کند.

## راه‌اندازی

نیازمندی: Node.js 20.9+ و PostgreSQL (حتماً Postgres — schema به enum، JSON و composite unique index تکیه دارد).

```bash
npm install
cp .env.example .env      # حداقل DATABASE_URL و SESSION_SECRET را پر کنید
npm run prisma:migrate    # اجرای migration
npm run prisma:seed       # کاتالوگ نشان‌ها + داده نمونه
npm run dev
```

`.env.example` توضیح می‌دهد هر متغیر چه چیزی را فعال یا غیرفعال می‌کند. اپ بدون کلیدهای اختیاری کار می‌کند اما **صریحاً** افت قابلیت را اعلام می‌کند؛ `GET /api/v1/health` گزارش آمادگی می‌دهد.

### حساب‌های نمونه (فقط توسعه)

| نقش | نام کاربری | رمز |
|---|---|---|
| SUPER_ADMIN | `admin` | `AdminPass2026!` |
| سازنده | `creator_1` … `creator_4` | `MemberPass2026!` |

## بررسی صحت

```bash
npm run verify   # typecheck + lint + unit tests
npm run build    # بیلد production
npm run e2e      # Playwright (نیاز به دیتابیس seed‌شده و سرور در حال اجرا)
```

تست‌های concurrency (`src/tests/concurrency.test.ts`) فقط وقتی اجرا می‌شوند که `TEST_DATABASE_URL` به یک دیتابیس **دورانداختنی** اشاره کند؛ در غیر این صورت با پیام صریح skip می‌شوند. این تست‌ها چیزی را اثبات می‌کنند که fake نمی‌تواند: ظرفیت N با درخواست همزمان دقیقاً N پذیرش می‌دهد و بودجه هرگز منفی نمی‌شود.

شبیه‌سازی پارامتریک اقتصاد و baseline روزانه ۱۰٬۰۰۰ کاربر × ۲۰ حمایت در `docs/economy-simulation.md` مستند شده است.

## نکات امنیتی پیاده‌شده

- CSRF: بررسی Origin + مقایسه constant-time هدر با کوکی + تطبیق با hash ذخیره‌شده در session.
- Session: کوکی HttpOnly، ذخیره hash توکن، ابطال سمت سرور در logout و تغییر رمز.
- ماتریس مجوز: هیچ‌کس روی حساب خودش اقدام نمی‌کند، ADMIN روی SUPER_ADMIN دست نمی‌برد، تغییر نقش فقط SUPER_ADMIN و فقط به سطح پایین‌تر.
- IP: تعداد hop قابل اعتماد از `TRUSTED_PROXY_HOPS` می‌آید؛ `x-forwarded-for` کورکورانه باور نمی‌شود. IP فقط hash‌شده ذخیره می‌شود.
- CSP سخت‌گیرانه؛ `frame-src` تنها `youtube-nocookie.com`. `frame-ancestors 'none'` کلیک‌جکینگ را حذف می‌کند.
- توکن‌های OAuth با AES-256-GCM رمز می‌شوند (کلید مشتق‌شده از `SESSION_SECRET`).
- بازیابی رمز و تأیید ایمیل: توکن hash‌شده، یک‌بارمصرف، کوتاه‌عمر، claim اتمیک.
- بدون افشای وجود حساب: پیام‌های ورود و بازیابی رمز یکسان‌اند.
- `?next=` از open redirect محافظت می‌شود (`safeNextPath`).

## دیپلوی

Netlify با `@netlify/plugin-nextjs`؛ `npm run build` و publish از `.next`. قبل از رفتن به production:

1. `SESSION_SECRET` واقعی و بلند تنظیم کنید (در production پیش‌فرض ندارد و اپ بالا نمی‌آید).
3. `TRUSTED_PROXY_HOPS` را با تعداد واقعی proxy تنظیم کنید.
4. `npm run prisma:deploy` برای اجرای migration.
5. `GET /api/v1/health` را بررسی کنید: `ready: false` یعنی چیزی هنوز پیکربندی نشده.

### نگه‌داری زمان‌بندی‌شده

مسیر `POST /api/v1/maintenance` پاک‌سازی نشست‌ها، محدودیت‌های منقضی و snapshot جدول امتیازات را انجام می‌دهد و به Bearer token نیاز دارد. این پروژه روی Netlify با Next.js اجرا می‌شود، اما `netlify.toml` به‌تنهایی نمی‌تواند یک درخواست HTTP احراز‌شده به Route Handler را بدون افزودن Scheduled Function و مدیریت secret زمان‌بندی کند. بنابراین عمداً schedule یا credential ساختگی در مخزن اضافه نشده است. در محیط production یک scheduler امن را برای اجرای روزانه این مسیر تنظیم کنید و مقدار `MAINTENANCE_SECRET` را فقط در تنظیمات محرمانه deployment نگه دارید؛ آن را در فایل‌های مخزن قرار ندهید.

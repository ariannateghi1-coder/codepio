import { z } from "zod";
import { extractYoutubeVideoId, isValidYoutubeChannelId } from "./youtube";
import { WATCH_RULES } from "./gamification";

/**
 * Validation layer.
 *
 * Every schema normalizes before it validates (trim, case-fold, Unicode NFC),
 * bounds length, and rejects the specific hostile shapes that matter here:
 * zero-width/bidi control characters in display names, non-YouTube URLs,
 * non-https avatar URLs, and unbounded search queries.
 */

/** Strips characters that let text spoof direction or hide content. */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\u0000-\u001F\u007F]/g;

const cleanText = (max: number) =>
  z
    .string()
    .transform((v) => v.normalize("NFC").replace(INVISIBLE, "").trim())
    .pipe(z.string().max(max));

export const usernameSchema = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(
    z
      .string()
      .min(3, "نام کاربری باید حداقل ۳ نویسه باشد.")
      .max(30, "نام کاربری حداکثر ۳۰ نویسه است.")
      .regex(/^[a-z0-9_]+$/, "نام کاربری فقط می‌تواند شامل حروف انگلیسی، عدد و underscore باشد.")
      .refine((v) => !/^_+$/.test(v), "نام کاربری نامعتبر است.")
  );

export const emailSchema = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.string().email("ایمیل معتبر نیست.").max(254));

/**
 * Password policy: length plus composition, because an 8-character minimum alone
 * accepts "password". Length beats complexity, so a long passphrase satisfies it
 * without needing symbols.
 */
export const passwordSchema = z
  .string()
  .min(10, "رمز عبور باید حداقل ۱۰ نویسه باشد.")
  .max(200, "رمز عبور بیش از حد طولانی است.")
  .refine((v) => !/\s{2,}/.test(v), "رمز عبور نباید فاصله‌های پیوسته داشته باشد.")
  .refine(
    (v) => v.length >= 16 || (/[a-z]/.test(v) && /[A-Z0-9]/.test(v)),
    "رمز عبور باید ترکیبی از حروف کوچک و بزرگ یا عدد باشد (یا حداقل ۱۶ نویسه)."
  )
  .refine((v) => !COMMON_PASSWORDS.has(v.toLowerCase()), "این رمز عبور بسیار رایج است.");

const COMMON_PASSWORDS = new Set([
  "password", "password1", "password123", "12345678", "123456789", "1234567890",
  "qwerty123", "iloveyou", "admin123", "welcome123", "letmein123", "academy123",
]);

export const nameSchema = cleanText(80).pipe(z.string().min(2, "نام باید حداقل ۲ نویسه باشد."));

/** Only https images, and no data:/javascript: URLs. */
export const httpsUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((v) => {
    try {
      return new URL(v).protocol === "https:";
    } catch {
      return false;
    }
  }, "آدرس باید یک URL امن با https باشد.");

export const cuidSchema = z.string().regex(/^[a-z0-9]{20,32}$/i, "شناسه معتبر نیست.");

/* ---------------------------------- auth --------------------------------- */

export const registerSchema = z
  .object({
    name: nameSchema,
    username: usernameSchema,
    email: emailSchema,
    password: passwordSchema,
    confirmPassword: z.string(),
    referralCode: z.string().trim().max(40).optional().or(z.literal("")),
  })
  .refine((v) => v.password === v.confirmPassword, { path: ["confirmPassword"], message: "تکرار رمز عبور مطابقت ندارد." })
  .refine((v) => !v.password.toLowerCase().includes(v.username), {
    path: ["password"],
    message: "رمز عبور نباید شامل نام کاربری باشد.",
  });

export const loginSchema = z.object({
  emailOrUsername: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(200),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(200),
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((v) => v.password === v.confirmPassword, { path: ["confirmPassword"], message: "تکرار رمز عبور مطابقت ندارد." })
  .refine((v) => v.password !== v.currentPassword, { path: ["password"], message: "رمز جدید باید با رمز فعلی متفاوت باشد." });


/* -------------------------------- profile -------------------------------- */

export const profileSchema = z.object({
  name: nameSchema.optional(),
  bio: cleanText(500).optional().nullable(),
  avatarUrl: httpsUrlSchema.optional().nullable(),
  country: cleanText(80).optional().nullable(),
  language: z.enum(["fa", "en"]).optional(),
});

/* -------------------------------- youtube -------------------------------- */

export const youtubeChannelSchema = z.object({
  channelId: z.string().trim().refine(isValidYoutubeChannelId, "شناسه کانال یوتیوب معتبر نیست."),
});

export const videoSchema = z.object({
  youtubeUrl: z
    .string()
    .trim()
    .max(2048)
    .refine((v) => extractYoutubeVideoId(v) !== null, "آدرس ویدیوی یوتیوب معتبر نیست."),
  /** Title/description are optional: authoritative values come from the API. */
  title: cleanText(160).optional(),
  description: cleanText(2000).optional().nullable(),
});

/* ------------------------------- campaigns ------------------------------- */

export const taskTypeSchema = z.enum(["WATCH_VIDEO", "SUBSCRIBE_CHANNEL", "LIKE_VIDEO", "COMMENT_VIDEO"]);

export const campaignCreateSchema = z
  .object({
    videoId: cuidSchema,
    title: cleanText(120).pipe(z.string().min(3, "عنوان کمپین باید حداقل ۳ نویسه باشد.")),
    description: cleanText(1000).optional().nullable(),
    startAt: z.coerce.date(),
    endAt: z.coerce.date(),
    requiredWatchPercent: z.coerce
      .number()
      .int()
      .min(WATCH_RULES.minRequiredPercent)
      .max(WATCH_RULES.maxRequiredPercent)
      .default(WATCH_RULES.defaultRequiredPercent),
    rewardCredits: z.coerce.number().int().min(1).max(200).default(10),
    rewardXp: z.coerce.number().int().min(1).max(500).default(25),
    budgetCredits: z.coerce.number().int().min(1).max(1_000_000),
    maxTotalSupports: z.coerce.number().int().min(1).max(100_000).optional().nullable(),
    maxSupportsPerUser: z.coerce.number().int().min(1).max(100).optional().nullable(),
    dailyLimit: z.coerce.number().int().min(1).max(10_000).optional().nullable(),
    minAccountAgeHours: z.coerce.number().int().min(0).max(720).default(0),
    tasks: z
      .array(
        z.object({
          type: taskTypeSchema,
          required: z.boolean().default(true),
          /**
           * Optional-task bonus. Required tasks must be 0: their value is already
           * inside the campaign's own rewardCredits/rewardXp. Allowing both would
           * create two parallel reward models and, with them, double counting —
           * see src/lib/services/reward.ts for the canonical model.
           */
          rewardCredits: z.coerce.number().int().min(0).max(50).default(0),
          rewardXp: z.coerce.number().int().min(0).max(100).default(0),
        })
      )
      .min(1, "حداقل یک کار لازم است.")
      .max(4)
      .default([{ type: "WATCH_VIDEO", required: true, rewardCredits: 0, rewardXp: 0 }]),
  })
  .refine((v) => v.endAt.getTime() > v.startAt.getTime(), { path: ["endAt"], message: "پایان کمپین باید بعد از شروع باشد." })
  .refine((v) => v.endAt.getTime() - v.startAt.getTime() <= 365 * 86_400_000, {
    path: ["endAt"],
    message: "بازه کمپین حداکثر یک سال است.",
  })
  .refine((v) => v.tasks.some((t) => t.type === "WATCH_VIDEO"), {
    path: ["tasks"],
    message: "کار تماشای ویدیو الزامی است.",
  })
  .refine((v) => new Set(v.tasks.map((t) => t.type)).size === v.tasks.length, {
    path: ["tasks"],
    message: "کارهای تکراری مجاز نیست.",
  })
  .refine((v) => v.tasks.every((t) => !t.required || (t.rewardCredits === 0 && t.rewardXp === 0)), {
    path: ["tasks"],
    message: "پاداش کارهای الزامی داخل پاداش پایه کمپین است و نباید جداگانه تعیین شود.",
  })
  .refine(
    (v) => {
      // The budget must be able to pay at least one full settlement, otherwise the
      // campaign would appear in Explore and then refuse every completion.
      const optionalBonus = v.tasks
        .filter((t) => !t.required)
        .reduce((sum, t) => sum + t.rewardCredits, 0);
      return v.budgetCredits >= v.rewardCredits + optionalBonus;
    },
    { path: ["budgetCredits"], message: "بودجه باید حداقل برای یک حمایت کامل کافی باشد." }
  );

export const campaignUpdateSchema = z
  .object({
    campaignId: cuidSchema,
    action: z.enum(["ACTIVATE", "PAUSE", "END", "EDIT"]),
    title: cleanText(120).pipe(z.string().min(3, "عنوان کمپین باید حداقل ۳ نویسه باشد.")).optional(),
    description: cleanText(1000).optional().nullable(),
    endAt: z.coerce.date().optional(),
    dailyLimit: z.coerce.number().int().min(1).max(10_000).optional().nullable(),
    budgetCredits: z.coerce.number().int().min(1).max(1_000_000).optional(),
  })
  .superRefine((value, ctx) => {
    const editFields = ["title", "description", "endAt", "dailyLimit", "budgetCredits"] as const;
    const supplied = editFields.filter((field) => value[field] !== undefined);
    if (value.action === "EDIT" && supplied.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["action"], message: "حداقل یک تغییر برای ویرایش کمپین لازم است." });
    }
    if (value.action !== "EDIT" && supplied.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [supplied[0]], message: "فیلدهای ویرایش فقط با عملیات EDIT مجاز هستند." });
    }
  });

/* -------------------------------- support -------------------------------- */

export const supportStartSchema = z.object({ campaignId: cuidSchema });

export const watchHeartbeatSchema = z.object({
  sessionId: cuidSchema,
  position: z.coerce.number().min(0).max(86_400),
  playerState: z.enum(["PLAYING", "PAUSED", "BUFFERING", "ENDED", "IDLE"]),
  /** Required monotonic counter assigned by the client, starting at 1. */
  sequence: z.coerce.number().int().min(1).max(100_000),
  /**
   * Seconds the page was hidden since the previous beat (Page Visibility API).
   * Advisory only — a hostile client can under-report it, so it feeds the risk
   * score and never gates the reward by itself.
   */
  hiddenSec: z.coerce.number().min(0).max(3_600).optional(),
});

export const supportCompleteSchema = z.object({ sessionId: cuidSchema });

export const supportReverseSchema = z.object({
  supportId: cuidSchema,
  reason: cleanText(500).pipe(z.string().min(5, "دلیل برگشت باید توضیح داده شود.")),
});

/* -------------------------------- reports -------------------------------- */

export const reportSchema = z.object({
  targetType: z.enum(["USER", "VIDEO", "SUPPORT", "CAMPAIGN"]),
  targetId: cuidSchema,
  reason: cleanText(120).pipe(z.string().min(3)),
  description: cleanText(1000).optional().nullable(),
});

export const reportResolveSchema = z.object({
  reportId: cuidSchema,
  status: z.enum(["UNDER_REVIEW", "RESOLVED", "DISMISSED"]),
  resolutionNote: cleanText(1000).optional().nullable(),
});

/* --------------------------------- admin --------------------------------- */

export const userModerationSchema = z.object({
  userId: cuidSchema,
  action: z.enum(["SET_STATUS", "SET_ROLE", "ADJUST_CREDITS"]),
  status: z.enum(["ACTIVE", "SUSPENDED", "BANNED"]).optional(),
  role: z.enum(["USER", "MODERATOR", "ADMIN", "SUPER_ADMIN"]).optional(),
  amount: z.coerce.number().int().min(-100_000).max(100_000).optional(),
  reason: cleanText(500).pipe(z.string().min(3, "ثبت دلیل الزامی است.")),
});

export const broadcastSchema = z.object({
  title: cleanText(120).pipe(z.string().min(3)),
  message: cleanText(1000).pipe(z.string().min(3)),
  audience: z.enum(["ALL", "ACTIVE", "STAFF"]).default("ACTIVE"),
});

/* ------------------------------ list queries ----------------------------- */

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(12),
});

export const cursorSchema = z.object({
  cursor: cuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const searchSchema = z.object({
  q: cleanText(80).optional(),
  sort: z.enum(["reputation", "credits", "recent", "supports"]).default("reputation"),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(12),
});

export const exploreQuerySchema = z.object({
  filter: z.enum(["for_you", "new", "trending", "top_creators", "highest_reward", "ending_soon", "most_trusted"]).default("for_you"),
  q: cleanText(80).optional(),
  limit: z.coerce.number().int().min(1).max(24).default(12),
  /** Signed v2 cursor containing a bounded campaign-ID snapshot. */
  cursor: z
    .string()
    .trim()
    .max(20_000)
    .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, "مقدار cursor معتبر نیست.")
    .optional(),
});

export const leaderboardQuerySchema = z.object({
  period: z.enum(["WEEKLY", "MONTHLY", "ALL_TIME"]).default("WEEKLY"),
  mode: z.enum(["TOP_SUPPORTERS", "TOP_CREATORS", "HIGHEST_REPUTATION", "RISING"]).default("TOP_SUPPORTERS"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const pushSubscriptionSchema = z.object({
  endpoint: httpsUrlSchema,
  keys: z.object({ p256dh: z.string().min(20).max(200), auth: z.string().min(10).max(200) }),
});

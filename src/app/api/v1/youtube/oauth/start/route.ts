import { randomToken, sha256 } from "@/lib/crypto";
import { active } from "@/lib/handler";
import { buildOAuthUrl } from "@/lib/services/youtube-api";
import { features } from "@/lib/env";
import { BusinessRuleError } from "@/lib/errors";
import { cookies } from "next/headers";
import { isProduction } from "@/lib/env";
import { OAUTH_STATE_COOKIE } from "@/lib/security-constants";

/**
 * Starts the Google/YouTube OAuth flow.
 *
 * CSRF for the redirect leg is handled with a signed, single-use `state` value:
 * the raw value goes in the URL, its hash in an httpOnly cookie, and the callback
 * only proceeds when they match. Requested scopes are read-only and minimal.
 */
export const POST = active(
  "youtube.oauth.start",
  async ({ user }) => {
    if (!features.youtubeOAuth) {
      throw new BusinessRuleError("اتصال یوتیوب در این سرور پیکربندی نشده است.");
    }

    const state = randomToken(24);
    const jar = await cookies();
    jar.set(OAUTH_STATE_COOKIE, sha256(`${user.id}:${state}`), {
      httpOnly: true,
      secure: isProduction,
      sameSite: "lax",
      path: "/",
      maxAge: 600,
    });

    return {
      authorizeUrl: buildOAuthUrl(state),
      /** Shown on the consent explainer so the user knows exactly what we ask for. */
      scopes: ["مشاهده اشتراک‌ها و لایک‌های شما (فقط خواندن)", "شناسه کانال شما"],
    };
  },
  { rateLimit: "youtubeOAuth" }
);

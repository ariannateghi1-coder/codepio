import { ok, parseBody, route } from "@/lib/api";
import { forgotPasswordSchema } from "@/lib/validators";
import { enforceRateLimit } from "@/lib/rate-limit";
import { getClientIp, hashIp, isSameOrigin } from "@/lib/http";
import { CsrfError } from "@/lib/errors";
import { requestReset } from "@/lib/services/password-reset";

/**
 * Start a password reset.
 *
 * Unauthenticated by necessity — the user cannot sign in — so there is no session
 * to bind a CSRF token to. Origin is still checked: it costs nothing and stops a
 * cross-site page from silently firing reset mail at addresses it guesses.
 *
 * The response is a fixed success message regardless of outcome. Returning
 * "no account with this email" here would turn the endpoint into an account
 * enumeration oracle — the same reason requestReset() resolves identically for
 * known and unknown addresses and dispatches mail without awaiting it.
 *
 * Two rate-limit dimensions, both needed:
 *   - per IP    stops one host from harvesting which addresses are registered
 *   - per email stops an attacker from mail-bombing one victim's inbox
 */
export const POST = route("auth.forgotPassword", async (req) => {
  if (!isSameOrigin(req)) throw new CsrfError();

  await enforceRateLimit("forgotPassword", hashIp(getClientIp(req)));

  const data = await parseBody(req, forgotPasswordSchema);
  await enforceRateLimit("forgotPassword", `email:${data.email}`);

  await requestReset(data.email, req);

  return ok({
    message:
      "اگر این ایمیل در سامانه ثبت شده باشد، پیوند بازیابی برای آن ارسال می‌شود. صندوق ورودی و پوشه اسپم را بررسی کنید.",
  });
});

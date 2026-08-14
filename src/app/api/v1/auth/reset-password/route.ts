import { ok, parseBody, route } from "@/lib/api";
import { resetPasswordSchema } from "@/lib/validators";
import { enforceRateLimit } from "@/lib/rate-limit";
import { getClientIp, hashIp, isSameOrigin } from "@/lib/http";
import { CsrfError } from "@/lib/errors";
import { completeReset } from "@/lib/services/password-reset";

/**
 * Redeem a reset token and set the new password.
 *
 * The token in the body IS the credential, so no session and no CSRF token exist
 * to check — an attacker who already has the token does not need CSRF. Origin is
 * still verified as cheap defense in depth.
 *
 * Rate limited per IP because the token is a bearer secret: without a limit, this
 * endpoint is a guessing oracle. 32 random bytes make guessing infeasible anyway,
 * but the limit is what keeps that true if the token generator is ever weakened.
 *
 * No session is issued on success. completeReset() revokes every existing session
 * (the reset may be recovery from a compromise) and the user signs in explicitly,
 * which also confirms the new password actually works.
 */
export const POST = route("auth.resetPassword", async (req) => {
  if (!isSameOrigin(req)) throw new CsrfError();

  await enforceRateLimit("resetPassword", hashIp(getClientIp(req)));

  const data = await parseBody(req, resetPasswordSchema);
  await completeReset(data.token, data.password, req);

  return ok({
    message: "رمز عبور شما تغییر کرد و همه نشست‌های قبلی بسته شدند. اکنون وارد شوید.",
  });
});

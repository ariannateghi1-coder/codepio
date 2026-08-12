import { ok, route } from "@/lib/api";
import { assertCsrf, logout, getSessionUser } from "@/lib/security";
import { writeAudit } from "@/lib/audit";

/**
 * Logout genuinely revokes the session server-side (sets revokedAt) before
 * clearing cookies, so a copied cookie is dead afterwards — deleting the cookie
 * alone would leave the session usable.
 */
export const POST = route("auth.logout", async (req) => {
  const user = await getSessionUser();
  await assertCsrf(req);
  await logout();
  if (user) await writeAudit({ userId: user.id, action: "LOGOUT", entity: "User", entityId: user.id, req });
  return ok({ message: "از حساب خود خارج شدید." });
});

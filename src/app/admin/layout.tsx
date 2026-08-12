import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/security";
import { isStaff } from "@/lib/authz";

/**
 * Route-level guard for the whole /admin tree.
 *
 * Every admin API route independently enforces its own permission check — that is
 * the real authorization boundary. This layer exists so a signed-in non-staff user
 * never renders the admin shell at all, rather than seeing its structure and
 * watching each fetch fail.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect("/auth/login?next=/admin");
  if (!isStaff(user.role)) redirect("/dashboard");
  return children;
}

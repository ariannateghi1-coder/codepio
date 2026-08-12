import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/security-constants";
import { safeNextPath } from "@/lib/redirect";

/**
 * Edge middleware — a UX fast path, NOT an authorization boundary.
 *
 * It can only see whether a session cookie is present; validating it needs the
 * database, which the Edge runtime can't reach through Prisma. Real
 * authentication and authorization therefore stay in requireUser()/requireAdmin()
 * on every route and page, and this layer only saves a logged-out visitor from
 * loading a protected page before being bounced.
 *
 * The `next` parameter is validated as an internal path, so it cannot be used as
 * an open redirect to another origin.
 */

const PROTECTED_PREFIXES = ["/dashboard", "/notifications", "/settings", "/support", "/admin", "/campaigns/new", "/studio"];
const AUTH_PAGES = ["/auth/login", "/auth/register"];

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const hasSessionCookie = Boolean(req.cookies.get(SESSION_COOKIE)?.value);

  if (!hasSessionCookie && PROTECTED_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    const url = req.nextUrl.clone();
    url.pathname = "/auth/login";
    url.search = "";
    url.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(url);
  }

  if (hasSessionCookie && AUTH_PAGES.includes(pathname)) {
    const url = req.nextUrl.clone();
    url.pathname = safeNextPath(req.nextUrl.searchParams.get("next")) ?? "/explore";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/notifications/:path*",
    "/settings/:path*",
    "/support/:path*",
    "/admin/:path*",
    "/studio/:path*",
    "/auth/login",
    "/auth/register",
  ],
};

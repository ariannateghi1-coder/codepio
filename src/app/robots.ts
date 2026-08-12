import type { MetadataRoute } from "next";
import { env } from "@/lib/env";

/**
 * Robots policy: public discovery surfaces are crawlable, everything
 * account-scoped or privileged is explicitly disallowed.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/explore", "/leaderboard", "/members", "/badges"],
        disallow: ["/api/", "/admin", "/dashboard", "/settings", "/studio", "/support", "/notifications", "/auth/"],
      },
    ],
    sitemap: `${env.NEXT_PUBLIC_APP_URL}/sitemap.xml`,
    host: env.NEXT_PUBLIC_APP_URL,
  };
}

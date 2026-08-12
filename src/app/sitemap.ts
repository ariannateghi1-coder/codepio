import type { MetadataRoute } from "next";
import { unstable_cache } from "next/cache";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

/**
 * Sitemap for public pages only.
 *
 * Private routes (dashboard, settings, admin, studio, auth) are excluded here and
 * additionally carry `robots: { index: false }` in their metadata, so a leaked link
 * still doesn't get indexed.
 *
 * Served per request with the member query cached for an hour. Static prerendering
 * would bake in whatever the database held at build time — which, in a CI build
 * without a database, is nothing at all.
 */
export const dynamic = "force-dynamic";

const getIndexableMembers = unstable_cache(
  async () =>
    // Bounded: a sitemap is not a data dump.
    prisma.user.findMany({
      where: { status: "ACTIVE" },
      orderBy: { reputation: "desc" },
      take: 500,
      select: { username: true, updatedAt: true },
    }),
  ["sitemap-members"],
  { revalidate: 3600, tags: ["members"] }
);

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = env.NEXT_PUBLIC_APP_URL;

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: base, changeFrequency: "daily", priority: 1 },
    { url: `${base}/explore`, changeFrequency: "hourly", priority: 0.9 },
    { url: `${base}/leaderboard`, changeFrequency: "daily", priority: 0.7 },
    { url: `${base}/members`, changeFrequency: "daily", priority: 0.7 },
    { url: `${base}/badges`, changeFrequency: "weekly", priority: 0.5 },
  ];

  try {
    const members = await getIndexableMembers();
    return [
      ...staticRoutes,
      ...members.map((member) => ({
        url: `${base}/members/${member.username}`,
        lastModified: member.updatedAt,
        changeFrequency: "weekly" as const,
        priority: 0.5,
      })),
    ];
  } catch (error) {
    // A sitemap is not worth a 500: degrade to the static routes and record why.
    logger.warn("sitemap: member list unavailable, serving static routes only", {
      error: error instanceof Error ? error.message : String(error),
    });
    return staticRoutes;
  }
}

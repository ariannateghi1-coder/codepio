import { parseQuery } from "@/lib/api";
import { publicRoute } from "@/lib/handler";
import { exploreQuerySchema } from "@/lib/validators";
import { getExploreFeed } from "@/lib/services/explore";

/**
 * Explore feed — the product's primary destination.
 *
 * Public on purpose (discovery works before signup), but personalization only
 * kicks in for a signed-in viewer. Rate limited by viewer/IP, and the page size
 * is capped by the schema so no caller can pull the whole table.
 *
 * Pagination is cursor-based: the opaque `cursor` carries the ranking seed plus
 * the (score, id) position, which is what makes paging stable and duplicate-free
 * even though ranking happens in memory. See src/lib/services/explore.ts.
 */
export const GET = publicRoute(
  "explore.feed",
  async ({ url, viewer }) => {
    const query = parseQuery(url, exploreQuerySchema);
    const feed = await getExploreFeed({
      viewerId: viewer?.id ?? null,
      filter: query.filter,
      limit: query.limit,
      search: query.q,
      cursor: query.cursor,
    });
    return { filter: query.filter, ...feed };
  },
  { rateLimit: "explore", csrf: false }
);

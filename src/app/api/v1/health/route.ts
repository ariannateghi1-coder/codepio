import { ok, route } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { productionReadiness } from "@/lib/env";
import { logger } from "@/lib/logger";

/**
 * Health check for deployment probes.
 *
 * Public but deliberately thin: it reports whether the database answers and which
 * optional subsystems are configured — no versions, no connection strings, no
 * counts that would leak business information.
 */
export const GET = route("health", async () => {
  const startedAt = Date.now();
  let database = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    database = true;
  } catch (e) {
    logger.error("health check: database unreachable", { error: e });
  }

  const readiness = productionReadiness();
  const status = database ? 200 : 503;

  return ok(
    {
      status: database ? "ok" : "degraded",
      database,
      latencyMs: Date.now() - startedAt,
      optionalSubsystemsMissing: readiness.missing.length,
    },
    { status }
  );
});

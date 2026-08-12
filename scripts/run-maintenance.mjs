#!/usr/bin/env node
/**
 * Maintenance runner — the scheduling entry point.
 *
 * Calls POST /api/v1/maintenance with the bearer secret. Deliberately a thin HTTP
 * client rather than a script that imports the app and talks to the database
 * directly, for three reasons:
 *
 *   • one implementation. The cleanup logic lives in src/lib/services/retention.ts
 *     and runs in the app process, so a cron run and a manual run cannot drift.
 *   • no second database credential. This process needs the maintenance secret and
 *     a URL, not DATABASE_URL.
 *   • portable. Works from a VPS crontab, a Docker sidecar, a GitHub Actions
 *     schedule, or any external cron service with zero changes — which is the
 *     requirement while the app is still on Netlify.
 *
 * Usage:
 *   MAINTENANCE_URL=https://example.com MAINTENANCE_SECRET=... node scripts/run-maintenance.mjs
 *   node scripts/run-maintenance.mjs --dry-run
 *   node scripts/run-maintenance.mjs --batch-size=500 --max-batches=50
 *
 * Exit codes:
 *   0  completed (a partially capped run is still a success — see below)
 *   1  request failed, or the server reported per-table errors
 *
 * A capped run exits 0 on purpose: hitting the per-table batch cap is the designed
 * behaviour under a large backlog, and the next scheduled run continues. Treating
 * it as failure would make a healthy first run page an operator.
 */

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

const baseUrl = (process.env.MAINTENANCE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(
  /\/+$/,
  ""
);
const secret = process.env.MAINTENANCE_SECRET;

if (!secret) {
  console.error(
    "MAINTENANCE_SECRET is not set.\n" +
      "It must match the server's MAINTENANCE_SECRET. If the server has none set, it derives\n" +
      "one from SESSION_SECRET and this script cannot reproduce it — set MAINTENANCE_SECRET\n" +
      "on both sides."
  );
  process.exit(1);
}

const params = new URLSearchParams();
if (flag("dry-run")) params.set("dryRun", "1");
const batchSize = value("batch-size");
if (batchSize) params.set("batchSize", batchSize);
const maxBatches = value("max-batches");
if (maxBatches) params.set("maxBatches", maxBatches);

const url = `${baseUrl}/api/v1/maintenance${params.size > 0 ? `?${params}` : ""}`;

// Generous but finite: a first run over a large backlog is slow, and a hung request
// must not leave a cron job running until the next one starts.
const TIMEOUT_MS = Number(process.env.MAINTENANCE_TIMEOUT_MS ?? 600_000);

const started = Date.now();
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

try {
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, accept: "application/json" },
    signal: controller.signal,
  });

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 500) };
  }

  if (!response.ok) {
    // The URL is printed without the secret, which travels in a header.
    console.error(`maintenance failed: HTTP ${response.status} ${url}`);
    console.error(JSON.stringify(body, null, 2));
    process.exit(1);
  }

  const data = body?.data ?? body;
  const retention = data?.retention;

  console.log(
    JSON.stringify(
      {
        ok: true,
        durationMs: Date.now() - started,
        purgedSessions: data?.purgedSessions,
        purgedRateLimits: data?.purgedRateLimits,
        closedSupportSessions: data?.closedSupportSessions,
        purgedTokens: data?.purgedTokens,
        leaderboardRows: data?.leaderboardRows,
        retention: retention
          ? {
              dryRun: retention.dryRun,
              totalDeleted: retention.totalDeleted,
              perTable: Object.fromEntries((retention.tables ?? []).map((row) => [row.table, row.deleted])),
              capped: (retention.tables ?? []).filter((row) => row.capped).map((row) => row.table),
              errors: (retention.tables ?? []).filter((row) => row.error).map((row) => row.table),
            }
          : null,
      },
      null,
      2
    )
  );

  if (retention?.hadErrors) {
    console.error("one or more retention tables reported an error; see server logs");
    process.exit(1);
  }
} catch (error) {
  const aborted = error?.name === "AbortError";
  console.error(aborted ? `maintenance timed out after ${TIMEOUT_MS}ms` : `maintenance request failed: ${error}`);
  process.exit(1);
} finally {
  clearTimeout(timer);
}

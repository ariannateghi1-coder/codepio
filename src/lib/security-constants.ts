// Plain constants with zero Node-only dependencies (no prisma, no argon2),
// so this file is safe to import from Edge middleware as well as from
// security.ts on the server.
export const SESSION_COOKIE = "academy_session";
export const CSRF_COOKIE = "academy_csrf";

/**
 * Single-use OAuth `state` cookie for the YouTube connect flow.
 *
 * Defined here rather than in the route that sets it: a Next.js route module may
 * only export HTTP methods and a fixed set of config keys, so exporting a constant
 * from route.ts fails the production type check.
 */
export const OAUTH_STATE_COOKIE = "academy_yt_state";

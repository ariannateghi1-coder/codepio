import "server-only";
import type { NextResponse } from "next/server";
import { ok, route } from "./api";
import { requireActiveUser, requireAdmin, requireModerator, requireSession, requireUser, assertCsrf, toActor } from "./security";
import { enforceRateLimit, type RateLimitPolicy } from "./rate-limit";
import { getClientIp, hashIp, hashUserAgent } from "./http";
import type { Actor } from "./authz";
import type { User } from "@prisma/client";

/**
 * Route composition helpers.
 *
 * Each endpoint declares its requirements once — auth level, CSRF, rate-limit
 * policy — instead of repeating the same four lines and risking one route
 * quietly skipping CSRF or a limit. `route()` handles error mapping and logging.
 *
 * Dynamic segments are passed through as `ctx.params`, so `[id]` routes get the
 * same guarantees as static ones.
 */

/**
 * Next.js passes `{ params: Promise<...> }` as the second handler argument.
 *
 * It must be declared as a REQUIRED parameter: Next's generated route types
 * (.next/types) assert that the second argument accepts its `RouteContext`, and
 * an optional parameter widens the type to include `undefined`, which fails that
 * check at build time even though it type-checks fine in isolation. Static routes
 * still receive a context object at runtime, and the resolver below tolerates its
 * absence anyway.
 */
export type RouteArgs<P = Record<string, string>> = { params: Promise<P> };

/** Resolves dynamic segments defensively: static routes have no params. */
async function resolveParams<P>(args: RouteArgs<P>): Promise<P> {
  const pending = (args as RouteArgs<P> | undefined)?.params;
  return ((await pending) ?? {}) as P;
}

export type Ctx<P = Record<string, string>> = {
  req: Request;
  url: URL;
  user: User;
  actor: Actor;
  sessionId: string;
  ipHash: string | null;
  userAgentHash: string | null;
  params: () => Promise<P>;
};

type Options = {
  /** Rate-limit policy; identity is the user id (or IP hash for public routes). */
  rateLimit?: RateLimitPolicy;
  /** Set false for read-only endpoints that never mutate state. */
  csrf?: boolean;
};

type Level = "SESSION" | "ACTIVE" | "MODERATOR" | "ADMIN";

function guard(level: Level) {
  return async () => {
    if (level === "ACTIVE") return requireActiveUser();
    if (level === "MODERATOR") return requireModerator();
    if (level === "ADMIN") return requireAdmin();
    return (await requireSession()).user;
  };
}

function build<P, T>(
  level: Level,
  name: string,
  handler: (ctx: Ctx<P>) => Promise<T | NextResponse>,
  options: Options
) {
  return route(name, async (req: Request, args: RouteArgs<P>) => {
    const user = await guard(level)();
    if (options.csrf !== false) await assertCsrf(req);
    if (options.rateLimit) await enforceRateLimit(options.rateLimit, user.id);
    const { sessionId } = await requireSession();

    const ctx: Ctx<P> = {
      req,
      url: new URL(req.url),
      user,
      actor: toActor(user),
      sessionId,
      ipHash: hashIp(getClientIp(req)),
      userAgentHash: hashUserAgent(req.headers.get("user-agent")),
      params: () => resolveParams(args),
    };

    const result = await handler(ctx);
    return isResponse(result) ? result : ok(result);
  });
}

/** Authenticated account (settings and logout). */
export function authed<T, P = Record<string, string>>(
  name: string,
  handler: (ctx: Ctx<P>) => Promise<T | NextResponse>,
  options: Options = {}
) {
  return build<P, T>("SESSION", name, handler, options);
}

/** Authenticated and ACTIVE — required to participate. */
export function active<T, P = Record<string, string>>(
  name: string,
  handler: (ctx: Ctx<P>) => Promise<T | NextResponse>,
  options: Options = {}
) {
  return build<P, T>("ACTIVE", name, handler, options);
}

export function moderator<T, P = Record<string, string>>(
  name: string,
  handler: (ctx: Ctx<P>) => Promise<T | NextResponse>,
  options: Options = {}
) {
  return build<P, T>("MODERATOR", name, handler, options);
}

export function admin<T, P = Record<string, string>>(
  name: string,
  handler: (ctx: Ctx<P>) => Promise<T | NextResponse>,
  options: Options = {}
) {
  return build<P, T>("ADMIN", name, handler, options);
}

export type PublicCtx<P = Record<string, string>> = {
  req: Request;
  url: URL;
  /** Present when a valid session exists; public routes must not require it. */
  viewer: User | null;
  ipHash: string;
  params: () => Promise<P>;
};

/** Public endpoint. Rate limited by viewer id when signed in, else by IP hash. */
export function publicRoute<T, P = Record<string, string>>(
  name: string,
  handler: (ctx: PublicCtx<P>) => Promise<T | NextResponse>,
  options: Options = {}
) {
  return route(name, async (req: Request, args: RouteArgs<P>) => {
    const viewer = await safeViewer();
    const ipHash = hashIp(getClientIp(req));
    const mutating = req.method !== "GET" && req.method !== "HEAD";
    if (options.csrf !== false && mutating) await assertCsrf(req);
    if (options.rateLimit) await enforceRateLimit(options.rateLimit, viewer?.id ?? ipHash);

    const result = await handler({
      req,
      url: new URL(req.url),
      viewer,
      ipHash,
      params: () => resolveParams(args),
    });
    return isResponse(result) ? result : ok(result);
  });
}

async function safeViewer(): Promise<User | null> {
  try {
    return await requireUser();
  } catch {
    return null;
  }
}

function isResponse(value: unknown): value is NextResponse {
  return typeof value === "object" && value !== null && "headers" in value && "status" in value;
}

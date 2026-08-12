import { NextResponse } from "next/server";
import { ZodError, type ZodTypeAny, type output } from "zod";
import { Prisma } from "@prisma/client";
import { AppError, RateLimitError, ValidationError, internalMessage, type ErrorCode } from "./errors";
import { logger } from "./logger";
import { requestId as deriveRequestId } from "./http";

/**
 * The single API contract for every /api/v1/* route:
 *
 *   success: { success: true,  data: T,  requestId }
 *   failure: { success: false, error: { code, message, details }, requestId }
 *
 * Routes never build responses by hand — they return data (or throw a typed
 * error) from inside `route()`, which owns status mapping, logging, timing, and
 * making sure no internal detail escapes in production.
 */

export type ApiErrorCode = ErrorCode;

export type ApiSuccess<T> = { success: true; data: T; requestId: string };
export type ApiFailure = {
  success: false;
  error: { code: ApiErrorCode; message: string; details?: unknown };
  requestId: string;
};

export function ok<T>(data: T, init?: ResponseInit & { requestId?: string }): NextResponse<ApiSuccess<T>> {
  const { requestId = "", ...rest } = init ?? {};
  return NextResponse.json({ success: true as const, data, requestId }, rest);
}

export function fail(
  code: ApiErrorCode,
  message: string,
  status = 400,
  details?: unknown,
  requestId = ""
): NextResponse<ApiFailure> {
  return NextResponse.json(
    { success: false as const, error: { code, message, ...(details === undefined ? {} : { details }) }, requestId },
    { status }
  );
}

/** Body size guard that does not trust content-length: it measures what arrived. */
const MAX_BODY_BYTES = 128 * 1024;

export async function parseJson<T>(req: Request): Promise<T> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) {
    throw new AppError({ code: "BAD_REQUEST", status: 413, publicMessage: "حجم درخواست بیش از حد مجاز است." });
  }
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    throw new AppError({ code: "BAD_REQUEST", status: 413, publicMessage: "حجم درخواست بیش از حد مجاز است." });
  }
  if (!raw) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new AppError({ code: "BAD_REQUEST", status: 400, publicMessage: "بدنه درخواست JSON معتبر نیست." });
  }
}

/**
 * Parse + validate in one step; throws ValidationError with field details.
 *
 * Generic over the schema (not over a target type) so the return type is the
 * schema's OUTPUT type — with `.default()` applied, fields are non-optional,
 * which is what lets call sites use `query.page` without a null check.
 */
export async function parseBody<S extends ZodTypeAny>(req: Request, schema: S): Promise<output<S>> {
  const body = await parseJson<unknown>(req);
  const result = schema.safeParse(body);
  if (!result.success) throw new ValidationError(flattenZod(result.error));
  return result.data as output<S>;
}

export function parseQuery<S extends ZodTypeAny>(url: URL, schema: S): output<S> {
  const result = schema.safeParse(Object.fromEntries(url.searchParams.entries()));
  if (!result.success) throw new ValidationError(flattenZod(result.error));
  return result.data as output<S>;
}

function flattenZod(error: ZodError) {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return { fieldErrors };
}

/**
 * Wraps a route handler: assigns a request id, times the call, maps any thrown
 * error to the standard envelope, and logs with structured context.
 *
 * Unexpected errors are logged in full server-side and returned to the client as
 * a generic SERVER_ERROR — stack traces, Prisma messages and provider payloads
 * never cross the wire.
 */
export function route<Args extends unknown[]>(
  name: string,
  handler: (req: Request, ...args: Args) => Promise<NextResponse | Response>
) {
  return async (req: Request, ...args: Args): Promise<NextResponse | Response> => {
    const rid = deriveRequestId(req);
    const startedAt = Date.now();
    const log = logger.child({ requestId: rid, route: name, method: req.method });

    try {
      const res = await handler(req, ...args);
      res.headers.set("x-request-id", rid);
      log.debug("request completed", { status: res.status, durationMs: Date.now() - startedAt });
      return res;
    } catch (e) {
      const durationMs = Date.now() - startedAt;
      const mapped = mapError(e);

      if (mapped.status >= 500) {
        log.error("request failed", { status: mapped.status, code: mapped.code, durationMs, error: internalMessage(e) });
      } else {
        log.info("request rejected", { status: mapped.status, code: mapped.code, durationMs });
      }

      const res = fail(mapped.code, mapped.message, mapped.status, mapped.details, rid);
      res.headers.set("x-request-id", rid);
      if (e instanceof RateLimitError) res.headers.set("retry-after", String(e.retryAfterSeconds));
      return res;
    }
  };
}

function mapError(e: unknown): { code: ApiErrorCode; message: string; status: number; details?: unknown } {
  if (e instanceof AppError) {
    return { code: e.code, message: e.publicMessage, status: e.status, details: e.details };
  }

  // A Response thrown from deep in a helper (legacy pattern) still works.
  if (e instanceof Response) {
    const status = e.status;
    return {
      code: status === 401 ? "UNAUTHORIZED" : status === 403 ? "FORBIDDEN" : "SERVER_ERROR",
      message:
        status === 401
          ? "لطفاً وارد حساب کاربری خود شوید."
          : status === 403
            ? "دسترسی به این بخش مجاز نیست."
            : "خطای غیرمنتظره رخ داد.",
      status,
    };
  }

  if (e instanceof ZodError) {
    return { code: "VALIDATION_ERROR", message: "اطلاعات ارسال‌شده معتبر نیست.", status: 422, details: flattenZod(e) };
  }

  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (e.code === "P2002") return { code: "CONFLICT", message: "این مورد قبلاً ثبت شده است.", status: 409 };
    if (e.code === "P2025") return { code: "NOT_FOUND", message: "موردی که دنبالش بودید پیدا نشد.", status: 404 };
    if (e.code === "P2003") return { code: "BAD_REQUEST", message: "ارجاع داده‌شده معتبر نیست.", status: 400 };
  }

  return { code: "SERVER_ERROR", message: "خطای غیرمنتظره رخ داد.", status: 500 };
}

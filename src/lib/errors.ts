/**
 * Error taxonomy.
 *
 * Every failure in the app is one of these classes, which is what lets the API
 * layer map errors to a stable HTTP status + machine-readable code without any
 * route needing its own try/catch translation table, and without ever leaking
 * an internal message (Prisma text, provider payloads, stack traces) to a client.
 */

export type ErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "BAD_REQUEST"
  | "PRECONDITION_FAILED"
  | "UPSTREAM_ERROR"
  | "SERVER_ERROR";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** Safe to send to the client (already user-facing, localized copy). */
  readonly publicMessage: string;
  readonly details?: unknown;
  /** True for expected business outcomes — logged at info/warn, not error. */
  readonly expected: boolean;

  constructor(opts: {
    code: ErrorCode;
    status: number;
    publicMessage: string;
    internalMessage?: string;
    details?: unknown;
    expected?: boolean;
    cause?: unknown;
  }) {
    super(opts.internalMessage ?? opts.publicMessage);
    this.name = "AppError";
    this.code = opts.code;
    this.status = opts.status;
    this.publicMessage = opts.publicMessage;
    this.details = opts.details;
    this.expected = opts.expected ?? true;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

export class UnauthorizedError extends AppError {
  constructor(publicMessage = "لطفاً وارد حساب کاربری خود شوید.") {
    super({ code: "UNAUTHORIZED", status: 401, publicMessage });
  }
}

export class ForbiddenError extends AppError {
  constructor(publicMessage = "دسترسی به این بخش مجاز نیست.", details?: unknown) {
    super({ code: "FORBIDDEN", status: 403, publicMessage, details });
  }
}

export class CsrfError extends AppError {
  constructor() {
    super({
      code: "FORBIDDEN",
      status: 403,
      publicMessage: "نشست شما منقضی شده است. صفحه را بازخوانی کنید و دوباره تلاش کنید.",
      internalMessage: "CSRF validation failed",
    });
  }
}

export class ValidationError extends AppError {
  constructor(details?: unknown, publicMessage = "اطلاعات ارسال‌شده معتبر نیست.") {
    super({ code: "VALIDATION_ERROR", status: 422, publicMessage, details });
  }
}

export class NotFoundError extends AppError {
  constructor(publicMessage = "موردی که دنبالش بودید پیدا نشد.") {
    super({ code: "NOT_FOUND", status: 404, publicMessage });
  }
}

export class ConflictError extends AppError {
  constructor(publicMessage = "این عملیات قبلاً انجام شده است.") {
    super({ code: "CONFLICT", status: 409, publicMessage });
  }
}

export class RateLimitError extends AppError {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number, publicMessage = "تعداد درخواست‌ها بیش از حد مجاز است. کمی بعد دوباره تلاش کنید.") {
    super({ code: "RATE_LIMITED", status: 429, publicMessage, details: { retryAfterSeconds } });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class BusinessRuleError extends AppError {
  constructor(publicMessage: string, opts?: { code?: ErrorCode; status?: number; details?: unknown; rule?: string }) {
    super({
      code: opts?.code ?? "PRECONDITION_FAILED",
      status: opts?.status ?? 422,
      publicMessage,
      internalMessage: opts?.rule ? `business rule violated: ${opts.rule}` : undefined,
      details: opts?.details,
    });
  }
}

/** An external provider (YouTube, Ably, Redis) failed. */
export class UpstreamError extends AppError {
  constructor(provider: string, internalMessage: string, cause?: unknown) {
    super({
      code: "UPSTREAM_ERROR",
      status: 502,
      publicMessage: "سرویس بیرونی در دسترس نیست. لطفاً چند لحظه بعد دوباره تلاش کنید.",
      internalMessage: `[${provider}] ${internalMessage}`,
      expected: false,
      cause,
    });
  }
}

/** Extracts a message from an unknown thrown value without leaking internals. */
export function errorMessage(e: unknown, fallback = "خطای غیرمنتظره‌ای رخ داد."): string {
  if (e instanceof AppError) return e.publicMessage;
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === "string" && e) return e;
  return fallback;
}

/** Internal, log-only description. Never returned to a client. */
export function internalMessage(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return "unserializable error";
  }
}

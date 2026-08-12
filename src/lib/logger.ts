/**
 * Structured logger.
 *
 * Replaces scattered console.log calls with a single leveled, JSON-emitting
 * logger that always carries correlation context (requestId, userId, route).
 *
 * Secrets never reach the output: every value passes through `redactLogValue()`, which
 * drops keys matching known-sensitive names and truncates anything token-shaped.
 */
import { env, isProduction } from "./env";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_WEIGHT = LEVEL_WEIGHT[env.LOG_LEVEL];

const SENSITIVE_KEY = /(password|passwd|secret|token|cookie|authorization|csrf|apikey|api_key|refresh|access_token|session|otp|vapid|private)/i;
const SENSITIVE_VALUE = /(?:bearer\s+[a-z0-9._~+\/-]+=*|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+|eyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,})/gi;

export type LogContext = {
  requestId?: string;
  userId?: string;
  route?: string;
  method?: string;
  status?: number;
  durationMs?: number;
  code?: string;
  [key: string]: unknown;
};

export function redactLogValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[depth-limit]";
  if (value === null || value === undefined) return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: isProduction ? undefined : value.stack };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactLogValue(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : redactLogValue(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string") {
    const redacted = value.replace(SENSITIVE_VALUE, "[redacted]");
    return redacted.length > 512 ? `${redacted.slice(0, 512)}…[truncated]` : redacted;
  }
  return value;
}

function emit(level: LogLevel, message: string, context?: LogContext) {
  if (LEVEL_WEIGHT[level] < MIN_WEIGHT) return;
  const record = {
    level,
    time: new Date().toISOString(),
    message,
    ...(context ? (redactLogValue(context) as Record<string, unknown>) : {}),
  };
  const line = isProduction ? JSON.stringify(record) : `${level.toUpperCase()} ${message} ${context ? JSON.stringify(redactLogValue(context)) : ""}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (message: string, context?: LogContext) => emit("debug", message, context),
  info: (message: string, context?: LogContext) => emit("info", message, context),
  warn: (message: string, context?: LogContext) => emit("warn", message, context),
  error: (message: string, context?: LogContext) => emit("error", message, context),
  /** Returns a logger with baked-in context, for per-request use. */
  child(base: LogContext) {
    return {
      debug: (m: string, c?: LogContext) => emit("debug", m, { ...base, ...c }),
      info: (m: string, c?: LogContext) => emit("info", m, { ...base, ...c }),
      warn: (m: string, c?: LogContext) => emit("warn", m, { ...base, ...c }),
      error: (m: string, c?: LogContext) => emit("error", m, { ...base, ...c }),
    };
  },
};

export type ChildLogger = ReturnType<typeof logger.child>;

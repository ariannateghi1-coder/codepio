"use client";

import { getCsrfHeader } from "./csrf";

/**
 * Browser API client.
 *
 * Two things it guarantees for every mutation:
 *  1. The CSRF token from the readable cookie is mirrored into x-csrf-token,
 *     which is the double-submit half the server compares against the hash bound
 *     to the session.
 *  2. Failures arrive as a typed ApiError carrying the server's machine-readable
 *     code and field details, so forms can attach messages to the right input
 *     instead of showing one generic banner.
 */

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fieldErrors: Record<string, string[]>;
  readonly requestId?: string;

  constructor(opts: { code: string; message: string; status: number; fieldErrors?: Record<string, string[]>; requestId?: string }) {
    super(opts.message);
    this.name = "ApiError";
    this.code = opts.code;
    this.status = opts.status;
    this.fieldErrors = opts.fieldErrors ?? {};
    this.requestId = opts.requestId;
  }
}

type Envelope<T> =
  | { success: true; data: T; requestId?: string }
  | { success: false; error: { code: string; message: string; details?: { fieldErrors?: Record<string, string[]> } }; requestId?: string };

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const method = (init.method ?? "GET").toUpperCase();

  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (method !== "GET" && method !== "HEAD") {
    const csrf = getCsrfHeader();
    if (csrf) headers.set("x-csrf-token", csrf);
  }

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers, credentials: "include" });
  } catch {
    throw new ApiError({ code: "NETWORK_ERROR", message: "ارتباط با سرور برقرار نشد. اتصال خود را بررسی کنید.", status: 0 });
  }

  const payload = (await response.json().catch(() => null)) as Envelope<T> | null;

  if (!payload) {
    throw new ApiError({ code: "SERVER_ERROR", message: "پاسخ سرور قابل خواندن نبود.", status: response.status });
  }

  if (!response.ok || !payload.success) {
    const error = payload.success ? null : payload.error;
    throw new ApiError({
      code: error?.code ?? "SERVER_ERROR",
      message: error?.message ?? "خطای غیرمنتظره رخ داد.",
      status: response.status,
      fieldErrors: error?.details?.fieldErrors,
      requestId: payload.requestId,
    });
  }

  return payload.data;
}

export const api = {
  get: <T,>(path: string) => apiRequest<T>(path),
  post: <T,>(path: string, body?: unknown) =>
    apiRequest<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T,>(path: string, body?: unknown) =>
    apiRequest<T>(path, { method: "PATCH", body: body === undefined ? undefined : JSON.stringify(body) }),
  delete: <T,>(path: string, body?: unknown) =>
    apiRequest<T>(path, { method: "DELETE", body: body === undefined ? undefined : JSON.stringify(body) }),
};

/** Human-readable message from any thrown value. */
export function errorMessage(e: unknown, fallback = "خطای غیرمنتظره‌ای رخ داد."): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

/** Field-level errors from a validation failure, for inline form messages. */
export function fieldErrors(e: unknown): Record<string, string> {
  if (!(e instanceof ApiError)) return {};
  return Object.fromEntries(Object.entries(e.fieldErrors).map(([key, messages]) => [key, messages[0] ?? ""]));
}

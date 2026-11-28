/**
 * Error taxonomy for the Capgate cloud client.
 *
 * Callers need to tell "the control plane is unreachable" from "the tool already
 * ran": the former is safe to retry for idempotent calls, the latter never is.
 */
export type CapgateErrorKind = "network" | "timeout" | "http";

export type CapgateErrorCode =
  | "control_plane_unreachable"
  | "rate_limited"
  | "unauthorized"
  | "invalid_request";

export interface CapgateErrorOptions {
  kind: CapgateErrorKind;
  code: CapgateErrorCode;
  message: string;
  status?: number;
  retryAfterSec?: number;
  /** True when retrying the same request could succeed (transport, timeout, 429, 5xx). */
  retryable?: boolean;
  cause?: unknown;
}

export class CapgateError extends Error {
  readonly kind: CapgateErrorKind;
  readonly code: CapgateErrorCode;
  readonly status?: number;
  readonly retryAfterSec?: number;
  readonly retryable: boolean;

  constructor({ kind, code, message, status, retryAfterSec, retryable = false, cause }: CapgateErrorOptions) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CapgateError";
    this.kind = kind;
    this.code = code;
    this.status = status;
    this.retryAfterSec = retryAfterSec;
    this.retryable = retryable;
  }
}

export function isCapgateError(e: unknown): e is CapgateError {
  return e instanceof CapgateError;
}

/** `Retry-After` is either delta-seconds or an HTTP date; clamp to a sane ceiling. */
const MAX_RETRY_AFTER_SEC = 60;

export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const raw = header.trim();
  if (raw === "") return undefined;

  const seconds = Number(raw);
  const value = Number.isFinite(seconds)
    ? seconds
    : Math.max(0, Math.round((Date.parse(raw) - now) / 1000));
  if (!Number.isFinite(value)) return undefined;
  return Math.min(Math.max(0, value), MAX_RETRY_AFTER_SEC);
}

export function mapHttpError(
  operation: string,
  status: number,
  retryAfterSec?: number,
): CapgateError {
  if (status === 429) {
    const hint =
      retryAfterSec === undefined ? "retry later" : `retry after ${retryAfterSec}s`;
    return new CapgateError({
      kind: "http",
      code: "rate_limited",
      status,
      retryAfterSec,
      retryable: true,
      message: `${operation} 429 rate_limited: ${hint}`,
    });
  }

  if (status === 401 || status === 403) {
    return new CapgateError({
      kind: "http",
      code: "unauthorized",
      status,
      retryable: false,
      message: `${operation} ${status} unauthorized: check CAPGATE_API_KEY`,
    });
  }

  if (status >= 500) {
    return new CapgateError({
      kind: "http",
      code: "control_plane_unreachable",
      status,
      retryable: true,
      message: `${operation} ${status}`,
    });
  }

  return new CapgateError({
    kind: "http",
    code: "invalid_request",
    status,
    retryable: false,
    message: `${operation} ${status}`,
  });
}

export function networkError(operation: string, cause: unknown): CapgateError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new CapgateError({
    kind: "network",
    code: "control_plane_unreachable",
    retryable: true,
    cause,
    message: `${operation} network error: ${detail}`,
  });
}

export function timeoutError(operation: string, timeoutMs: number): CapgateError {
  return new CapgateError({
    kind: "timeout",
    code: "control_plane_unreachable",
    retryable: true,
    message: `${operation} timeout after ${timeoutMs}ms`,
  });
}

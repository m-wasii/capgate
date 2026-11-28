import type { Decision, Meter, Policy } from "./policy.js";
import {
  CapgateError,
  isCapgateError,
  mapHttpError,
  networkError,
  parseRetryAfter,
  timeoutError,
} from "./errors.js";

export { CapgateError, isCapgateError, type CapgateErrorCode, type CapgateErrorKind } from "./errors.js";

export interface CloudStatus {
  policy: Policy;
  meter: Meter;
}

export interface AuthorizeResult extends CloudStatus {
  authorizationId: string;
}

export interface ApprovalRecord {
  id: string;
  toolName: string;
  args: unknown;
  status: "pending" | "approved" | "denied";
}

/** Per-request timeout. A paused Railway deployment must fail fast, not hang the agent. */
export const DEFAULT_HTTP_TIMEOUT_MS = 10_000;

/** Safe reads get at most this many attempts in total (1 try + 2 retries). */
export const MAX_ATTEMPTS = 3;

const DEFAULT_RETRY_BASE_MS = 200;
const MAX_BACKOFF_MS = 5_000;

/** Resolved per call so tests and operators can tune it without re-importing. */
export function httpTimeoutMs(): number {
  const raw = Number(process.env.CAPGATE_HTTP_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_HTTP_TIMEOUT_MS;
}

function retryBaseMs(): number {
  const raw = Number(process.env.CAPGATE_HTTP_RETRY_BASE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_RETRY_BASE_MS;
}

interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  /** Only idempotent reads may be retried. Unsafe calls run exactly once. */
  retryable?: boolean;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Exponential backoff with full jitter, or the server's `Retry-After` when present. */
function backoffMs(attempt: number, retryAfterSec?: number): number {
  if (retryAfterSec !== undefined) return retryAfterSec * 1000;
  const ceiling = Math.min(MAX_BACKOFF_MS, retryBaseMs() * 2 ** (attempt - 1));
  return Math.floor(Math.random() * ceiling);
}

function isAbort(e: unknown): boolean {
  const name = typeof e === "object" && e !== null && "name" in e ? String(e.name) : "";
  return name === "TimeoutError" || name === "AbortError";
}

async function requestOnce<T>(
  operation: string,
  url: string,
  apiKey: string,
  options: RequestOptions,
): Promise<T> {
  const timeoutMs = httpTimeoutMs();
  let res: Response;
  try {
    res = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (isAbort(e)) throw timeoutError(operation, timeoutMs);
    throw networkError(operation, e);
  }

  if (!res.ok) {
    throw mapHttpError(operation, res.status, parseRetryAfter(res.headers.get("retry-after")));
  }

  try {
    return (await res.json()) as T;
  } catch (e) {
    throw isCapgateError(e) ? e : networkError(operation, e);
  }
}

/**
 * One request, optionally retried. Never logs the API key or the request body.
 */
async function request<T>(
  operation: string,
  url: string,
  apiKey: string,
  options: RequestOptions = {},
): Promise<T> {
  const attempts = options.retryable ? MAX_ATTEMPTS : 1;

  for (let attempt = 1; ; attempt++) {
    try {
      return await requestOnce<T>(operation, url, apiKey, options);
    } catch (e) {
      const err = isCapgateError(e) ? e : new CapgateError({
        kind: "network",
        code: "control_plane_unreachable",
        message: `${operation} failed`,
        cause: e,
      });
      if (!err.retryable || attempt >= attempts) throw err;
      await sleep(backoffMs(attempt, err.retryAfterSec));
    }
  }
}

export async function cloudStatus(baseUrl: string, apiKey: string): Promise<CloudStatus> {
  return request<CloudStatus>("status", `${baseUrl}/api/v1/status`, apiKey, { retryable: true });
}

export async function cloudDecide(
  baseUrl: string,
  apiKey: string,
  toolName: string,
): Promise<Decision & { approvalId?: string }> {
  return request<Decision & { approvalId?: string }>("decide", `${baseUrl}/api/v1/decide`, apiKey, {
    method: "POST",
    body: { toolName },
    // Pure policy read: replaying it cannot spend money.
    retryable: true,
  });
}

export async function cloudCreateApproval(
  baseUrl: string,
  apiKey: string,
  toolName: string,
  args: unknown,
): Promise<ApprovalRecord> {
  return request<ApprovalRecord>("approvals", `${baseUrl}/api/v1/approvals`, apiKey, {
    method: "POST",
    body: { toolName, args },
  });
}

export async function cloudGetApproval(
  baseUrl: string,
  apiKey: string,
  id: string,
): Promise<ApprovalRecord> {
  return request<ApprovalRecord>("approval", `${baseUrl}/api/v1/approvals/${id}`, apiKey, {
    retryable: true,
  });
}

export async function cloudCommit(
  baseUrl: string,
  apiKey: string,
  toolName: string,
  approvalId?: string,
): Promise<CloudStatus> {
  return request<CloudStatus>("commit", `${baseUrl}/api/v1/commit`, apiKey, {
    method: "POST",
    body: { toolName, approvalId },
  });
}

export async function cloudAuthorize(
  baseUrl: string,
  apiKey: string,
  toolName: string,
  approvalId?: string,
): Promise<AuthorizeResult> {
  // Never retried: a double authorize double-charges.
  return request<AuthorizeResult>("authorize", `${baseUrl}/api/v1/authorize`, apiKey, {
    method: "POST",
    body: { toolName, approvalId },
  });
}

export async function cloudSettle(
  baseUrl: string,
  apiKey: string,
  authorizationId: string,
): Promise<CloudStatus> {
  // Never retried: a replayed settle returns `already_consumed`.
  return request<CloudStatus>("settle", `${baseUrl}/api/v1/settle`, apiKey, {
    method: "POST",
    body: { authorizationId },
  });
}

export async function cloudRelease(
  baseUrl: string,
  apiKey: string,
  authorizationId: string,
): Promise<CloudStatus> {
  // Never retried: refunds must not be replayed.
  return request<CloudStatus>("release", `${baseUrl}/api/v1/release`, apiKey, {
    method: "POST",
    body: { authorizationId },
  });
}

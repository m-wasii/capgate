import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import { applySpend, decide, utcDay, type Decision, type Meter, type Policy } from "./policy.js";

export function loadPolicy(path: string): Policy {
  const raw = parseYaml(readFileSync(path, "utf8")) as Policy;
  if (typeof raw.dailySpendCapUsd !== "number" || !raw.tools) {
    throw new Error(`invalid policy at ${path}`);
  }
  return {
    dailySpendCapUsd: raw.dailySpendCapUsd,
    killed: Boolean(raw.killed),
    tools: raw.tools,
  };
}

/** The meter exists but cannot be trusted. We fail closed rather than reset the spend to zero. */
export class MeterCorruptError extends Error {
  readonly code = "METER_CORRUPT";
  constructor(
    readonly meterPath: string,
    detail: string,
  ) {
    super(
      `capgate: meter ${meterPath} is unreadable (${detail}). ` +
        "Refusing to run so the daily cap cannot be bypassed by a reset. " +
        `Inspect the file, then restore it from a backup or delete ${meterPath} to start today's meter at $0 ` +
        "(deleting it resets today's spend, so check your provider bill first).",
    );
    this.name = "MeterCorruptError";
  }
}

/** Another process holds the meter lock for too long. Never proceeds without it. */
export class MeterLockError extends Error {
  readonly code = "METER_LOCKED";
  constructor(
    readonly lockPath: string,
    detail: string,
    recovery: string,
  ) {
    super(`capgate: could not acquire meter lock ${lockPath} (${detail}). ${recovery}`);
    this.name = "MeterLockError";
  }
}

export interface MeterLockOptions {
  /** Give up waiting for the lock after this many ms. Default 10s, or CAPGATE_LOCK_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Take over a lock whose file is older than this many ms. Default 30s, or CAPGATE_LOCK_STALE_MS. */
  staleMs?: number;
  /** Initial retry backoff in ms; doubles up to 100ms. Default 5ms. */
  retryMs?: number;
}

function errorCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | undefined)?.code;
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function msFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

let tempCounter = 0;

function tempPathFor(target: string): string {
  return `${target}.tmp-${process.pid}-${tempCounter++}`;
}

/**
 * Windows lets an antivirus scanner or indexer hold the target for a few ms, so a rename can fail
 * with EPERM/EACCES/EBUSY. Retry briefly; rename is atomic once it succeeds.
 */
function renameWithRetry(from: string, to: string): void {
  const deadline = Date.now() + 2_000;
  for (let delay = 5; ; delay = Math.min(delay * 2, 100)) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      const code = errorCode(e);
      const transient = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (!transient || Date.now() >= deadline) throw e;
      sleepSync(delay);
    }
  }
}

/** Write `<meter>.tmp-<pid>-<n>`, fsync it, then rename over the meter. Never writes the meter in place. */
export function saveMeter(path: string, meter: Meter): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = tempPathFor(path);
  const body = `${JSON.stringify(meter, null, 2)}\n`;
  const fd = openSync(tmp, "wx");
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } catch (e) {
    try {
      closeSync(fd);
    } catch {
      // fall through to the cleanup below
    }
    try {
      unlinkSync(tmp);
    } catch {
      // best effort; the temp name is unique
    }
    throw e;
  }
  closeSync(fd);
  try {
    renameWithRetry(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // best effort; the temp name is unique
    }
    throw e;
  }
}

function parseMeter(path: string, raw: string): Meter {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (e) {
    throw new MeterCorruptError(path, `invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new MeterCorruptError(path, "expected a JSON object");
  }
  const { day, spentUsd } = parsed as Partial<Meter>;
  if (typeof day !== "string" || day.length === 0) {
    throw new MeterCorruptError(path, `"day" must be a non-empty string, got ${JSON.stringify(day)}`);
  }
  if (typeof spentUsd !== "number" || !Number.isFinite(spentUsd) || spentUsd < 0) {
    throw new MeterCorruptError(path, `"spentUsd" must be a non-negative number, got ${JSON.stringify(spentUsd)}`);
  }
  return { day, spentUsd };
}

/** Missing meter starts at zero; an unparseable or malformed meter throws MeterCorruptError. */
export function loadMeter(path: string): Meter {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if (errorCode(e) === "ENOENT") return { day: utcDay(), spentUsd: 0 };
    throw e;
  }
  return parseMeter(path, raw);
}

function lockPathFor(meterPath: string): string {
  return `${meterPath}.lock`;
}

function readHolder(lockPath: string): { ageMs: number; holder: string } | undefined {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch (e) {
    if (errorCode(e) === "ENOENT") return undefined;
    throw e;
  }
  let holder = "unknown holder";
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown; at?: unknown };
    holder = `pid ${String(parsed.pid)} since ${String(parsed.at)}`;
  } catch {
    // A holder that has created but not yet written its lock is still fresh by mtime.
  }
  return { ageMs: Date.now() - mtimeMs, holder };
}

/** Rename the stale lock aside so exactly one waiter wins the takeover; the rest race cleanly on `wx`. */
function stealStaleLock(lockPath: string): void {
  const graveyard = `${lockPath}.stale-${process.pid}-${tempCounter++}`;
  try {
    renameSync(lockPath, graveyard);
  } catch (e) {
    const code = errorCode(e);
    if (code === "ENOENT" || code === "EPERM" || code === "EACCES" || code === "EBUSY") return;
    throw e;
  }
  try {
    unlinkSync(graveyard);
  } catch {
    // best effort; it is a uniquely named corpse
  }
}

function acquireLock(meterPath: string, options: MeterLockOptions): string {
  const lockPath = lockPathFor(meterPath);
  mkdirSync(dirname(lockPath), { recursive: true });
  const timeoutMs = options.timeoutMs ?? msFromEnv("CAPGATE_LOCK_TIMEOUT_MS", 10_000);
  const staleMs = options.staleMs ?? msFromEnv("CAPGATE_LOCK_STALE_MS", 30_000);
  const retryMs = Math.max(1, options.retryMs ?? 5);
  const deadline = Date.now() + timeoutMs;
  let delay = retryMs;

  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return lockPath;
    } catch (e) {
      if (errorCode(e) !== "EEXIST") throw e;

      const holder = readHolder(lockPath);
      if (holder && holder.ageMs > staleMs) {
        stealStaleLock(lockPath);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new MeterLockError(
          lockPath,
          `${holder?.holder ?? "unknown holder"}, held for ${Math.round(holder?.ageMs ?? 0)}ms, waited ${timeoutMs}ms`,
          `Another capgate process is still updating the meter; try again. If none is running, delete ${lockPath} ` +
            `(locks older than ${staleMs}ms are taken over automatically).`,
        );
      }
      sleepSync(Math.min(delay, Math.max(0, deadline - Date.now())));
      delay = Math.min(delay * 2, 100);
    }
  }
}

function releaseLock(lockPath: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      unlinkSync(lockPath);
      return;
    } catch (e) {
      const code = errorCode(e);
      if (code === "ENOENT") return;
      if ((code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") || attempt >= 20) {
        process.emitWarning(`capgate: could not release meter lock ${lockPath} (${code ?? e}); it will go stale.`);
        return;
      }
      sleepSync(5);
    }
  }
}

/**
 * Cross-process lock around the meter: `open(..., "wx")` with the holder's pid + timestamp,
 * exponential backoff, stale-lock takeover, and release in `finally`.
 */
export function withMeterLock<T>(meterPath: string, fn: () => T, options: MeterLockOptions = {}): T {
  const lockPath = acquireLock(meterPath, options);
  try {
    return fn();
  } finally {
    releaseLock(lockPath);
  }
}

export function localDecide(policy: Policy, meterPath: string, toolName: string) {
  const meter = loadMeter(meterPath);
  return { decision: decide(policy, meter, toolName), meter };
}

/**
 * Charge the tool inside the lock, re-checking the cap against the meter as it is *right now*.
 * Throws `capgate blocked: cap` instead of writing when a concurrent call took the headroom first,
 * so N parallel callers can never push total spend past the daily cap.
 */
export function localCommit(policy: Policy, meterPath: string, toolName: string): Meter {
  return withMeterLock(meterPath, () => {
    const tool = policy.tools[toolName];
    if (!tool) throw new Error(`unknown tool ${toolName}`);
    const meter = loadMeter(meterPath);
    const decision = decide(policy, meter, toolName);
    // The caller has already authorized needs_approval tools; only the cap and the kill switch
    // are re-checked here, which is exactly what a concurrent caller can change.
    if (!decision.allow && decision.reason !== "needs_approval") {
      throw new Error(`capgate blocked: ${decision.reason}`);
    }
    const next = applySpend(meter, tool.costUsd);
    saveMeter(meterPath, next);
    return next;
  });
}

export interface LocalChargeResult {
  decision: Decision;
  meter: Meter;
}/**
 * Read → decide → apply → write in one lock-protected critical section. Nothing can interleave
 * between the cap check and the charge, so this is the race-free replacement for
 * `localDecide` + `localCommit`. gate.ts uses it on the allowed path and charges before running;
 * `localCommit` remains for the externally-approved `needs_approval` path.
 */
export function localCharge(
  policy: Policy,
  meterPath: string,
  toolName: string,
  options: MeterLockOptions & { now?: Date } = {},
): LocalChargeResult {
  const now = options.now ?? new Date();
  return withMeterLock(
    meterPath,
    () => {
      const meter = loadMeter(meterPath);
      const decision = decide(policy, meter, toolName, now);
      if (!decision.allow) return { decision, meter };
      const next = applySpend(meter, decision.costUsd, now);
      saveMeter(meterPath, next);
      return { decision, meter: next };
    },
    options,
  );
}

/**
 * Undo a `localCharge`/`localCommit` for a call that failed after being charged.
 *
 * Lock-held like `localCommit`, floored at $0 so a refund can never write a negative
 * `spentUsd`, and a no-op when the meter row belongs to another day — refunding then would
 * corrupt the new day's spend. Best-effort by contract: an unknown tool or an unwritable
 * meter leaves the charge in place rather than throwing, so a refund can never mask the
 * handler's original error.
 */
export function localRefund(policy: Policy, meterPath: string, toolName: string, now = new Date()): Meter {
  // Advisory only: the gate ignores it. On a refund failure the meter file is what matters,
  // and it is left exactly as it was charged.
  let observed: Meter | undefined;
  try {
    return withMeterLock(meterPath, () => {
      const meter = loadMeter(meterPath);
      observed = meter;
      const tool = policy.tools[toolName];
      if (!tool) return meter;
      if (meter.day !== utcDay(now)) return meter;
      const refunded: Meter = {
        day: meter.day,
        spentUsd: Math.max(0, Math.round((meter.spentUsd - tool.costUsd) * 1e6) / 1e6),
      };
      saveMeter(meterPath, refunded);
      return refunded;
    });
  } catch {
    // Best effort: leave the charge in place. The caller rethrows the handler's own error.
    try {
      return loadMeter(meterPath);
    } catch {
      return observed ?? { day: utcDay(now), spentUsd: 0 };
    }
  }
}

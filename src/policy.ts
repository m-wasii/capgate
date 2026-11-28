import { createHash } from "node:crypto";

export type Risk = "low" | "spend" | "send" | "delete" | "pii";

/** Integer micro-USD per dollar. Money arithmetic never leaves `BigInt` until the boundary. */
export const MICROS_PER_USD = 1_000_000;
/** Largest single-argument value we will price. 1e9 USD * 1e6 = 1e15 < 2^53. */
export const MAX_COST_ARG_USD = 1_000_000_000;

const MAX_MICROS = BigInt(MAX_COST_ARG_USD) * BigInt(MICROS_PER_USD);
const PCT_ONE = BigInt(MICROS_PER_USD);

/**
 * Declarative per-call price. `percent` scales with a top-level numeric argument;
 * `fixed` is a constant. Both are optional: a tool with no `cost` uses `costUsd`.
 */
export type CostSpec =
  | { kind: "fixed"; usd: number | string }
  | {
      kind: "percent";
      /** Top-level argument name, own property only. `pct` is a fraction: 0.02 = 2%. */
      arg: string;
      pct: number | string;
      floorUsd?: number | string;
      maxUsd?: number | string;
    };

export interface ToolPolicy {
  risk: Risk;
  /** Authoritative when `cost` is absent; must equal the minimum charge when it is present. */
  costUsd: number;
  cost?: CostSpec;
}

export interface Policy {
  dailySpendCapUsd: number;
  killed: boolean;
  tools: Record<string, ToolPolicy>;
}

export interface Meter {
  day: string;
  spentUsd: number;
}

export type Decision =
  | { allow: true; costUsd: number }
  | {
      allow: false;
      reason: "killed" | "unknown_tool" | "cap" | "needs_approval" | "invalid_cost";
    };

/** A cost that cannot be derived from the args. Always blocks; never charges zero silently. */
export class InvalidCostError extends Error {
  readonly code = "invalid_cost";
  constructor(message: string) {
    super(message);
    this.name = "InvalidCostError";
  }
}

const DECIMAL = /^\+?(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;
const ARG_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const FORBIDDEN_ARG_NAMES = new Set(["__proto__", "constructor", "prototype"]);

/** Parse a non-negative number or decimal string into integer micro-USD, rounding half-up. */
function microsFromDecimal(value: unknown, label: string): bigint {
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new InvalidCostError(`${label} must be a finite number`);
    if (value < 0) throw new InvalidCostError(`${label} must be >= 0`);
    text = value.toString();
  } else if (typeof value === "string") {
    text = value.trim();
    if (text.startsWith("-")) throw new InvalidCostError(`${label} must be >= 0`);
  } else {
    throw new InvalidCostError(`${label} must be a number, got ${typeof value}`);
  }

  const match = DECIMAL.exec(text);
  if (!match) throw new InvalidCostError(`${label} is not a decimal number: ${JSON.stringify(value)}`);

  const over = () => new InvalidCostError(`${label} exceeds the maximum of ${MAX_COST_ARG_USD} USD`);
  const fraction = match[2] ?? "";
  const exponent = match[3] === undefined ? 0 : Number(match[3]);
  if (!Number.isSafeInteger(exponent)) throw new InvalidCostError(`${label} exponent is out of range`);

  const digits = BigInt(match[1] + fraction);
  if (digits === 0n) return 0n;

  const shift = exponent + 6 - fraction.length;
  const digitCount = digits.toString().length;
  let micros: bigint;
  if (shift >= 0) {
    // A positive power beyond 16 digits is already above MAX_MICROS (1e15); refuse before
    // materialising a giant BigInt from an attacker-controlled exponent.
    if (digitCount + shift > 16) throw over();
    micros = digits * 10n ** BigInt(shift);
  } else {
    const drop = -shift;
    // Strictly below 0.1 micro-USD rounds to zero; avoid a giant divisor.
    if (drop > digitCount) return 0n;
    const divisor = 10n ** BigInt(drop);
    const quotient = digits / divisor;
    micros = (digits % divisor) * 2n >= divisor ? quotient + 1n : quotient;
  }

  if (micros > MAX_MICROS) throw over();
  return micros;
}

function assertArgName(arg: unknown): asserts arg is string {
  if (typeof arg !== "string" || !ARG_NAME.test(arg) || FORBIDDEN_ARG_NAMES.has(arg)) {
    throw new InvalidCostError(
      `cost.arg must be a safe top-level argument name, got ${JSON.stringify(arg)}`,
    );
  }
}

/** Validate a spec without call args: shape, ranges, and floor/max ordering. */
export function validateCostSpec(spec: CostSpec): void {
  if (spec === null || typeof spec !== "object") throw new InvalidCostError("cost must be an object");

  if (spec.kind === "fixed") {
    microsFromDecimal(spec.usd, "cost.usd");
    return;
  }

  if (spec.kind === "percent") {
    assertArgName(spec.arg);
    const pct = microsFromDecimal(spec.pct, "cost.pct");
    if (pct <= 0n || pct > PCT_ONE) throw new InvalidCostError("cost.pct must satisfy 0 < pct <= 1");
    const floor = spec.floorUsd === undefined ? 0n : microsFromDecimal(spec.floorUsd, "cost.floorUsd");
    const max = spec.maxUsd === undefined ? MAX_MICROS : microsFromDecimal(spec.maxUsd, "cost.maxUsd");
    if (max < floor) throw new InvalidCostError("cost.maxUsd must be >= cost.floorUsd");
    return;
  }

  throw new InvalidCostError(`unknown cost.kind ${JSON.stringify((spec as { kind?: unknown }).kind)}`);
}

/** Validate one tool entry at policy load: spec shape and the `costUsd === minimum` invariant. */
export function validateToolPolicy(name: string, tool: ToolPolicy): void {
  if (tool === null || typeof tool !== "object") throw new Error(`tool ${name} must be an object`);
  if (tool.cost === undefined) {
    microsFromDecimal(tool.costUsd, `tool ${name} costUsd`);
    return;
  }

  validateCostSpec(tool.cost);
  const minimum =
    tool.cost.kind === "fixed"
      ? microsFromDecimal(tool.cost.usd, `tool ${name} cost.usd`)
      : tool.cost.floorUsd === undefined
        ? 0n
        : microsFromDecimal(tool.cost.floorUsd, `tool ${name} cost.floorUsd`);
  const advertised = microsFromDecimal(tool.costUsd, `tool ${name} costUsd`);
  if (advertised !== minimum) {
    throw new Error(
      `tool ${name} costUsd (${tool.costUsd}) must equal the minimum charge of its cost spec`,
    );
  }
}

/**
 * The single source of truth for what a call costs, in integer micro-USD.
 * Throws `InvalidCostError` for a missing, non-numeric, non-finite, negative, or too-large
 * argument, and for a malformed spec.
 */
export function costMicroUsd(tool: ToolPolicy, args: Record<string, unknown> = {}): bigint {
  const spec = tool.cost;
  if (spec === undefined) return microsFromDecimal(tool.costUsd, "costUsd");

  validateCostSpec(spec);
  if (spec.kind === "fixed") return microsFromDecimal(spec.usd, "cost.usd");

  if (!Object.hasOwn(args, spec.arg)) {
    throw new InvalidCostError(`cost.arg "${spec.arg}" is missing from args`);
  }
  const amount = microsFromDecimal(args[spec.arg], `args.${spec.arg}`);
  const pct = microsFromDecimal(spec.pct, "cost.pct");
  const raw = (amount * pct + 500_000n) / 1_000_000n;
  const floor = spec.floorUsd === undefined ? 0n : microsFromDecimal(spec.floorUsd, "cost.floorUsd");
  const max = spec.maxUsd === undefined ? MAX_MICROS : microsFromDecimal(spec.maxUsd, "cost.maxUsd");
  return raw < floor ? floor : raw > max ? max : raw;
}

/** `costMicroUsd` at the wire boundary. The only place micros become a JS number. */
export function computeCost(tool: ToolPolicy, args: Record<string, unknown> = {}): number {
  return Number(costMicroUsd(tool, args)) / MICROS_PER_USD;
}

/** Deterministic JSON with sorted keys. Must stay byte-identical to the cloud's canonical form. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`)
    .join(",")}}`;
}

/**
 * Approval identity: sha256 over the canonical args. Stable under key insertion order at every
 * nesting level, so an approval granted for one call cannot be redeemed with different args.
 */
export function hashArgs(args: unknown): string {
  return createHash("sha256").update(canonicalJson(args), "utf8").digest("hex");
}

/** Existing cloud name for `hashArgs`; keeps stored approvals comparable across the rename. */
export const hashApprovalArgs = hashArgs;

export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function rollMeter(meter: Meter, now = new Date()): Meter {
  const day = utcDay(now);
  if (meter.day !== day) return { day, spentUsd: 0 };
  return meter;
}

export function decide(
  policy: Policy,
  meter: Meter,
  toolName: string,
  now = new Date(),
  args: Record<string, unknown> = {},
): Decision {
  if (policy.killed) return { allow: false, reason: "killed" };
  if (!Object.hasOwn(policy.tools, toolName)) return { allow: false, reason: "unknown_tool" };
  const tool = policy.tools[toolName];

  let costUsd: number;
  try {
    costUsd = computeCost(tool, args);
  } catch (e) {
    if (e instanceof InvalidCostError) return { allow: false, reason: "invalid_cost" };
    throw e;
  }

  const rolled = rollMeter(meter, now);
  if (rolled.spentUsd + costUsd > policy.dailySpendCapUsd) return { allow: false, reason: "cap" };
  if (tool.risk !== "low") return { allow: false, reason: "needs_approval" };
  return { allow: true, costUsd };
}

export function applySpend(meter: Meter, costUsd: number, now = new Date()): Meter {
  const rolled = rollMeter(meter, now);
  return { day: rolled.day, spentUsd: Math.round((rolled.spentUsd + costUsd) * 1e6) / 1e6 };
}

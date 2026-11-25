import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import { applySpend, decide, utcDay, type Meter, type Policy } from "./policy.js";

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

export function loadMeter(path: string): Meter {
  if (!existsSync(path)) return { day: utcDay(), spentUsd: 0 };
  return JSON.parse(readFileSync(path, "utf8")) as Meter;
}

export function saveMeter(path: string, meter: Meter): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(meter, null, 2));
}

export function localDecide(policy: Policy, meterPath: string, toolName: string) {
  const meter = loadMeter(meterPath);
  return { decision: decide(policy, meter, toolName), meter };
}

export function localCommit(policy: Policy, meterPath: string, toolName: string): Meter {
  const tool = policy.tools[toolName];
  if (!tool) throw new Error(`unknown tool ${toolName}`);
  const next = applySpend(loadMeter(meterPath), tool.costUsd);
  saveMeter(meterPath, next);
  return next;
}

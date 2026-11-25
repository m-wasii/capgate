export type Risk = "low" | "spend" | "send" | "delete" | "pii";

export interface ToolPolicy {
  risk: Risk;
  costUsd: number;
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
  | { allow: false; reason: "killed" | "unknown_tool" | "cap" | "needs_approval" };

export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function rollMeter(meter: Meter, now = new Date()): Meter {
  const day = utcDay(now);
  if (meter.day !== day) return { day, spentUsd: 0 };
  return meter;
}

export function decide(policy: Policy, meter: Meter, toolName: string, now = new Date()): Decision {
  if (policy.killed) return { allow: false, reason: "killed" };
  const tool = policy.tools[toolName];
  if (!tool) return { allow: false, reason: "unknown_tool" };
  const rolled = rollMeter(meter, now);
  if (rolled.spentUsd + tool.costUsd > policy.dailySpendCapUsd) {
    return { allow: false, reason: "cap" };
  }
  if (tool.risk !== "low") return { allow: false, reason: "needs_approval" };
  return { allow: true, costUsd: tool.costUsd };
}

export function applySpend(meter: Meter, costUsd: number, now = new Date()): Meter {
  const rolled = rollMeter(meter, now);
  return { day: rolled.day, spentUsd: Math.round((rolled.spentUsd + costUsd) * 1e6) / 1e6 };
}

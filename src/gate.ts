import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  cloudCommit,
  cloudCreateApproval,
  cloudDecide,
  cloudGetApproval,
  sleep,
} from "./client.js";
import { loadPolicy, localCommit, localDecide } from "./local.js";

const here = dirname(fileURLToPath(import.meta.url));

function gatePaths() {
  return {
    apiUrl: process.env.CAPGATE_API_URL?.replace(/\/$/, ""),
    apiKey: process.env.CAPGATE_API_KEY ?? "dev-key",
    policyPath: process.env.CAPGATE_POLICY ?? join(here, "..", "policy.example.yaml"),
    meterPath: process.env.CAPGATE_METER ?? join(here, "..", ".capgate", "meter.json"),
    approvalTimeoutMs: Number(process.env.CAPGATE_APPROVAL_TIMEOUT_MS ?? 120_000),
  };
}

/** Decide + commit (cloud or local), then run. Unregistered names fail with unknown_tool. */
export async function gatedRun(toolName: string, args: unknown, run: () => string): Promise<string> {
  const { apiUrl, apiKey, policyPath, meterPath, approvalTimeoutMs } = gatePaths();

  if (apiUrl) {
    const decision = await cloudDecide(apiUrl, apiKey, toolName);
    if (decision.allow) {
      const out = run();
      await cloudCommit(apiUrl, apiKey, toolName);
      return out;
    }
    if (decision.reason === "needs_approval") {
      const approval = await cloudCreateApproval(apiUrl, apiKey, toolName, args);
      const deadline = Date.now() + approvalTimeoutMs;
      while (Date.now() < deadline) {
        const cur = await cloudGetApproval(apiUrl, apiKey, approval.id);
        if (cur.status === "approved") {
          const out = run();
          await cloudCommit(apiUrl, apiKey, toolName, approval.id);
          return out;
        }
        if (cur.status === "denied") throw new Error(`capgate denied approval ${approval.id}`);
        await sleep(1500);
      }
      throw new Error(`capgate approval timed out (${approval.id})`);
    }
    throw new Error(`capgate blocked: ${decision.reason}`);
  }

  const policy = loadPolicy(policyPath);
  const { decision } = localDecide(policy, meterPath, toolName);
  if (!decision.allow) {
    if (decision.reason === "needs_approval" && process.env.CAPGATE_LOCAL_APPROVE === "1") {
      const out = run();
      localCommit(policy, meterPath, toolName);
      return out;
    }
    throw new Error(`capgate blocked: ${decision.reason}`);
  }
  const out = run();
  localCommit(policy, meterPath, toolName);
  return out;
}

/**
 * Register an MCP tool that always goes through Capgate spend + approval.
 * Add the same name under `tools:` in policy (or cloud) or calls fail with unknown_tool.
 */
export function registerGatedTool(
  server: McpServer,
  name: string,
  description: string,
  schema: z.ZodRawShape,
  run: (args: Record<string, unknown>) => string,
) {
  return server.tool(name, description, schema, async (args) => {
    try {
      const text = await gatedRun(name, args, () => run(args as Record<string, unknown>));
      return { content: [{ type: "text", text }] };
    } catch (e) {
      return {
        content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
        isError: true,
      };
    }
  });
}

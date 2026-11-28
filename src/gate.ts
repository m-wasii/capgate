import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  cloudAuthorize,
  cloudCreateApproval,
  cloudDecide,
  cloudGetApproval,
  cloudRelease,
  cloudSettle,
  sleep,
} from "./client.js";
import { loadPolicy, localCharge, localCommit } from "./local.js";

const here = dirname(fileURLToPath(import.meta.url));

if (process.env.CAPGATE_LOCAL_APPROVE === "1") {
  const scope = process.env.CAPGATE_API_URL
    ? "ignored while CAPGATE_API_URL is set — cloud approvals still apply"
    : "local YAML only: needs_approval tools run with no human approval";
  console.error(
    `[capgate] WARNING: CAPGATE_LOCAL_APPROVE=1 is active (${scope}). Never set this on managed or production MCP deployments.`,
  );
}

function gatePaths() {
  return {
    apiUrl: process.env.CAPGATE_API_URL?.replace(/\/$/, ""),
    apiKey: process.env.CAPGATE_API_KEY ?? "dev-key",
    policyPath: process.env.CAPGATE_POLICY ?? join(here, "..", "policy.example.yaml"),
    meterPath: process.env.CAPGATE_METER ?? join(here, "..", ".capgate", "meter.json"),
    approvalTimeoutMs: Number(process.env.CAPGATE_APPROVAL_TIMEOUT_MS ?? 120_000),
  };
}

async function runAfterAuthorize<T>(
  apiUrl: string,
  apiKey: string,
  toolName: string,
  approvalId: string | undefined,
  run: () => T | Promise<T>,
): Promise<T> {
  const auth = await cloudAuthorize(apiUrl, apiKey, toolName, approvalId);
  let out: T;
  try {
    out = await run();
  } catch (e) {
    try {
      await cloudRelease(apiUrl, apiKey, auth.authorizationId);
    } catch {
      // Best-effort refund; surface the tool failure.
    }
    throw e;
  }
  // Settle only after the handler resolved. Kept outside the handler's catch so a
  // settle failure propagates with the spend still charged — the tool already ran.
  await cloudSettle(apiUrl, apiKey, auth.authorizationId);
  return out;
}

/** Decide + authorize, run, then settle (or release on throw). Unregistered names fail with unknown_tool. */
export async function gatedRun<T>(
  toolName: string,
  args: unknown,
  run: () => T | Promise<T>,
): Promise<T> {
  const { apiUrl, apiKey, policyPath, meterPath, approvalTimeoutMs } = gatePaths();

  if (apiUrl) {
    const decision = await cloudDecide(apiUrl, apiKey, toolName);
    if (decision.allow) {
      return runAfterAuthorize(apiUrl, apiKey, toolName, undefined, run);
    }
    if (decision.reason === "needs_approval") {
      const approval = await cloudCreateApproval(apiUrl, apiKey, toolName, args);
      const deadline = Date.now() + approvalTimeoutMs;
      while (Date.now() < deadline) {
        const cur = await cloudGetApproval(apiUrl, apiKey, approval.id);
        if (cur.status === "approved") {
          return runAfterAuthorize(apiUrl, apiKey, toolName, approval.id, run);
        }
        if (cur.status === "denied") throw new Error(`capgate denied approval ${approval.id}`);
        await sleep(1500);
      }
      throw new Error(`capgate approval timed out (${approval.id})`);
    }
    throw new Error(`capgate blocked: ${decision.reason}`);
  }

  const policy = loadPolicy(policyPath);
  const { decision } = localCharge(policy, meterPath, toolName);
  if (!decision.allow) {
    if (decision.reason === "needs_approval" && process.env.CAPGATE_LOCAL_APPROVE === "1") {
      // localCharge writes nothing for needs_approval; localCommit charges it under the lock.
      localCommit(policy, meterPath, toolName);
      return run();
    }
    throw new Error(`capgate blocked: ${decision.reason}`);
  }
  // Already charged inside the lock above, so a call that lost the cap race never ran the tool.
  return run();
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
  run: (args: Record<string, unknown>) => string | Promise<string>,
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

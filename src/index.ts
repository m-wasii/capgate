#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  cloudCommit,
  cloudCreateApproval,
  cloudDecide,
  cloudGetApproval,
  cloudStatus,
  sleep,
} from "./client.js";
import { loadMeter, loadPolicy, localCommit, localDecide } from "./local.js";

const apiUrl = process.env.CAPGATE_API_URL?.replace(/\/$/, "");
const apiKey = process.env.CAPGATE_API_KEY ?? "dev-key";
const here = dirname(fileURLToPath(import.meta.url));
const policyPath = process.env.CAPGATE_POLICY ?? join(here, "..", "policy.example.yaml");
const meterPath = process.env.CAPGATE_METER ?? join(here, "..", ".capgate", "meter.json");
const approvalTimeoutMs = Number(process.env.CAPGATE_APPROVAL_TIMEOUT_MS ?? 120_000);

const server = new McpServer({ name: "capgate", version: "0.1.0" });

async function gatedRun(toolName: string, args: unknown, run: () => string): Promise<string> {
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

server.tool("capgate_status", "Show Capgate kill switch, daily cap, and spend so far.", {}, async () => {
  if (apiUrl) {
    const status = await cloudStatus(apiUrl, apiKey);
    return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
  }
  const policy = loadPolicy(policyPath);
  const meter = loadMeter(meterPath);
  return { content: [{ type: "text", text: JSON.stringify({ policy, meter }, null, 2) }] };
});

server.tool(
  "capgate_demo_search",
  "Low-risk demo tool. Auto-allows under the daily spend cap.",
  { query: z.string() },
  async ({ query }) => {
    try {
      const text = await gatedRun("capgate_demo_search", { query }, () =>
        JSON.stringify({ ok: true, results: [`fake hit for: ${query}`] }),
      );
      return { content: [{ type: "text", text }] };
    } catch (e) {
      return {
        content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
        isError: true,
      };
    }
  },
);

server.tool(
  "capgate_demo_refund",
  "High-risk demo tool (spend). Requires cloud approval, or CAPGATE_LOCAL_APPROVE=1 locally.",
  { orderId: z.string(), amountUsd: z.number() },
  async ({ orderId, amountUsd }) => {
    try {
      const text = await gatedRun("capgate_demo_refund", { orderId, amountUsd }, () =>
        JSON.stringify({ ok: true, refunded: { orderId, amountUsd } }),
      );
      return { content: [{ type: "text", text }] };
    } catch (e) {
      return {
        content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("capgate mcp on stdio");

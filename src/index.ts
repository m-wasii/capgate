#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { cloudStatus } from "./client.js";
import { registerGatedTool } from "./gate.js";
import { loadMeter, loadPolicy } from "./local.js";

const apiUrl = process.env.CAPGATE_API_URL?.replace(/\/$/, "");
const apiKey = process.env.CAPGATE_API_KEY ?? "dev-key";
const here = dirname(fileURLToPath(import.meta.url));
const policyPath = process.env.CAPGATE_POLICY ?? join(here, "..", "policy.example.yaml");
const meterPath = process.env.CAPGATE_METER ?? join(here, "..", ".capgate", "meter.json");

const server = new McpServer({ name: "capgate", version: "0.1.0" });

server.tool("capgate_status", "Show Capgate kill switch, daily cap, and spend so far.", {}, async () => {
  if (apiUrl) {
    const status = await cloudStatus(apiUrl, apiKey);
    return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
  }
  const policy = loadPolicy(policyPath);
  const meter = loadMeter(meterPath);
  return { content: [{ type: "text", text: JSON.stringify({ policy, meter }, null, 2) }] };
});

registerGatedTool(
  server,
  "capgate_demo_search",
  "Low-risk demo tool. Auto-allows under the daily spend cap.",
  { query: z.string() },
  ({ query }) => JSON.stringify({ ok: true, results: [`fake hit for: ${query}`] }),
);

registerGatedTool(
  server,
  "capgate_demo_refund",
  "High-risk demo tool (spend). Requires cloud approval, or CAPGATE_LOCAL_APPROVE=1 locally.",
  { orderId: z.string(), amountUsd: z.number() },
  ({ orderId, amountUsd }) => JSON.stringify({ ok: true, refunded: { orderId, amountUsd } }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("capgate mcp on stdio");

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { decide } from "../dist/policy.js";
import { loadPolicy, localCommit, localDecide, loadMeter } from "../dist/local.js";
import { gatedRun, registerGatedTool } from "../dist/gate.js";

const root = join(fileURLToPath(new URL("..", import.meta.url)));
const policy = loadPolicy(join(root, "policy.example.yaml"));
const dir = mkdtempSync(join(tmpdir(), "capgate-"));
const meterPath = join(dir, "meter.json");

process.env.CAPGATE_POLICY = join(root, "policy.example.yaml");
process.env.CAPGATE_METER = meterPath;
delete process.env.CAPGATE_API_URL;

try {
  const search = localDecide(policy, meterPath, "capgate_demo_search");
  assert.equal(search.decision.allow, true);

  localCommit(policy, meterPath, "capgate_demo_search");
  assert.equal(loadMeter(meterPath).spentUsd, 0.01);

  const refund = decide(policy, loadMeter(meterPath), "capgate_demo_refund");
  assert.deepEqual(refund, { allow: false, reason: "needs_approval" });

  const killed = decide({ ...policy, killed: true }, loadMeter(meterPath), "capgate_demo_search");
  assert.deepEqual(killed, { allow: false, reason: "killed" });

  assert.deepEqual(decide(policy, loadMeter(meterPath), "not_registered"), {
    allow: false,
    reason: "unknown_tool",
  });

  const server = new McpServer({ name: "capgate-self-check", version: "0.0.0" });
  const registered = registerGatedTool(
    server,
    "capgate_demo_search",
    "self-check gated tool",
    { query: z.string() },
    ({ query }) => JSON.stringify({ ok: true, query }),
  );
  assert.equal(typeof registered.handler, "function");

  await assert.rejects(
    () => gatedRun("not_registered", {}, () => "should-not-run"),
    (err) => err instanceof Error && err.message.includes("unknown_tool"),
  );

  const allowed = await gatedRun("capgate_demo_search", { query: "hi" }, () =>
    JSON.stringify({ ok: true }),
  );
  assert.equal(allowed, JSON.stringify({ ok: true }));
  assert.equal(loadMeter(meterPath).spentUsd, 0.02);

  console.log("capgate self-check ok");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

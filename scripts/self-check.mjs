import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decide } from "../dist/policy.js";
import { loadPolicy, localCommit, localDecide, loadMeter } from "../dist/local.js";

const root = join(fileURLToPath(new URL("..", import.meta.url)));
const policy = loadPolicy(join(root, "policy.example.yaml"));
const dir = mkdtempSync(join(tmpdir(), "capgate-"));
const meterPath = join(dir, "meter.json");

try {
  const search = localDecide(policy, meterPath, "capgate_demo_search");
  assert.equal(search.decision.allow, true);

  localCommit(policy, meterPath, "capgate_demo_search");
  assert.equal(loadMeter(meterPath).spentUsd, 0.01);

  const refund = decide(policy, loadMeter(meterPath), "capgate_demo_refund");
  assert.deepEqual(refund, { allow: false, reason: "needs_approval" });

  const killed = decide({ ...policy, killed: true }, loadMeter(meterPath), "capgate_demo_search");
  assert.deepEqual(killed, { allow: false, reason: "killed" });

  console.log("capgate self-check ok");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

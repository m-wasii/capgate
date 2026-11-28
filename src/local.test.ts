import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { utcDay } from "./policy.js";
import {
  loadMeter,
  localCharge,
  localCommit,
  localDecide,
  MeterCorruptError,
  MeterLockError,
  saveMeter,
  withMeterLock,
} from "./local.js";
import type { Policy } from "./policy.js";

const here = dirname(fileURLToPath(import.meta.url));
const localModuleUrl = pathToFileURL(join(here, "local.js")).href;

const policy: Policy = {
  dailySpendCapUsd: 0.05,
  killed: false,
  tools: {
    spend: { risk: "low", costUsd: 0.01 },
    refund: { risk: "spend", costUsd: 0.01 },
  },
};

function freshDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "capgate-local-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface WorkerResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runWorker(file: string, args: string[], env: Record<string, string> = {}): Promise<WorkerResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => child.on("close", () => resolve()));
}

test("parallel gated calls cannot exceed the daily cap", async (t) => {
  const dir = freshDir(t);
  const meterPath = join(dir, "meter.json");
  const workerPath = join(dir, "cap-worker.mjs");
  writeFileSync(
    workerPath,
    `import { localCommit, localDecide } from ${JSON.stringify(localModuleUrl)};
const [meterPath, startAt] = process.argv.slice(2);
const policy = {
  dailySpendCapUsd: 0.05,
  killed: false,
  tools: { spend: { risk: "low", costUsd: 0.01 } },
};
// Line every worker up so all of them read the meter before any of them charges it.
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, Number(startAt) - Date.now()));
const { decision } = localDecide(policy, meterPath, "spend");
if (!decision.allow) {
  console.log("blocked:" + decision.reason);
  process.exit(0);
}
try {
  localCommit(policy, meterPath, "spend");
  console.log("charged");
} catch (error) {
  console.log("commit_blocked:" + (error instanceof Error ? error.message : String(error)));
}
`,
  );

  const workers = 20;
  const startAt = Date.now() + 1_000;
  const results = await Promise.all(
    Array.from({ length: workers }, () => runWorker(workerPath, [meterPath, String(startAt)])),
  );

  for (const result of results) {
    assert.equal(result.code, 0, `worker failed: ${result.stderr}`);
    assert.equal(result.stderr, "", "worker should not log to stderr");
  }

  const charged = results.filter((r) => r.stdout === "charged");
  const blocked = results.filter((r) => r.stdout !== "charged");
  assert.equal(charged.length, 5, `expected 5 charges at $0.01 under a $0.05 cap, got ${charged.length}`);
  assert.equal(blocked.length, workers - 5);
  for (const result of blocked) {
    assert.match(result.stdout, /^(blocked:cap|commit_blocked:capgate blocked: cap)$/);
  }

  const meter = loadMeter(meterPath);
  assert.equal(meter.day, utcDay());
  assert.ok(meter.spentUsd <= policy.dailySpendCapUsd + 1e-9, `overspent: ${meter.spentUsd}`);
  assert.equal(meter.spentUsd, 0.05);

  const leftovers = readdirSync(dir).filter((name) => name.startsWith("meter.json."));
  assert.deepEqual(leftovers, [], "lock and temp files must be cleaned up");
});

test("a hard kill mid-write leaves the meter as valid JSON", async (t) => {
  const dir = freshDir(t);
  const meterPath = join(dir, "meter.json");
  saveMeter(meterPath, { day: "2099-01-01", spentUsd: 0 });

  const writerPath = join(dir, "write-worker.mjs");
  writeFileSync(
    writerPath,
    `import { saveMeter } from ${JSON.stringify(localModuleUrl)};
const meterPath = process.argv[2];
// A large payload widens the window in which a non-atomic writer would be torn in half.
const pad = "x".repeat(2 * 1024 * 1024);
for (let i = 0; ; i += 1) saveMeter(meterPath, { day: "2099-01-01", spentUsd: i / 1000, pad });
`,
  );

  for (let round = 0; round < 3; round += 1) {
    const child = spawn(process.execPath, [writerPath, meterPath], { stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 150 + round * 50));
    child.kill("SIGKILL");
    await waitForExit(child);

    const raw = readFileSync(meterPath, "utf8");
    const parsed = JSON.parse(raw) as { day?: unknown; spentUsd?: unknown };
    assert.equal(parsed.day, "2099-01-01");
    assert.equal(typeof parsed.spentUsd, "number");
    // The typed loader (which the gate uses) must accept it, not throw MeterCorruptError.
    assert.equal(loadMeter(meterPath).day, "2099-01-01");
  }
});

test("corrupt meter fails closed with an actionable error and is never reset", (t) => {
  const dir = freshDir(t);
  const meterPath = join(dir, "meter.json");

  const corruptions = [
    "",
    '{"day": "2099-01-0',
    "null",
    "[]",
    "not json at all",
    '{"day": 5, "spentUsd": 0}',
    '{"day": "2099-01-01", "spentUsd": -1}',
    '{"day": "2099-01-01", "spentUsd": "0.5"}',
    '{"day": "2099-01-01", "spentUsd": null}',
  ];

  for (const raw of corruptions) {
    writeFileSync(meterPath, raw);
    const isCorrupt = (e: unknown) =>
      e instanceof MeterCorruptError &&
      e.code === "METER_CORRUPT" &&
      e.message.includes(meterPath) &&
      e.message.includes("delete");

    assert.throws(() => loadMeter(meterPath), isCorrupt, `loadMeter accepted: ${raw}`);
    assert.throws(() => localDecide(policy, meterPath, "spend"), isCorrupt, `localDecide accepted: ${raw}`);
    assert.throws(() => localCharge(policy, meterPath, "spend"), isCorrupt, `localCharge accepted: ${raw}`);
    assert.equal(readFileSync(meterPath, "utf8"), raw, "a corrupt meter must not be silently rewritten");
  }
});

test("commit re-checks the cap inside the lock instead of trusting a stale decision", (t) => {
  const dir = freshDir(t);
  const meterPath = join(dir, "meter.json");
  saveMeter(meterPath, { day: utcDay(), spentUsd: 0.04 });

  // This is the TOCTOU window: the decision looks at $0.04 and allows the $0.01 charge...
  assert.equal(localDecide(policy, meterPath, "spend").decision.allow, true);
  // ...but the charge takes the last cent of headroom.
  localCommit(policy, meterPath, "spend");
  assert.equal(loadMeter(meterPath).spentUsd, 0.05);

  assert.equal(localDecide(policy, meterPath, "spend").decision.allow, false);
  assert.throws(() => localCommit(policy, meterPath, "spend"), /capgate blocked: cap/);
  assert.equal(loadMeter(meterPath).spentUsd, 0.05);
});

test("stale lock is taken over; a live lock times out with a recovery hint", (t) => {
  const dir = freshDir(t);
  const meterPath = join(dir, "meter.json");
  const lockPath = `${meterPath}.lock`;

  writeFileSync(lockPath, JSON.stringify({ pid: 999_999, at: "1999-01-01T00:00:00.000Z" }));
  const longAgo = new Date(Date.now() - 60_000);
  utimesSync(lockPath, longAgo, longAgo);

  const startedAt = Date.now();
  const result = withMeterLock(meterPath, () => "ran", { staleMs: 30_000, timeoutMs: 2_000 });
  assert.equal(result, "ran");
  assert.ok(Date.now() - startedAt < 2_000, "stale takeover must not wait for the timeout");
  assert.equal(existsSync(lockPath), false, "the stolen lock is released");

  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  const isLockTimeout = (e: unknown) =>
    e instanceof MeterLockError && e.code === "METER_LOCKED" && e.message.includes(lockPath) && e.message.includes("delete");
  assert.throws(
    () => withMeterLock(meterPath, () => "nope", { timeoutMs: 150, staleMs: 30_000, retryMs: 10 }),
    isLockTimeout,
  );
  assert.equal(existsSync(lockPath), true, "a live lock is left for its owner to release");

  rmSync(lockPath, { force: true });
  assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith("meter.json.")), []);
});

test("localCommit still charges externally-approved tools and enforces kill/unknown", (t) => {
  const dir = freshDir(t);
  const meterPath = join(dir, "meter.json");

  // gate.ts decides first and calls localCommit after approval (CAPGATE_LOCAL_APPROVE=1), so
  // needs_approval must charge here instead of failing the re-check.
  assert.equal(localCommit(policy, meterPath, "refund").spentUsd, 0.01);

  assert.throws(() => localCommit({ ...policy, killed: true }, meterPath, "spend"), /capgate blocked: killed/);
  assert.throws(() => localCommit(policy, meterPath, "not_registered"), /unknown tool not_registered/);
  assert.equal(loadMeter(meterPath).spentUsd, 0.01, "rejected commits leave the meter untouched");
});

test("localCharge decides, charges, and rolls the day atomically", (t) => {
  const dir = freshDir(t);
  const meterPath = join(dir, "meter.json");
  saveMeter(meterPath, { day: utcDay(new Date(Date.now() - 86_400_000)), spentUsd: 0.05 });

  const charged = localCharge(policy, meterPath, "spend");
  assert.deepEqual(charged.decision, { allow: true, costUsd: 0.01 });
  assert.equal(charged.meter.spentUsd, 0.01, "a new UTC day resets the meter");
  assert.equal(loadMeter(meterPath).spentUsd, 0.01);

  const needsApproval = localCharge(policy, meterPath, "refund");
  assert.deepEqual(needsApproval.decision, { allow: false, reason: "needs_approval" });
  assert.equal(loadMeter(meterPath).spentUsd, 0.01, "a blocked decision writes nothing");

  const killed = localCharge({ ...policy, killed: true }, meterPath, "spend");
  assert.deepEqual(killed.decision, { allow: false, reason: "killed" });
  assert.equal(loadMeter(meterPath).spentUsd, 0.01);
});

test("saveMeter replaces atomically and leaves no temp files", (t) => {
  const dir = freshDir(t);
  const meterPath = join(dir, "nested", "meter.json");

  saveMeter(meterPath, { day: "2099-01-01", spentUsd: 0.02 });
  assert.deepEqual(loadMeter(meterPath), { day: "2099-01-01", spentUsd: 0.02 });

  saveMeter(meterPath, { day: "2099-01-01", spentUsd: 0.03 });
  assert.deepEqual(loadMeter(meterPath), { day: "2099-01-01", spentUsd: 0.03 });

  const leftovers = readdirSync(join(dir, "nested")).filter((name) => name.includes(".tmp-"));
  assert.deepEqual(leftovers, []);
});

test("src/local.ts never writes the meter in place", () => {
  const source = readFileSync(join(here, "..", "src", "local.ts"), "utf8");
  assert.equal(/writeFileSync\s*\(/.test(source), false, "the meter must only be replaced by rename");
});

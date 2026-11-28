import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { gatedRun, registerGatedTool } from "./gate.js";
import { loadMeter, saveMeter } from "./local.js";
import { utcDay } from "./policy.js";

const COST_USD = 0.01;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface MockCloud {
  baseUrl: string;
  spentUsd: number;
  settleCalls: number;
  releaseCalls: number;
  /** Ordered record of control-plane calls and handler markers, for ordering tests. */
  events: string[];
  close: () => Promise<void>;
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      try {
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

/** Minimal control plane. `settleStatus` lets a test make settle fail on demand. */
function startMockCloud(settleStatus = 200): Promise<MockCloud> {
  const state: MockCloud = {
    baseUrl: "",
    spentUsd: 0,
    settleCalls: 0,
    releaseCalls: 0,
    events: [],
    close: async () => {},
  };
  const auths = new Map<string, "pending" | "settled" | "released">();
  let nextId = 1;

  const server = createServer(async (req, res: ServerResponse) => {
    const url = req.url ?? "";
    const body = await readJsonBody(req);
    res.setHeader("content-type", "application/json");

    if (url === "/api/v1/decide" && req.method === "POST") {
      res.writeHead(200);
      res.end(JSON.stringify({ allow: true, costUsd: COST_USD }));
      return;
    }
    if (url === "/api/v1/authorize" && req.method === "POST") {
      const id = `auth-${nextId++}`;
      state.spentUsd = Math.round((state.spentUsd + COST_USD) * 1e6) / 1e6;
      state.events.push("authorize");
      auths.set(id, "pending");
      res.writeHead(200);
      res.end(
        JSON.stringify({
          authorizationId: id,
          policy: { dailySpendCapUsd: 5, killed: false, tools: {} },
          meter: { day: "2099-01-01", spentUsd: state.spentUsd },
        }),
      );
      return;
    }
    if (url === "/api/v1/settle" && req.method === "POST") {
      state.settleCalls += 1;
      state.events.push("settle");
      if (settleStatus !== 200) {
        res.writeHead(settleStatus);
        res.end(JSON.stringify({ error: "settle_failed" }));
        return;
      }
      const record = auths.get(body.authorizationId as string);
      if (record !== "pending") {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "already_consumed" }));
        return;
      }
      auths.set(body.authorizationId as string, "settled");
      res.writeHead(200);
      res.end(
        JSON.stringify({
          policy: { dailySpendCapUsd: 5, killed: false, tools: {} },
          meter: { day: "2099-01-01", spentUsd: state.spentUsd },
        }),
      );
      return;
    }
    if (url === "/api/v1/release" && req.method === "POST") {
      state.releaseCalls += 1;
      state.events.push("release");
      const record = auths.get(body.authorizationId as string);
      if (record !== "pending") {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "already_consumed" }));
        return;
      }
      auths.set(body.authorizationId as string, "released");
      state.spentUsd = Math.max(0, Math.round((state.spentUsd - COST_USD) * 1e6) / 1e6);
      res.writeHead(200);
      res.end(
        JSON.stringify({
          policy: { dailySpendCapUsd: 5, killed: false, tools: {} },
          meter: { day: "2099-01-01", spentUsd: state.spentUsd },
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: "not_found" }));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      assert.ok(addr && typeof addr === "object");
      state.baseUrl = `http://127.0.0.1:${addr.port}`;
      state.close = () =>
        new Promise((done, err) => {
          server.close((e) => (e ? err(e) : done()));
        });
      resolve(state);
    });
  });
}

async function withCloud<T>(settleStatus: number, fn: (cloud: MockCloud) => Promise<T>): Promise<T> {
  const cloud = await startMockCloud(settleStatus);
  const prevUrl = process.env.CAPGATE_API_URL;
  const prevKey = process.env.CAPGATE_API_KEY;
  process.env.CAPGATE_API_URL = cloud.baseUrl;
  process.env.CAPGATE_API_KEY = "test";
  try {
    return await fn(cloud);
  } finally {
    if (prevUrl === undefined) delete process.env.CAPGATE_API_URL;
    else process.env.CAPGATE_API_URL = prevUrl;
    if (prevKey === undefined) delete process.env.CAPGATE_API_KEY;
    else process.env.CAPGATE_API_KEY = prevKey;
    await cloud.close();
  }
}

test("settle failure after a successful handler keeps the charge and never releases", async () => {
  await withCloud(500, async (cloud) => {
    let handlerRan = false;

    await assert.rejects(
      () =>
        gatedRun("capgate_demo_search", {}, () => {
          handlerRan = true;
          return "tool ran";
        }),
      (e) => e instanceof Error && e.message === "settle 500",
    );

    assert.equal(handlerRan, true);
    assert.equal(cloud.settleCalls, 1);
    assert.equal(cloud.releaseCalls, 0, "a failed settle must not refund a tool that already ran");
    assert.equal(cloud.spentUsd, COST_USD, "the spend must remain charged");
  });
});

test("async handler that resolves is awaited: settle once, never release", async () => {
  await withCloud(200, async (cloud) => {
    const result = await gatedRun("capgate_demo_search", {}, async () => {
      await delay(10);
      return "async result";
    });

    assert.equal(result, "async result");
    assert.equal(cloud.settleCalls, 1);
    assert.equal(cloud.releaseCalls, 0);
    assert.equal(cloud.spentUsd, COST_USD);
  });
});

test("async handler that rejects releases once, never settles, and rethrows", async () => {
  await withCloud(200, async (cloud) => {
    await assert.rejects(
      () =>
        gatedRun("capgate_demo_search", {}, async () => {
          await delay(10);
          throw new Error("async tool failed");
        }),
      (e) => e instanceof Error && e.message === "async tool failed",
    );

    assert.equal(cloud.releaseCalls, 1);
    assert.equal(cloud.settleCalls, 0);
    assert.equal(cloud.spentUsd, 0);
  });
});

test("settle is observed only after the async handler resolves", async () => {
  await withCloud(200, async (cloud) => {
    await gatedRun("capgate_demo_search", {}, async () => {
      cloud.events.push("handler:start");
      await delay(20);
      cloud.events.push("handler:resolved");
      return "done";
    });

    const resolvedAt = cloud.events.indexOf("handler:resolved");
    const settledAt = cloud.events.indexOf("settle");
    assert.ok(resolvedAt >= 0, `handler marker missing: ${cloud.events.join(" -> ")}`);
    assert.ok(settledAt >= 0, `settle marker missing: ${cloud.events.join(" -> ")}`);
    assert.ok(
      resolvedAt < settledAt,
      `settle fired before the handler resolved: ${cloud.events.join(" -> ")}`,
    );
  });
});

test("registerGatedTool accepts an async handler with no cast", () => {
  const server = new McpServer({ name: "capgate-test", version: "0.0.0" });
  registerGatedTool(
    server,
    "capgate_async_demo",
    "Async handler compile check.",
    { query: z.string() },
    async ({ query }) => {
      await delay(1);
      return JSON.stringify({ ok: true, query });
    },
  );
});

const LOCAL_POLICY = `dailySpendCapUsd: 0.05
killed: false
tools:
  spend:
    risk: low
    costUsd: 0.01
  refund:
    risk: spend
    costUsd: 0.01
`;

interface LocalEnv {
  dir: string;
  meterPath: string;
}

async function withLocalMode<T>(fn: (env: LocalEnv) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "capgate-gate-local-"));
  const meterPath = join(dir, "meter.json");
  writeFileSync(join(dir, "policy.yaml"), LOCAL_POLICY);
  const saved = {
    url: process.env.CAPGATE_API_URL,
    policy: process.env.CAPGATE_POLICY,
    meter: process.env.CAPGATE_METER,
    approve: process.env.CAPGATE_LOCAL_APPROVE,
  };
  delete process.env.CAPGATE_API_URL;
  process.env.CAPGATE_POLICY = join(dir, "policy.yaml");
  process.env.CAPGATE_METER = meterPath;
  delete process.env.CAPGATE_LOCAL_APPROVE;
  try {
    return await fn({ dir, meterPath });
  } finally {
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore("CAPGATE_API_URL", saved.url);
    restore("CAPGATE_POLICY", saved.policy);
    restore("CAPGATE_METER", saved.meter);
    restore("CAPGATE_LOCAL_APPROVE", saved.approve);
    rmSync(dir, { recursive: true, force: true });
  }
}

test("local mode charges before the handler runs", async () => {
  await withLocalMode(async ({ meterPath }) => {
    saveMeter(meterPath, { day: utcDay(), spentUsd: 0 });

    let spentWhenHandlerRan = -1;
    const result = await gatedRun("spend", {}, () => {
      spentWhenHandlerRan = loadMeter(meterPath).spentUsd;
      return "ran";
    });

    assert.equal(result, "ran");
    assert.equal(
      spentWhenHandlerRan,
      0.01,
      "the meter must already be charged when the handler executes",
    );
  });
});

test("a local tool that loses the cap race never executes", async () => {
  await withLocalMode(async ({ meterPath }) => {
    // Headroom for exactly one $0.01 call.
    saveMeter(meterPath, { day: utcDay(), spentUsd: 0.04 });

    let handlerRuns = 0;
    // Barrier: the first handler waits for a second one, up to a bound. With charge-before-run
    // the second call can never reach its handler, so the wait times out and exactly one runs.
    const handler = async () => {
      handlerRuns += 1;
      const deadline = Date.now() + 200;
      while (handlerRuns < 2 && Date.now() < deadline) await delay(5);
      return "ran";
    };

    const outcomes = await Promise.allSettled([
      gatedRun("spend", {}, handler),
      gatedRun("spend", {}, handler),
    ]);

    assert.equal(handlerRuns, 1, "a call that loses the cap race must be blocked before running");
    const rejected = outcomes.filter((o) => o.status === "rejected");
    assert.equal(rejected.length, 1, `outcomes: ${JSON.stringify(outcomes)}`);
    const reason = rejected[0].status === "rejected" ? rejected[0].reason : undefined;
    assert.match(
      reason instanceof Error ? reason.message : String(reason),
      /capgate blocked: cap/,
    );
    assert.equal(loadMeter(meterPath).spentUsd, 0.05);
  });
});

test("local allowed path charges exactly once", async () => {
  await withLocalMode(async ({ meterPath }) => {
    saveMeter(meterPath, { day: utcDay(), spentUsd: 0 });

    await gatedRun("spend", {}, async () => "one");

    assert.equal(
      loadMeter(meterPath).spentUsd,
      0.01,
      "a single allowed call must charge one tool cost, not two",
    );
  });
});

test("local needs_approval with CAPGATE_LOCAL_APPROVE=1 charges before running", async () => {
  await withLocalMode(async ({ meterPath }) => {
    saveMeter(meterPath, { day: utcDay(), spentUsd: 0 });
    process.env.CAPGATE_LOCAL_APPROVE = "1";

    let spentWhenHandlerRan = -1;
    const result = await gatedRun("refund", {}, async () => {
      spentWhenHandlerRan = loadMeter(meterPath).spentUsd;
      return "approved locally";
    });

    assert.equal(result, "approved locally");
    assert.equal(spentWhenHandlerRan, 0.01, "an approved local tool must charge before running");
    assert.equal(loadMeter(meterPath).spentUsd, 0.01);
  });
});

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test } from "node:test";
import { gatedRun } from "./gate.js";
import { computeCost, decide, hashArgs, type Policy, type ToolPolicy } from "./policy.js";

const NOW = new Date("2099-01-01T12:00:00Z");

/** 2% of the refund, floored at a cent and clamped at $500 per call. */
const refund: ToolPolicy = {
  risk: "spend",
  costUsd: 0.01,
  cost: { kind: "percent", arg: "amountUsd", pct: 0.02, floorUsd: 0.01, maxUsd: 500 },
};

function policyWith(tools: Record<string, ToolPolicy>, dailySpendCapUsd = 5): Policy {
  return { dailySpendCapUsd, killed: false, tools };
}

const freshMeter = { day: "2099-01-01", spentUsd: 0 };

test("a percentage cost spec prices the call from its arguments", () => {
  const small = computeCost(refund, { amountUsd: 5 });
  const large = computeCost(refund, { amountUsd: 50_000 });

  assert.equal(small, 0.1, "2% of a $5 refund is $0.10");
  assert.equal(large, 500, "2% of $50,000 is clamped at maxUsd $500");
  assert.ok(large / small > 1_000, `expected a >1000x ratio, got ${large / small}x`);

  assert.equal(computeCost(refund, { amountUsd: 0.01 }), 0.01, "floorUsd is the minimum charge");

  const policy = policyWith({ refund });
  assert.deepEqual(decide(policy, freshMeter, "refund", NOW, { amountUsd: 5 }), {
    allow: false,
    reason: "needs_approval",
  });
  assert.deepEqual(decide(policy, freshMeter, "refund", NOW, { amountUsd: 50_000 }), {
    allow: false,
    reason: "cap",
  });
});

test("a plain costUsd policy entry charges exactly as before", () => {
  const search: ToolPolicy = { risk: "low", costUsd: 0.02 };

  assert.equal(computeCost(search, {}), 0.02);
  assert.equal(computeCost(search, { anything: "ignored" }), 0.02);
  assert.deepEqual(decide(policyWith({ search }), freshMeter, "search", NOW), {
    allow: true,
    costUsd: 0.02,
  });

  const fixed: ToolPolicy = { risk: "low", costUsd: 0.02, cost: { kind: "fixed", usd: 0.02 } };
  assert.equal(computeCost(fixed, {}), 0.02);
});

test("hashArgs is independent of key insertion order, including nested objects", () => {
  const first = hashArgs({ a: 1, b: 2, nested: { y: [{ q: "x", p: true }], x: null } });
  const reordered = hashArgs({ nested: { x: null, y: [{ p: true, q: "x" }] }, b: 2, a: 1 });

  assert.equal(first, reordered);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(hashArgs({ a: 1 }), hashArgs({ a: 1 }));
});

test("hashArgs distinguishes different argument values", () => {
  assert.notEqual(hashArgs({ amountUsd: 5 }), hashArgs({ amountUsd: 50_000 }));
  assert.notEqual(hashArgs({ amountUsd: 5 }), hashArgs({ amountUsd: "5" }));
});

test("a cost spec with a missing or non-numeric argument fails closed", () => {
  const policy = policyWith({ refund });

  assert.throws(() => computeCost(refund, {}), /amountUsd/);
  assert.throws(() => computeCost(refund, { amountUsd: "lots" }), /amountUsd/);
  assert.throws(() => computeCost(refund, { amountUsd: Number.NaN }), /amountUsd/);

  const invalid: Record<string, unknown>[] = [
    {},
    { amountUsd: "lots" },
    { amountUsd: Number.NaN },
    { amountUsd: Number.POSITIVE_INFINITY },
    { amountUsd: -5 },
    { amountUsd: 1e15 },
    { amountUsd: "1e999999" },
  ];
  for (const args of invalid) {
    assert.deepEqual(
      decide(policy, freshMeter, "refund", NOW, args),
      { allow: false, reason: "invalid_cost" },
      `args ${JSON.stringify(args)} must fail closed`,
    );
  }

  // A prototype-inherited argument is not a supplied argument.
  const inherited = Object.create({ amountUsd: 50_000 }) as Record<string, unknown>;
  assert.deepEqual(decide(policy, freshMeter, "refund", NOW, inherited), {
    allow: false,
    reason: "invalid_cost",
  });
});

test("the daily cap is enforced against the derived cost", () => {
  const ad: ToolPolicy = {
    risk: "low",
    costUsd: 0.01,
    cost: { kind: "percent", arg: "amountUsd", pct: 0.02, floorUsd: 0.01, maxUsd: 500 },
  };
  const policy = policyWith({ ad });

  // $250 of spend = $5 of cost, exactly the cap.
  assert.deepEqual(decide(policy, freshMeter, "ad", NOW, { amountUsd: 250 }), {
    allow: true,
    costUsd: 5,
  });
  // One cent already spent pushes the same $5 of cost over the cap.
  assert.deepEqual(decide(policy, { day: "2099-01-01", spentUsd: 0.02 }, "ad", NOW, { amountUsd: 250 }), {
    allow: false,
    reason: "cap",
  });
  // A small call is still priced proportionally, not at the flat costUsd.
  assert.deepEqual(decide(policy, freshMeter, "ad", NOW, { amountUsd: 5 }), { allow: true, costUsd: 0.1 });
});

interface Bodies {
  decide: Record<string, unknown>[];
  authorize: Record<string, unknown>[];
  approvals: Record<string, unknown>[];
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
    });
    req.on("error", reject);
  });
}

function startMockCloud(): Promise<{ baseUrl: string; bodies: Bodies; close: () => Promise<void> }> {
  const bodies: Bodies = { decide: [], authorize: [], approvals: [] };
  const status = () =>
    JSON.stringify({
      policy: { dailySpendCapUsd: 5, killed: false, tools: {} },
      meter: { day: "2099-01-01", spentUsd: 0.1 },
    });

  const server = createServer(async (req, res: ServerResponse) => {
    const url = req.url ?? "";
    const body = await readJsonBody(req);
    res.setHeader("content-type", "application/json");

    if (url === "/api/v1/decide" && req.method === "POST") {
      bodies.decide.push(body);
      const decision =
        body.toolName === "capgate_demo_refund"
          ? { allow: false, reason: "needs_approval" }
          : { allow: true, costUsd: 0.01 };
      res.writeHead(200);
      res.end(JSON.stringify(decision));
      return;
    }
    if (url === "/api/v1/approvals" && req.method === "POST") {
      bodies.approvals.push(body);
      res.writeHead(200);
      res.end(JSON.stringify({ id: "appr-1", toolName: body.toolName, args: body.args, status: "pending" }));
      return;
    }
    if (url === "/api/v1/approvals/appr-1" && req.method === "GET") {
      res.writeHead(200);
      res.end(JSON.stringify({ id: "appr-1", toolName: "capgate_demo_refund", args: {}, status: "approved" }));
      return;
    }
    if (url === "/api/v1/authorize" && req.method === "POST") {
      bodies.authorize.push(body);
      res.writeHead(200);
      res.end(JSON.stringify({ authorizationId: "auth-1", ...JSON.parse(status()) }));
      return;
    }
    if (url === "/api/v1/settle" && req.method === "POST") {
      res.writeHead(200);
      res.end(status());
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: "not_found" }));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      assert.ok(addr && typeof addr === "object");
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        bodies,
        close: () =>
          new Promise((done, err) => {
            server.close((e) => (e ? err(e) : done()));
          }),
      });
    });
  });
}

async function withCloud<T>(fn: (baseUrl: string) => Promise<T>): Promise<{ result: T; bodies: Bodies }> {
  const mock = await startMockCloud();
  const saved = {
    url: process.env.CAPGATE_API_URL,
    key: process.env.CAPGATE_API_KEY,
    timeout: process.env.CAPGATE_APPROVAL_TIMEOUT_MS,
  };
  process.env.CAPGATE_API_URL = mock.baseUrl;
  process.env.CAPGATE_API_KEY = "test";
  process.env.CAPGATE_APPROVAL_TIMEOUT_MS = "3000";
  try {
    const result = await fn(mock.baseUrl);
    return { result, bodies: mock.bodies };
  } finally {
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore("CAPGATE_API_URL", saved.url);
    restore("CAPGATE_API_KEY", saved.key);
    restore("CAPGATE_APPROVAL_TIMEOUT_MS", saved.timeout);
    await mock.close();
  }
}

test("the gate sends args on decide and authorize", async () => {
  const args = { query: "hi" };
  const { bodies } = await withCloud(() => gatedRun("capgate_demo_search", args, () => "ok"));

  assert.deepEqual(bodies.decide[0]?.args, args, "decide must price the call from its args");
  assert.deepEqual(bodies.authorize[0]?.args, args, "authorize must bind the approval to the args");
});

test("an approved call redeems with the same args it was approved for", async () => {
  const args = { orderId: "o-1", amountUsd: 50_000 };
  const { bodies } = await withCloud(() => gatedRun("capgate_demo_refund", args, () => "refunded"));

  const approvedFor = bodies.approvals[0]?.args;
  const redeemedWith = bodies.authorize[0]?.args;

  assert.deepEqual(approvedFor, args);
  assert.deepEqual(redeemedWith, args);
  assert.equal(hashArgs(redeemedWith), hashArgs(approvedFor), "approval args hash must match redemption");
  assert.equal(bodies.authorize[0]?.approvalId, "appr-1");
});

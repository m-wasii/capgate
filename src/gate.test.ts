import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test } from "node:test";
import { cloudAuthorize, cloudSettle } from "./client.js";
import { gatedRun } from "./gate.js";

type AuthRecord = { status: "pending" | "settled" | "released" };

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      resolve(raw ? JSON.parse(raw) : {});
    });
    req.on("error", reject);
  });
}

function startMockCloud(spentUsd: { value: number }) {
  const auths = new Map<string, AuthRecord>();
  let nextId = 1;
  const costUsd = 0.01;

  const server = createServer(async (req, res: ServerResponse) => {
    const url = req.url ?? "";
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    res.setHeader("content-type", "application/json");

    if (url === "/api/v1/decide" && req.method === "POST") {
      res.writeHead(200);
      res.end(JSON.stringify({ allow: true, costUsd }));
      return;
    }
    if (url === "/api/v1/authorize" && req.method === "POST") {
      const id = `auth-${nextId++}`;
      spentUsd.value = Math.round((spentUsd.value + costUsd) * 1e6) / 1e6;
      auths.set(id, { status: "pending" });
      res.writeHead(200);
      res.end(
        JSON.stringify({
          authorizationId: id,
          policy: { dailySpendCapUsd: 5, killed: false, tools: {} },
          meter: { day: "2099-01-01", spentUsd: spentUsd.value },
        }),
      );
      return;
    }
    if (url === "/api/v1/settle" && req.method === "POST") {
      const authorizationId = body.authorizationId as string;
      const record = auths.get(authorizationId);
      if (!record || record.status !== "pending") {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "already_consumed" }));
        return;
      }
      record.status = "settled";
      res.writeHead(200);
      res.end(
        JSON.stringify({
          policy: { dailySpendCapUsd: 5, killed: false, tools: {} },
          meter: { day: "2099-01-01", spentUsd: spentUsd.value },
        }),
      );
      return;
    }
    if (url === "/api/v1/release" && req.method === "POST") {
      const authorizationId = body.authorizationId as string;
      const record = auths.get(authorizationId);
      if (!record || record.status !== "pending") {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "already_consumed" }));
        return;
      }
      record.status = "released";
      spentUsd.value = Math.max(0, Math.round((spentUsd.value - costUsd) * 1e6) / 1e6);
      res.writeHead(200);
      res.end(
        JSON.stringify({
          policy: { dailySpendCapUsd: 5, killed: false, tools: {} },
          meter: { day: "2099-01-01", spentUsd: spentUsd.value },
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: "not_found" }));
  });

  return new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      assert.ok(addr && typeof addr === "object");
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise((done, err) => {
            server.close((e) => (e ? err(e) : done()));
          }),
      });
    });
  });
}

test("failed run refunds authorize charge", async () => {
  const spentUsd = { value: 0 };
  const mock = await startMockCloud(spentUsd);
  const prevUrl = process.env.CAPGATE_API_URL;
  const prevKey = process.env.CAPGATE_API_KEY;
  process.env.CAPGATE_API_URL = mock.baseUrl;
  process.env.CAPGATE_API_KEY = "test";
  try {
    await assert.rejects(
      () =>
        gatedRun("capgate_demo_search", {}, () => {
          throw new Error("tool failed");
        }),
      (e) => e instanceof Error && e.message === "tool failed",
    );
    assert.equal(spentUsd.value, 0);
  } finally {
    if (prevUrl === undefined) delete process.env.CAPGATE_API_URL;
    else process.env.CAPGATE_API_URL = prevUrl;
    if (prevKey === undefined) delete process.env.CAPGATE_API_KEY;
    else process.env.CAPGATE_API_KEY = prevKey;
    await mock.close();
  }
});

test("authorize settle replay rejected", async () => {
  const spentUsd = { value: 0 };
  const mock = await startMockCloud(spentUsd);
  try {
    const auth = await cloudAuthorize(mock.baseUrl, "test", "capgate_demo_search");
    await cloudSettle(mock.baseUrl, "test", auth.authorizationId);
    await assert.rejects(
      () => cloudSettle(mock.baseUrl, "test", auth.authorizationId),
      (e) => e instanceof Error && e.message === "settle 400",
    );
  } finally {
    await mock.close();
  }
});
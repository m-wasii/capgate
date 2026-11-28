import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test } from "node:test";
import {
  CapgateError,
  DEFAULT_HTTP_TIMEOUT_MS,
  MAX_ATTEMPTS,
  cloudDecide,
  cloudGetApproval,
  cloudSettle,
  cloudStatus,
  httpTimeoutMs,
} from "./client.js";
import { gatedRun } from "./gate.js";

type Handler = (req: IncomingMessage, res: ServerResponse, body: unknown) => void | Promise<void>;

interface Mock {
  baseUrl: string;
  hits: string[];
  close: () => Promise<void>;
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

async function startMock(handler: Handler): Promise<Mock> {
  const hits: string[] = [];
  const server = createServer(async (req, res) => {
    try {
      const body = await readJsonBody(req);
      hits.push(`${req.method} ${req.url}`);
      await handler(req, res, body);
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    hits,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}

async function withEnv(
  env: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/** Narrow match helper so each assertion failure names what went wrong. */
function expectCapgate(e: unknown): CapgateError {
  assert.ok(e instanceof CapgateError, `expected CapgateError, got ${String(e)}`);
  assert.equal(e.name, "CapgateError");
  return e;
}

test("default HTTP timeout is 10s and CAPGATE_HTTP_TIMEOUT_MS overrides it", async () => {
  await withEnv({ CAPGATE_HTTP_TIMEOUT_MS: undefined }, async () => {
    assert.equal(httpTimeoutMs(), DEFAULT_HTTP_TIMEOUT_MS);
    assert.equal(httpTimeoutMs(), 10_000);
  });
  await withEnv({ CAPGATE_HTTP_TIMEOUT_MS: "250" }, async () => {
    assert.equal(httpTimeoutMs(), 250);
  });
});

test("hung control plane aborts with a typed timeout error", async () => {
  const mock = await startMock(() => {
    // Never respond: simulates a paused / stalled deployment.
  });
  try {
    await withEnv({ CAPGATE_HTTP_TIMEOUT_MS: "100", CAPGATE_HTTP_RETRY_BASE_MS: "1" }, async () => {
      const started = Date.now();
      await assert.rejects(
        () => cloudStatus(mock.baseUrl, "test-key"),
        (e) => {
          const err = expectCapgate(e);
          assert.equal(err.kind, "timeout");
          assert.equal(err.code, "control_plane_unreachable");
          assert.match(err.message, /status timeout after 100ms/);
          return true;
        },
      );
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 2_000, `must fail fast, took ${elapsed}ms`);
      assert.equal(mock.hits.length, MAX_ATTEMPTS);
    });
  } finally {
    await mock.close();
  }
});

test("decide retries 429 and honours Retry-After", async () => {
  let attempts = 0;
  const mock = await startMock((_req, res) => {
    attempts++;
    if (attempts === 1) {
      json(res, 429, { error: "rate_limited" }, { "retry-after": "1" });
      return;
    }
    json(res, 200, { allow: true, costUsd: 0.01 });
  });
  try {
    await withEnv({ CAPGATE_HTTP_RETRY_BASE_MS: "1" }, async () => {
      const started = Date.now();
      const decision = await cloudDecide(mock.baseUrl, "test-key", "capgate_demo_search");
      assert.equal(decision.allow, true);
      assert.equal(mock.hits.length, 2);
      assert.ok(Date.now() - started >= 900, "should wait out Retry-After");
    });
  } finally {
    await mock.close();
  }
});

test("safe read gives up after MAX_ATTEMPTS on persistent 5xx", async () => {
  const mock = await startMock((_req, res) => json(res, 503, { error: "unavailable" }));
  try {
    await withEnv({ CAPGATE_HTTP_RETRY_BASE_MS: "1" }, async () => {
      await assert.rejects(
        () => cloudStatus(mock.baseUrl, "test-key"),
        (e) => {
          const err = expectCapgate(e);
          assert.equal(err.kind, "http");
          assert.equal(err.code, "control_plane_unreachable");
          assert.equal(err.status, 503);
          return true;
        },
      );
      assert.equal(mock.hits.length, MAX_ATTEMPTS);
    });
  } finally {
    await mock.close();
  }
});

test("getApproval retries a transient 5xx once and succeeds", async () => {
  let attempts = 0;
  const mock = await startMock((_req, res) => {
    attempts++;
    if (attempts === 1) {
      json(res, 502, { error: "bad_gateway" });
      return;
    }
    json(res, 200, { id: "appr-1", toolName: "capgate_demo_refund", args: {}, status: "pending" });
  });
  try {
    await withEnv({ CAPGATE_HTTP_RETRY_BASE_MS: "1" }, async () => {
      const record = await cloudGetApproval(mock.baseUrl, "test-key", "appr-1");
      assert.equal(record.status, "pending");
      assert.equal(mock.hits.length, 2);
    });
  } finally {
    await mock.close();
  }
});

test("settle is never retried", async () => {
  const mock = await startMock((_req, res) => json(res, 500, { error: "boom" }));
  try {
    await withEnv({ CAPGATE_HTTP_RETRY_BASE_MS: "1" }, async () => {
      await assert.rejects(
        () => cloudSettle(mock.baseUrl, "test-key", "auth-1"),
        (e) => {
          const err = expectCapgate(e);
          assert.equal(err.kind, "http");
          assert.equal(err.status, 500);
          assert.equal(err.message, "settle 500");
          return true;
        },
      );
      assert.equal(mock.hits.length, 1);
    });
  } finally {
    await mock.close();
  }
});

test("429 on authorize fails with a retry hint and never runs the tool", async () => {
  let ran = 0;
  const mock = await startMock((req, res) => {
    const url = req.url ?? "";
    if (url === "/api/v1/decide") {
      json(res, 200, { allow: true, costUsd: 0.01 });
      return;
    }
    if (url === "/api/v1/authorize") {
      json(res, 429, { error: "rate_limited" }, { "retry-after": "2" });
      return;
    }
    json(res, 404, { error: "not_found" });
  });
  try {
    await withEnv(
      {
        CAPGATE_API_URL: mock.baseUrl,
        CAPGATE_API_KEY: "test-key",
        CAPGATE_HTTP_RETRY_BASE_MS: "1",
      },
      async () => {
        await assert.rejects(
          () =>
            gatedRun("capgate_demo_search", {}, () => {
              ran++;
              return "{}";
            }),
          (e) => {
            const err = expectCapgate(e);
            assert.equal(err.code, "rate_limited");
            assert.equal(err.status, 429);
            assert.equal(err.retryAfterSec, 2);
            assert.match(err.message, /authorize 429 rate_limited: retry after 2s/);
            return true;
          },
        );
      },
    );
    assert.equal(ran, 0, "tool must not run when authorize is rate limited");
    assert.equal(mock.hits.filter((h) => h.endsWith("/authorize")).length, 1);
    assert.equal(mock.hits.filter((h) => h.endsWith("/settle")).length, 0);
  } finally {
    await mock.close();
  }
});

test("401 maps to unauthorized and is not retried", async () => {
  const mock = await startMock((_req, res) => json(res, 401, { error: "unauthorized" }));
  try {
    await assert.rejects(
      () => cloudStatus(mock.baseUrl, "bad-key"),
      (e) => {
        const err = expectCapgate(e);
        assert.equal(err.kind, "http");
        assert.equal(err.code, "unauthorized");
        assert.equal(err.status, 401);
        assert.equal(err.retryable, false);
        assert.match(err.message, /check CAPGATE_API_KEY/);
        return true;
      },
    );
    assert.equal(mock.hits.length, 1);
  } finally {
    await mock.close();
  }
});

test("400 maps to invalid_request and is not retried", async () => {
  const mock = await startMock((_req, res) => json(res, 400, { error: "bad_request" }));
  try {
    await assert.rejects(
      () => cloudStatus(mock.baseUrl, "test-key"),
      (e) => {
        const err = expectCapgate(e);
        assert.equal(err.kind, "http");
        assert.equal(err.code, "invalid_request");
        assert.equal(err.status, 400);
        assert.equal(err.retryable, false);
        assert.equal(err.message, "status 400");
        return true;
      },
    );
    assert.equal(mock.hits.length, 1);
  } finally {
    await mock.close();
  }
});

test("connection refused maps to a network error", async () => {
  const mock = await startMock(() => {});
  const { baseUrl } = mock;
  await mock.close();
  try {
    await withEnv(
      { CAPGATE_HTTP_TIMEOUT_MS: "2000", CAPGATE_HTTP_RETRY_BASE_MS: "1" },
      async () => {
        await assert.rejects(
          () => cloudStatus(baseUrl, "test-key"),
          (e) => {
            const err = expectCapgate(e);
            assert.equal(err.kind, "network");
            assert.equal(err.code, "control_plane_unreachable");
            assert.match(err.message, /status network error:/);
            return true;
          },
        );
      },
    );
  } finally {
    // Already closed above; keep the shape symmetric with other tests.
  }
});

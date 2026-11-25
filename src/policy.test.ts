import assert from "node:assert/strict";
import { test } from "node:test";
import { applySpend, decide, type Meter, type Policy } from "./policy.js";

const policy: Policy = {
  dailySpendCapUsd: 1,
  killed: false,
  tools: {
    search: { risk: "low", costUsd: 0.01 },
    refund: { risk: "spend", costUsd: 0.05 },
  },
};

const meter: Meter = { day: "2099-01-01", spentUsd: 0 };

test("low-risk under cap is allowed", () => {
  assert.deepEqual(decide(policy, meter, "search", new Date("2099-01-01T12:00:00Z")), {
    allow: true,
    costUsd: 0.01,
  });
});

test("high-risk needs approval", () => {
  assert.deepEqual(decide(policy, meter, "refund", new Date("2099-01-01T12:00:00Z")), {
    allow: false,
    reason: "needs_approval",
  });
});

test("cap blocks", () => {
  assert.deepEqual(
    decide(policy, { day: "2099-01-01", spentUsd: 0.995 }, "search", new Date("2099-01-01T12:00:00Z")),
    { allow: false, reason: "cap" },
  );
});

test("kill switch blocks", () => {
  assert.deepEqual(
    decide({ ...policy, killed: true }, meter, "search", new Date("2099-01-01T12:00:00Z")),
    { allow: false, reason: "killed" },
  );
});

test("applySpend rolls day", () => {
  assert.deepEqual(
    applySpend({ day: "2099-01-01", spentUsd: 0.5 }, 0.01, new Date("2099-01-02T00:00:00Z")),
    { day: "2099-01-02", spentUsd: 0.01 },
  );
});

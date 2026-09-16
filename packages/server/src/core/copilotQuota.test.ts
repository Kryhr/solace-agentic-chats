import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCopilotQuota } from "./copilotQuota";

/** The exact shape account.getQuota returned live on a Copilot individual / free_educational
 * plan, trimmed to the fields that are read. */
const LIVE = {
  quotaSnapshots: {
    chat: { isUnlimitedEntitlement: true, entitlementRequests: 0, usedRequests: 0, remainingPercentage: 100 },
    completions: { isUnlimitedEntitlement: true, entitlementRequests: 0, usedRequests: 0, remainingPercentage: 100 },
    premium_interactions: {
      isUnlimitedEntitlement: false,
      entitlementRequests: 200,
      usedRequests: 54,
      remainingPercentage: 73,
      resetDate: "2026-10-01T00:00:00.000Z",
    },
  },
};

const NOW = Date.parse("2026-09-16T01:14:40.000Z");

test("only the metered snapshot is reported", () => {
  // chat and completions come back unlimited; publishing "0% used" against an unlimited quota
  // would be a number with nothing behind it.
  const windows = parseCopilotQuota(LIVE, NOW);
  assert.deepEqual(windows.map((w) => w.key), ["premium_interactions"]);
});

test("the percentage is derived from the counts it is shown beside", () => {
  const [w] = parseCopilotQuota(LIVE, NOW);
  assert.equal(w.usedPercent, 27, "54 of 200");
  assert.match(w.label, /54 of 200/);
});

test("a reset time that is not in the future is dropped", () => {
  // Observed live: resetDate came back as roughly the snapshot time, which would render as
  // "resets in 0 minutes" - a claim, not a fact.
  const body = JSON.parse(JSON.stringify(LIVE));
  body.quotaSnapshots.premium_interactions.resetDate = new Date(NOW).toISOString();
  assert.equal(parseCopilotQuota(body, NOW)[0].resetsAt, undefined);
  assert.equal(parseCopilotQuota(LIVE, NOW)[0].resetsAt, Math.floor(Date.parse("2026-10-01T00:00:00.000Z") / 1000));
});

test("nothing usable yields no windows rather than a fabricated zero", () => {
  assert.deepEqual(parseCopilotQuota(null, NOW), []);
  assert.deepEqual(parseCopilotQuota({}, NOW), []);
  assert.deepEqual(parseCopilotQuota({ quotaSnapshots: { x: { entitlementRequests: 0, usedRequests: 0 } } }, NOW), []);
  assert.deepEqual(parseCopilotQuota({ quotaSnapshots: { x: { entitlementRequests: 200 } } }, NOW), []);
});

test("a used count beyond the entitlement clamps at 100 rather than exceeding it", () => {
  const body = { quotaSnapshots: { premium_interactions: { entitlementRequests: 200, usedRequests: 240 } } };
  assert.equal(parseCopilotQuota(body, NOW)[0].usedPercent, 100);
});

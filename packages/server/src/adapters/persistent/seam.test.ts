import assert from "node:assert/strict";
import { test } from "node:test";

import { getAdapter } from "../index";
import type { ProviderAdapter } from "../types";
import { persistentTransportStatus, withPersistentTransport } from "./index";
import { declaredTransportOf, persistentTransportOf, sessionIdentity } from "./types";

/**
 * The seam itself: that adding a persistent transport did not, and cannot, change how the
 * spawn-per-turn adapters behave.
 *
 * This is the test that would fail loudest if this change were done carelessly. Eleven adapters
 * work today; the one line in agentManager that reaches for a live session runs for all of them,
 * and it has to be a no-op for all of them.
 */

const CLI_PROVIDERS = [
  "claude-code",
  "codex-cli",
  "gemini-cli",
  "qwen-code",
  "copilot-cli",
  "opencode",
  "crush",
  "continue",
  "droid",
  "kilo",
  "kimi",
] as const;

test("every registered adapter still comes back with its runTurn intact", () => {
  for (const provider of CLI_PROVIDERS) {
    const adapter = withPersistentTransport(getAdapter(provider));
    assert.equal(adapter.id, provider);
    assert.equal(typeof adapter.runTurn, "function", `${provider} must still be runnable the old way`);
  }
});

test("an adapter with no transport is returned UNCHANGED - same object, not a copy", () => {
  // Identity, not deep equality. A wrapper around an adapter that has no live path would be a
  // silent behaviour change for ten providers in exchange for nothing.
  for (const provider of CLI_PROVIDERS) {
    const original = getAdapter(provider);
    const wrapped = withPersistentTransport(original);
    const declared = declaredTransportOf(wrapped);
    if (!declared) assert.equal(wrapped, original, `${provider} should not have been touched`);
  }
});

test("no provider's live transport is reachable while it is switched off", () => {
  for (const provider of CLI_PROVIDERS) {
    const adapter = withPersistentTransport(getAdapter(provider));
    const declared = declaredTransportOf(adapter);
    const reachable = persistentTransportOf(adapter);
    if (declared && !declared.enabled) {
      assert.equal(reachable, undefined, `${provider} is off and must not be reachable`);
      assert.ok(declared.disabledReason, `${provider} must say why it is off`);
    }
  }
});

test("nothing is enabled today, and every entry says why - the honest state, asserted", () => {
  // This test is expected to CHANGE when a transport is switched on, and that is the point: no
  // transport becomes reachable without somebody editing an assertion that says it was verified.
  for (const entry of persistentTransportStatus()) {
    assert.equal(entry.enabled, false, `${entry.provider} is enabled - was it actually driven?`);
    assert.ok(entry.disabledReason, `${entry.provider} must say why it is off`);
  }
});

test("the status table reports every declared transport, enabled or not", () => {
  const status = persistentTransportStatus();
  assert.deepEqual(
    status.map((s) => s.provider).sort(),
    ["claude-code", "opencode", "gemini-cli", "kimi", "qwen-code"].sort(),
  );
  // A disabled entry without a reason would be the honest answer replaced by an absence, which
  // is exactly what this repo does not do.
  for (const entry of status) {
    if (!entry.enabled) assert.ok(entry.disabledReason, `${entry.provider} must say why it is off`);
    else assert.equal(entry.disabledReason, undefined);
  }
});

test("the api-key adapters are untouched by any of this", () => {
  for (const provider of ["claude-code", "codex-cli"] as const) {
    const adapter = getAdapter(provider, "api-key");
    assert.equal(withPersistentTransport(adapter), adapter);
  }
});

/* -------------------------------------------------------------------------- */
/* What makes two turns the same session                                       */
/* -------------------------------------------------------------------------- */

test("session identity covers exactly the process-start flags, and nothing else", () => {
  const base = { trustLevel: "acceptEdits" as const, model: "sonnet", effort: "high", account: "work" };
  assert.equal(sessionIdentity(base), sessionIdentity({ ...base }));
  for (const change of [
    { trustLevel: "plan" as const },
    { model: "opus" },
    { effort: "low" },
    { account: "personal" },
  ]) {
    assert.notEqual(sessionIdentity(base), sessionIdentity({ ...base, ...change }), JSON.stringify(change));
  }
});

test("an unset flag and an empty one are the same identity, not two", () => {
  assert.equal(
    sessionIdentity({ trustLevel: "default", model: undefined, effort: undefined, account: undefined }),
    sessionIdentity({ trustLevel: "default", model: "", effort: "", account: "" }),
  );
});

test("persistentTransportOf ignores anything that is not actually a transport", () => {
  const impostor = { id: "crush", async runTurn() {}, persistent: { enabled: true } } as unknown as ProviderAdapter;
  assert.equal(persistentTransportOf(impostor), undefined);
});

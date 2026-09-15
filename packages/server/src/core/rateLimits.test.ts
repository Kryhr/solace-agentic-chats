import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  RateLimitStore,
  labelForWindowMinutes,
  parseClaudeRateLimitEvent,
  parseCodexRateLimitEvent,
  sanitizePersistedRateLimits,
} from "./rateLimits.ts";

const OBSERVED = "2026-01-02T03:04:05.000Z";

// Verbatim shape of a real line from `claude -p --output-format stream-json`.
const CLAUDE_EVENT = {
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed",
    resetsAt: 1767322800,
    rateLimitType: "five_hour",
    overageStatus: "not_configured",
    unifiedWindows: {
      five_hour: { utilization: 0.79, resetsAt: 1767322800 },
      seven_day: { utilization: 0.53, resetsAt: 1767841200 },
    },
  },
};

// Verbatim shape of the rate_limits block on a real `codex exec --json` token_count event.
const CODEX_EVENT = {
  type: "token_count",
  rate_limits: {
    limit_id: "codex",
    primary: { used_percent: 12.5, window_minutes: 10080, resets_at: 1767841200 },
    secondary: null,
    credits: { balance: 0 },
    plan_type: "plus",
  },
};

test("parses Claude's five_hour/seven_day windows with their real reset times", () => {
  const parsed = parseClaudeRateLimitEvent(CLAUDE_EVENT, OBSERVED);
  assert.ok(parsed);
  assert.equal(parsed.provider, "claude-code");
  assert.equal(parsed.observedAt, OBSERVED);
  assert.deepEqual(parsed.windows, [
    { key: "five_hour", label: "5-hour limit", usedPercent: 79, resetsAt: 1767322800 },
    { key: "seven_day", label: "7-day limit", usedPercent: 53, resetsAt: 1767841200 },
  ]);
});

test("Claude's 0..1 utilization becomes percent, not a 0.79% figure", () => {
  const parsed = parseClaudeRateLimitEvent(CLAUDE_EVENT, OBSERVED);
  assert.equal(parsed?.windows[0].usedPercent, 79);
});

test("Codex's used_percent is already 0..100 and is passed through untouched", () => {
  const parsed = parseCodexRateLimitEvent(CODEX_EVENT, OBSERVED);
  assert.ok(parsed);
  assert.equal(parsed.provider, "codex-cli");
  assert.equal(parsed.planType, "plus");
  assert.deepEqual(parsed.windows, [
    { key: "primary", label: "7-day limit", usedPercent: 12.5, resetsAt: 1767841200 },
  ]);
});

test("a null primary window early in a Codex turn yields no figure at all", () => {
  const parsed = parseCodexRateLimitEvent(
    { type: "token_count", rate_limits: { limit_id: "codex", primary: null, secondary: null } },
    OBSERVED,
  );
  assert.equal(parsed, null);
});

test("a Codex event with no rate_limits block at all yields nothing", () => {
  assert.equal(parseCodexRateLimitEvent({ type: "token_count", info: {} }, OBSERVED), null);
});

test("a Claude event without unifiedWindows yields nothing rather than a reset-time-only entry", () => {
  const parsed = parseClaudeRateLimitEvent(
    { type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1767322800, rateLimitType: "five_hour" } },
    OBSERVED,
  );
  assert.equal(parsed, null);
});

test("windows whose utilization isn't a number are dropped, not defaulted to zero", () => {
  const parsed = parseClaudeRateLimitEvent(
    {
      type: "rate_limit_event",
      rate_limit_info: {
        unifiedWindows: { five_hour: { utilization: null }, seven_day: { utilization: 0.5 } },
      },
    },
    OBSERVED,
  );
  assert.deepEqual(
    parsed?.windows.map((w) => w.key),
    ["seven_day"],
  );
});

test("unrelated stream lines are ignored by both parsers", () => {
  assert.equal(parseClaudeRateLimitEvent({ type: "assistant", message: { content: [] } }, OBSERVED), null);
  assert.equal(parseCodexRateLimitEvent({ type: "turn.completed", usage: {} }, OBSERVED), null);
  assert.equal(parseClaudeRateLimitEvent(null, OBSERVED), null);
  assert.equal(parseCodexRateLimitEvent("not an object", OBSERVED), null);
});

test("window labels are derived from the provider's own window_minutes", () => {
  assert.equal(labelForWindowMinutes(10080, "primary limit"), "7-day limit");
  assert.equal(labelForWindowMinutes(300, "primary limit"), "5-hour limit");
  assert.equal(labelForWindowMinutes(90, "primary limit"), "90-minute limit");
  assert.equal(labelForWindowMinutes(undefined, "primary limit"), "primary limit");
});

test("a provider that has never reported has no entry, rather than a zero entry", () => {
  const store = new RateLimitStore();
  assert.equal(store.get("claude-code"), undefined);
  assert.deepEqual(store.list(), []);
});

test("agents sharing one provider share one observation, newest wins", () => {
  const store = new RateLimitStore();
  const older = parseClaudeRateLimitEvent(CLAUDE_EVENT, "2026-01-02T03:00:00.000Z")!;
  const newer = parseClaudeRateLimitEvent(
    { type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.81 } } } },
    "2026-01-02T03:10:00.000Z",
  )!;
  assert.equal(store.record(newer), true);
  assert.equal(store.record(older), false, "an older observation from a second agent must not overwrite");
  assert.equal(store.list().length, 1);
  assert.equal(store.get("claude-code")?.windows[0].usedPercent, 81);
});

test("persisted state from before this feature (or with junk in it) loads as no observations", () => {
  assert.deepEqual(sanitizePersistedRateLimits(undefined), []);
  assert.deepEqual(sanitizePersistedRateLimits([{ provider: "claude-code" }]), []);
  assert.deepEqual(
    sanitizePersistedRateLimits([{ provider: "claude-code", observedAt: OBSERVED, windows: [{ key: "x", label: "x" }] }]),
    [],
    "a window with no provider-reported percentage is not a usable observation",
  );
});

test("a well-formed persisted observation round-trips with its timestamp", () => {
  const parsed = parseCodexRateLimitEvent(CODEX_EVENT, OBSERVED)!;
  assert.deepEqual(sanitizePersistedRateLimits(JSON.parse(JSON.stringify([parsed]))), [parsed]);
});

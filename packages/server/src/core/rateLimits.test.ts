import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  RateLimitStore,
  labelForWindowMinutes,
  parseClaudeRateLimitEvent,
  parseCodexRateLimitEvent,
  readCodexRateLimitFromRollout,
  sanitizePersistedRateLimits,
} from "./rateLimits.ts";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

test("agents sharing one provider AND one account share one observation, newest wins", () => {
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

/**
 * THE INCIDENT. The operator runs two Claude agents on two different Claude subscriptions
 * (CLAUDE_CONFIG_DIR per account - providerAccounts.ts, verified live). This store keyed on
 * provider alone, so whichever account finished a turn most recently overwrote the other, and
 * the usage view showed ONE "Claude Code" row carrying that figure - presented as the quota of
 * both accounts. Reading 12% used, the operator would believe a nearly-spent second
 * subscription had 88% left. A confidently wrong number is the cardinal sin here.
 */
test("two accounts of one provider keep two separate figures", () => {
  const store = new RateLimitStore();
  const work = parseClaudeRateLimitEvent(CLAUDE_EVENT, "2026-01-02T03:00:00.000Z")!;
  const personal = parseClaudeRateLimitEvent(
    { type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.05 } } } },
    "2026-01-02T03:10:00.000Z",
  )!;
  assert.equal(store.record({ ...work, account: "Work" }), true);
  assert.equal(
    store.record({ ...personal, account: "Personal" }),
    true,
    "a NEWER observation for a DIFFERENT account must not be read as superseding the first",
  );
  assert.equal(store.list().length, 2, "one row per account, not one per provider");
  assert.equal(store.get("claude-code", "Work")?.windows[0].usedPercent, 79);
  assert.equal(store.get("claude-code", "Personal")?.windows[0].usedPercent, 5);
});

test("an older observation for one account cannot overwrite that same account", () => {
  const store = new RateLimitStore();
  const newer = parseClaudeRateLimitEvent(CLAUDE_EVENT, "2026-01-02T03:10:00.000Z")!;
  const older = parseClaudeRateLimitEvent(
    { type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.02 } } } },
    "2026-01-02T03:00:00.000Z",
  )!;
  assert.equal(store.record({ ...newer, account: "Work" }), true);
  assert.equal(store.record({ ...older, account: "Work" }), false);
  assert.equal(store.get("claude-code", "Work")?.windows[0].usedPercent, 79);
});

/** The default login is its own account, NOT a fallback for a labelled one. Borrowing a
 * labelled account's figure for the default login would reintroduce the same wrong number by a
 * different route. */
test("the default login does not inherit a labelled account's figure", () => {
  const store = new RateLimitStore();
  store.record({ ...parseClaudeRateLimitEvent(CLAUDE_EVENT, OBSERVED)!, account: "Work" });
  assert.equal(store.get("claude-code"), undefined);
  assert.equal(store.get("claude-code", undefined), undefined);
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
  // `account` is written explicitly on the expected value rather than left off: the parser
  // never sets it (the runtime stamps it - see accountUsage.test.ts) so the parsed object has
  // no such key, while the sanitizer always produces one. Both mean the CLI's own default
  // login; deepStrictEqual is the only thing that can tell them apart.
  assert.deepEqual(sanitizePersistedRateLimits(JSON.parse(JSON.stringify([parsed]))), [
    { ...parsed, account: undefined },
  ]);
});


/**
 * Codex writes its rate limits into a session rollout under CODEX_HOME/sessions/, and an agent
 * on a named account runs with CODEX_HOME pointed at that account's own directory. So the meter
 * has to be read from the home that turn actually ran under, not from the server's own.
 *
 * Reading the wrong one is not a blank meter, which would be honest - it is one account's usage
 * displayed against another account's agent, which is the exact confusion the multi-account
 * feature exists to remove.
 */
function writeRollout(home: string, sessionId: string, usedPercent: number): void {
  const dir = join(home, "sessions", "2026", "09", "16");
  mkdirSync(dir, { recursive: true });
  // Rollout lines wrap the stream event in a {timestamp, type, payload} envelope, and the file
  // name carries the session id - both matching what codex 0.149.0 writes.
  const line = JSON.stringify({
    timestamp: OBSERVED,
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: { primary: { used_percent: usedPercent, window_minutes: 300 }, secondary: null, plan_type: "plus" },
    },
  });
  writeFileSync(join(dir, `rollout-2026-09-16T00-00-00-${sessionId}.jsonl`), `${line}\n`);
}

test("a codex account's rate limits are read from that account's own CODEX_HOME", () => {
  const serverHome = mkdtempSync(join(tmpdir(), "codex-default-"));
  const accountHome = mkdtempSync(join(tmpdir(), "codex-account-"));
  const sessionId = "11111111-2222-3333-4444-555555555555";
  // The same session id in both homes, with different usage - so a reader that ignored the
  // override would still find a file and silently report the wrong number.
  writeRollout(serverHome, sessionId, 11);
  writeRollout(accountHome, sessionId, 88);

  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = serverHome;
  try {
    const onAccount = readCodexRateLimitFromRollout(sessionId, OBSERVED, accountHome);
    assert.equal(onAccount?.windows[0].usedPercent, 88, "the account's own rollout, not the server's");

    // No account named: the default login, which is the server's own CODEX_HOME. This is the
    // path every existing single-account user is on and it must not have changed.
    const onDefault = readCodexRateLimitFromRollout(sessionId, OBSERVED, undefined);
    assert.equal(onDefault?.windows[0].usedPercent, 11);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});

test("an account home with no rollout for the session reports nothing rather than another account's", () => {
  const accountHome = mkdtempSync(join(tmpdir(), "codex-empty-"));
  const serverHome = mkdtempSync(join(tmpdir(), "codex-other-"));
  writeRollout(serverHome, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", 99);
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = serverHome;
  try {
    assert.equal(readCodexRateLimitFromRollout("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", OBSERVED, accountHome), null);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});

test("the account rides along through persistence, and an older state file reads as the default login", () => {
  const withAccount = sanitizePersistedRateLimits([
    { provider: "claude-code", account: "Work", observedAt: OBSERVED, windows: [{ key: "five_hour", label: "5-hour limit", usedPercent: 79 }] },
  ]);
  assert.equal(withAccount[0].account, "Work", "a restart must not merge two accounts back into one");
  const legacy = sanitizePersistedRateLimits([
    { provider: "claude-code", observedAt: OBSERVED, windows: [{ key: "five_hour", label: "5-hour limit", usedPercent: 79 }] },
  ]);
  assert.equal(legacy[0].account, undefined, "no account key means the CLI's own default login, which is what it was");
  const junk = sanitizePersistedRateLimits([
    { provider: "claude-code", account: 7, observedAt: OBSERVED, windows: [{ key: "five_hour", label: "5-hour limit", usedPercent: 79 }] },
  ]);
  assert.equal(junk[0].account, undefined, "a non-string account is dropped, not coerced");
});

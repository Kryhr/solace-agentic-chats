import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildAccountUsage } from "./accountUsage.ts";
import type { AgentConfig, ProviderRateLimit } from "@solace/shared";

/**
 * The incident: usage was keyed by PROVIDER, and the operator runs two Claude agents on two
 * different Claude subscriptions. The usage view therefore showed one "Claude Code" row, filled
 * with whichever account had most recently finished a turn, and presented it as the quota of
 * both. Reading "12% used", the operator would believe a nearly-exhausted second subscription
 * had plenty left - a confidently wrong number, which is the failure this repo treats as worst.
 *
 * These pin the two rules the fix rests on: one row per ACCOUNT, and an account that has never
 * reported shows NOTHING rather than a zero.
 */

function agent(handle: string, account?: string): Pick<AgentConfig, "provider" | "account" | "handle"> {
  return { provider: "claude-code", account, handle };
}

const OBSERVED = "2026-01-02T03:04:05.000Z";

function limit(account: string | undefined, usedPercent: number): ProviderRateLimit {
  return {
    provider: "claude-code",
    account,
    observedAt: OBSERVED,
    windows: [{ key: "five_hour", label: "5-hour limit", usedPercent }],
  };
}

test("two Claude agents on two Claude accounts are two rows, each with its own figure", () => {
  const rows = buildAccountUsage(
    [agent("claude", "Work"), agent("Claude2", "Personal")],
    [limit("Work", 79), limit("Personal", 5)],
  );
  assert.equal(rows.length, 2, "one row per account - the whole point of the fix");
  assert.equal(rows.find((r) => r.account === "Work")?.rateLimit?.windows[0].usedPercent, 79);
  assert.equal(rows.find((r) => r.account === "Personal")?.rateLimit?.windows[0].usedPercent, 5);
});

test("an account that has never reported carries no rateLimit at all - never a zero", () => {
  const rows = buildAccountUsage([agent("claude", "Work"), agent("Claude2", "Personal")], [limit("Work", 79)]);
  const personal = rows.find((r) => r.account === "Personal")!;
  assert.equal(personal.rateLimit, undefined);
  // The specific regression: Personal must not pick up Work's 79%. "We have not seen a number
  // for this login" and "this login has used 79%" are different claims.
  assert.notEqual(personal.rateLimit, rows.find((r) => r.account === "Work")!.rateLimit);
});

test("the default login is its own row and does not borrow a labelled account's figure", () => {
  const rows = buildAccountUsage([agent("claude"), agent("Claude2", "Work")], [limit("Work", 79)]);
  const def = rows.find((r) => r.account === undefined)!;
  assert.equal(def.rateLimit, undefined);
  assert.equal(rows.find((r) => r.account === "Work")!.rateLimit?.windows[0].usedPercent, 79);
});

test("two agents genuinely sharing one login are ONE row listing both", () => {
  // The opposite error is just as wrong: two agents pointed at the same CLI and the same login
  // really do draw down a single limit, so splitting them would claim two quotas exist where
  // there is one.
  const rows = buildAccountUsage([agent("claude", "Work"), agent("Claude2", "Work")], [limit("Work", 79)]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].agentHandles, ["claude", "Claude2"]);
});

test("an empty-string account is the default login, not a third account", () => {
  // isValidAccountLabel rejects "", so it can only reach here from a hand-edited config. Keyed
  // as its own row it would split one real subscription across two bars.
  const rows = buildAccountUsage([agent("claude", ""), agent("Claude2")], [limit(undefined, 40)]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].account, undefined);
  assert.equal(rows[0].rateLimit?.windows[0].usedPercent, 40);
});

test("identity is copied from the CLI, and absent when the CLI said nothing", () => {
  const rows = buildAccountUsage(
    [agent("claude", "Work"), agent("Claude2", "Personal")],
    [],
    [{ provider: "claude-code", account: "Work", email: "a@example.com", plan: "max", loggedIn: true }],
  );
  const work = rows.find((r) => r.account === "Work")!;
  assert.equal(work.email, "a@example.com");
  assert.equal(work.plan, "max");
  const personal = rows.find((r) => r.account === "Personal")!;
  assert.equal(personal.email, undefined, "no identity reported means no name invented");
  assert.equal(personal.loggedIn, undefined);
});

test("an observation for an account no agent uses produces no row", () => {
  // A bar for a login nothing is spending can never move, and reads as a live meter.
  const rows = buildAccountUsage([agent("claude", "Work")], [limit("Work", 79), limit("Retired", 12)]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].account, "Work");
});

/**
 * Asserted against the source because it needs a live turn and a real provider process to
 * exercise: the account has to be stamped onto the observation by the RUNTIME, which is the
 * only place that certainly knows which login the CLI was pointed at. Stamping it in each
 * adapter instead would let one adapter forget and silently file a second subscription's
 * numbers under the first.
 */
test("the rate-limit observation is stamped with the account the turn ran on", () => {
  const src = readFileSync(join(import.meta.dirname, "agentManager.ts"), "utf8");
  assert.match(src, /const observation = \{ \.\.\.event\.rateLimit, account: runtime\.config\.account \}/);
  assert.match(src, /this\.rateLimits\.record\(observation\)/);
  assert.match(src, /this\.rateLimits\.get\(runtime\.config\.provider, runtime\.config\.account\)/);
  assert.ok(
    !/this\.rateLimits\.get\(runtime\.config\.provider\)(?!,)/.test(src),
    "the provider-only lookup, which showed one account's quota against another, must stay gone",
  );
});

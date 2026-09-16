import { test } from "node:test";
import assert from "node:assert/strict";
import { join, sep } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

// accountEnv() creates the directory it names. Without this every run of this suite would
// litter the developer's real ~/.solace/accounts with phantom accounts - which is exactly what
// happened, and they appeared in the account picker as if the user had made them.
process.env.SOLACE_ACCOUNTS_ROOT = mkdtempSync(join(tmpdir(), "solace-accounts-"));
import { accountEnv, accountDir, isValidAccountLabel, signInCommandFor, supportsMultipleAccounts } from "./providerAccounts";

/**
 * Two subscriptions of one provider, at the same time.
 *
 * The hazard being guarded: a coding CLI keeps ONE set of credentials in one place. Claude Code
 * uses `~/.claude/.credentials.json`, a single file, so `claude auth login` for a second account
 * overwrites the first and silently signs it out - you lose the login you were working on.
 *
 * Verified live on 2026-09-16 against claude 2.1.272: with CLAUDE_CONFIG_DIR set to an empty
 * directory, `claude auth status` returned {"loggedIn": false, "authMethod": "none"} and moved
 * its projects directory alongside, while the real ~/.claude/.credentials.json was byte-for-byte
 * unchanged (md5 identical before and after).
 */

test("an agent with no account named is completely unaffected", () => {
  // The default path must stay exactly as it was. Somebody with one subscription should never
  // have to know this feature exists, and must never have an env var set behind their back.
  assert.deepEqual(accountEnv("claude-code", undefined), {});
  assert.deepEqual(accountEnv("claude-code", ""), {});
});

test("a named account sets CLAUDE_CONFIG_DIR to its own directory", () => {
  const env = accountEnv("claude-code", "work");
  assert.equal(Object.keys(env).length, 1, "exactly one variable, nothing else");
  assert.equal(env.CLAUDE_CONFIG_DIR, accountDir("claude-code", "work"));
});

test("two accounts get two different directories", () => {
  // This is the whole feature. If these ever collide, both agents share one login and the user
  // believes they are on separate subscriptions while one takes all the load.
  const a = accountEnv("claude-code", "personal").CLAUDE_CONFIG_DIR;
  const b = accountEnv("claude-code", "work").CLAUDE_CONFIG_DIR;
  assert.notEqual(a, b);
});

test("a provider with no verified config-dir variable gets nothing, not a guess", () => {
  // Emitting an invented variable would be worse than doing nothing: the CLI would ignore it,
  // both agents would quietly share credentials, and the UI would claim they were separate.
  for (const p of ["codex-cli", "copilot-cli", "gemini-cli", "opencode", "kimi"] as const) {
    assert.equal(supportsMultipleAccounts(p), false, `${p} must not claim multi-account support`);
    assert.deepEqual(accountEnv(p, "work"), {});
  }
  assert.equal(supportsMultipleAccounts("claude-code"), true);
});

test("an account label cannot escape the accounts directory", () => {
  // The label becomes a directory name, so it is a containment boundary - the same class of bug
  // as the project-name traversal that created folders outside the workspace root.
  for (const bad of ["..", "../x", "..\\x", "a/b", "a\\b", "", " ", ".", "a:b", "a\u0000b", "a*b", "a?b"]) {
    assert.equal(isValidAccountLabel(bad), false, `${JSON.stringify(bad)} must be refused`);
    assert.throws(() => accountDir("claude-code", bad));
  }
  for (const ok of ["work", "personal", "Work Account", "acct-2", "a_b"]) {
    assert.equal(isValidAccountLabel(ok), true, `${JSON.stringify(ok)} should be allowed`);
  }
});

test("the sign-in command carries the env var, so a login cannot land on the wrong account", () => {
  // Solace never signs anybody in - that is a browser device flow the user performs. What it
  // owes them is a command that puts the login in the right directory instead of over the top
  // of the account they are already using.
  const cmd = signInCommandFor("claude-code", "work");
  assert.ok(cmd, "claude-code has a sign-in command");
  const dir = accountDir("claude-code", "work");
  assert.ok(cmd.powershell.includes(dir) && cmd.powershell.includes("claude auth login"));
  assert.ok(cmd.bash.includes(dir) && cmd.bash.includes("claude auth login"));
  assert.ok(cmd.powershell.startsWith("$env:CLAUDE_CONFIG_DIR="), "env must be set BEFORE the command");
});

test("accounts live under Solace's own accounts root, never inside the CLI's config", () => {
  // Solace must never read, write or inspect credentials - it only decides which folder the CLI
  // is pointed at. Writing into ~/.claude would put it in the business of owning them.
  const dir = accountDir("claude-code", "work");
  assert.ok(dir.startsWith(process.env.SOLACE_ACCOUNTS_ROOT!), "under the accounts root");
  assert.ok(dir.endsWith(`claude-code${sep}work`), "namespaced per provider, then per label");
  assert.ok(!dir.includes(`.claude${sep}`), "never inside ~/.claude");
});

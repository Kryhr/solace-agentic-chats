import { test } from "node:test";
import assert from "node:assert/strict";
import { join, sep } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

// accountEnv() creates the directory it names. Without this, every run of this suite would
// litter the developer's real ~/.solace/accounts with phantom accounts - which is exactly what
// happened once, and they appeared in the operator's own account picker as real logins.
process.env.SOLACE_ACCOUNTS_ROOT = mkdtempSync(join(tmpdir(), "solace-accounts-"));

import {
  accountDir,
  accountEnv,
  isValidAccountLabel,
  signInCommandFor,
  supportsMultipleAccounts,
  markDuplicates,
  DEFAULT_ACCOUNT_LABEL,
} from "./providerAccounts";
import type { ProviderId } from "@solace/shared";

/**
 * Several subscriptions of one provider, at the same time.
 *
 * The hazard: a coding CLI keeps ONE set of credentials in one place, so a second login
 * overwrites the first and silently signs it out - you lose the account you were working on.
 * Each provider below has a variable that relocates that storage, verified against the real
 * binary; the comments in providerAccounts.ts carry the evidence for each.
 */

/** Verified to isolate logins, with the variable each one needs. */
const SUPPORTED: Array<[ProviderId, string]> = [
  ["claude-code", "CLAUDE_CONFIG_DIR"],
  ["codex-cli", "CODEX_HOME"],
  ["kimi", "KIMI_CODE_HOME"],
  ["qwen-code", "QWEN_HOME"],
  ["gemini-cli", "GEMINI_CLI_HOME"],
  ["opencode", "XDG_DATA_HOME"],
  ["kilo", "XDG_DATA_HOME"],
  ["droid", "FACTORY_HOME_OVERRIDE"],
];

/**
 * Verified NOT to work, each for its own reason. Pinned as hard as the supported ones, because
 * the failure mode of wiring one up on a hunch is silent: the CLI ignores the variable, two
 * agents share one login, and the UI insists they are separate while one subscription pays.
 */
const UNSUPPORTED: ProviderId[] = ["copilot-cli", "continue", "crush", "custom", "local"];

test("an agent with no account named is completely unaffected, for every provider", () => {
  // The default path must stay exactly as it was. Someone with one subscription should never
  // have to know this exists, and must never have a variable set behind their back.
  for (const [p] of SUPPORTED) {
    assert.deepEqual(accountEnv(p, undefined), {}, `${p} with no account`);
    assert.deepEqual(accountEnv(p, ""), {}, `${p} with empty account`);
  }
});

test("each supported provider sets its own verified variable", () => {
  for (const [p, varName] of SUPPORTED) {
    const env = accountEnv(p, "work");
    assert.equal(env[varName], accountDir(p, "work"), `${p} must set ${varName}`);
  }
});

test("Gemini also forces file storage, or every account shares one keychain entry", () => {
  // Gemini's OAuth credentials go to the OS keychain under a FIXED service name that no home
  // override touches. Without this second variable the accounts LOOK separate and share a login
  // - the exact silent failure this module exists to prevent.
  assert.equal(accountEnv("gemini-cli", "work").GEMINI_FORCE_FILE_STORAGE, "true");
  // And nobody else gets it.
  for (const [p] of SUPPORTED) {
    if (p === "gemini-cli") continue;
    assert.equal(accountEnv(p, "work").GEMINI_FORCE_FILE_STORAGE, undefined, `${p} must not set it`);
  }
});

test("two accounts never share a directory, within or across providers", () => {
  // If these ever collide, two agents share one login while the user believes otherwise.
  const seen = new Map<string, string>();
  for (const [p] of SUPPORTED) {
    for (const label of ["personal", "work"]) {
      const dir = accountEnv(p, label)[CONFIG_VAR(p)];
      const key = `${p}/${label}`;
      assert.ok(dir, `${key} produced no directory`);
      for (const [otherKey, otherDir] of seen) {
        assert.notEqual(dir, otherDir, `${key} collides with ${otherKey}`);
      }
      seen.set(key, dir);
    }
  }
});

function CONFIG_VAR(p: ProviderId): string {
  return SUPPORTED.find(([id]) => id === p)![1];
}

test("a provider with no verified mechanism gets nothing, not a guess", () => {
  for (const p of UNSUPPORTED) {
    assert.equal(supportsMultipleAccounts(p), false, `${p} must not claim support`);
    assert.deepEqual(accountEnv(p, "work"), {}, `${p} must set no variable`);
    assert.equal(signInCommandFor(p, "work"), undefined, `${p} must offer no sign-in command`);
  }
});

test("copilot stays unsupported specifically, because its token is machine-wide", () => {
  // Called out on its own because COPILOT_HOME exists and looks like the answer. It moves config
  // and state only; the token lives in the OS credential store, shared by every COPILOT_HOME.
  // Proven by a real turn authenticating from an empty one.
  assert.equal(supportsMultipleAccounts("copilot-cli"), false);
});

test("an account label cannot escape the accounts directory", () => {
  // The label becomes a directory name, so this is a containment boundary - the same class of
  // bug as the project-name traversal that created folders outside the workspace root.
  for (const bad of ["..", "../x", "..\\x", "a/b", "a\\b", "", " ", ".", "a:b", "a\u0000b", "a*b", "a?b"]) {
    assert.equal(isValidAccountLabel(bad), false, `${JSON.stringify(bad)} must be refused`);
    assert.throws(() => accountDir("claude-code", bad));
  }
  for (const ok of ["work", "personal", "Work Account", "acct-2", "a_b"]) {
    assert.equal(isValidAccountLabel(ok), true, `${JSON.stringify(ok)} should be allowed`);
  }
});

test("every sign-in command sets the variables BEFORE the command", () => {
  // The whole point. A login run without them lands on top of the account already in use.
  for (const [p, varName] of SUPPORTED) {
    const cmd = signInCommandFor(p, "work");
    assert.ok(cmd, `${p} should offer a sign-in command`);
    assert.ok(cmd.powershell.startsWith(`$env:${varName}=`), `${p}: ${varName} must come first`);
    assert.ok(cmd.powershell.includes(accountDir(p, "work")), `${p} must name its own directory`);
    assert.ok(cmd.bash.startsWith(`${varName}=`), `${p} bash form must set it first`);
  }
});

test("Gemini's sign-in command carries the keychain override too", () => {
  // A sign-in without it writes to the shared keychain, and the account is isolated in name only.
  const cmd = signInCommandFor("gemini-cli", "work")!;
  assert.match(cmd.powershell, /GEMINI_FORCE_FILE_STORAGE="true"/);
  assert.match(cmd.bash, /GEMINI_FORCE_FILE_STORAGE="true"/);
});

test("no invented sign-in subcommand is printed", () => {
  // qwen's `auth` is marked "(removed)" in its own help, and gemini and droid have none at all.
  // Each says what actually happens instead of a command that would fail.
  for (const p of ["qwen-code", "gemini-cli", "droid"] as ProviderId[]) {
    const cmd = signInCommandFor(p, "work")!;
    assert.ok(!/\bauth login\b|\blogin\b/.test(cmd.powershell.split(";").pop()!), `${p} must not invent a login subcommand`);
    assert.ok(cmd.note, `${p} must explain how sign-in actually happens`);
  }
});

test("accounts live under Solace's own root, namespaced per provider then per label", () => {
  // Solace must never read, write or inspect credentials - it only chooses which folder the CLI
  // is pointed at. Writing inside the CLI's own directory would put it in the business of owning
  // them.
  const dir = accountDir("claude-code", "work");
  assert.ok(dir.startsWith(process.env.SOLACE_ACCOUNTS_ROOT!), "under the accounts root");
  assert.ok(dir.endsWith(`claude-code${sep}work`), "namespaced per provider, then per label");
  assert.ok(!dir.includes(`.claude${sep}`), "never inside ~/.claude");
});

/*
 * Adding an account is silent about the one thing that can go wrong with it.
 *
 * `CLAUDE_CONFIG_DIR` isolates the directory, not the browser: a browser already signed in to
 * claude.ai re-authorizes that account with no chooser, so the sign-in succeeds, writes a real
 * credentials file, and hands back the account you already had. Nothing downstream notices -
 * you get a new agent card, and two directories quietly sharing one login, one quota, and one
 * rotating refresh token that each will invalidate for the other.
 *
 * This happened on the operator's machine: two "accounts" with the same accountUuid, and the
 * first one eventually found with its tokens blanked.
 */
test("two accounts that are the same login are flagged, and the first one keeps it", () => {
  const marked = markDuplicates([
    { loggedIn: true, email: "a@example.com", orgId: "org-1", subscriptionType: "max" },
    { label: "second", loggedIn: true, email: "a@example.com", orgId: "org-1", subscriptionType: "max" },
  ]);
  assert.equal(marked[0].duplicateOf, undefined, "the first account is the one that holds the login");
  assert.equal(marked[1].duplicateOf, DEFAULT_ACCOUNT_LABEL);
});

test("the same address in a different org is a different account, and is not flagged", () => {
  // A personal login and a seat in a team share an address and genuinely are two accounts with
  // two quotas. Flagging that would be telling the user to undo a setup that is correct.
  const marked = markDuplicates([
    { loggedIn: true, email: "a@example.com", orgId: "org-personal" },
    { label: "work", loggedIn: true, email: "a@example.com", orgId: "org-team" },
  ]);
  assert.ok(marked.every((m) => m.duplicateOf === undefined));
});

test("a CLI that cannot say who it is is never called a duplicate", () => {
  // "we cannot tell" is not "they are the same", and guessing here would put a warning on a
  // setup that is fine.
  const marked = markDuplicates([
    { loggedIn: true, identityUnknown: true },
    { label: "second", loggedIn: true, identityUnknown: true },
    { label: "third", loggedIn: false },
  ]);
  assert.ok(marked.every((m) => m.duplicateOf === undefined));
});

test("a labelled duplicate points at the label that holds the login, not at the default", () => {
  const marked = markDuplicates([
    { loggedIn: false },
    { label: "work", loggedIn: true, email: "a@example.com", orgId: "org-1" },
    { label: "work-2", loggedIn: true, email: "a@example.com", orgId: "org-1" },
  ]);
  assert.equal(marked[2].duplicateOf, "work");
});

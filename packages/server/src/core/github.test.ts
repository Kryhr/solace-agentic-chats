import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReportedAccount, parseTokenScopes } from "./github";

/**
 * Connections shows `gh auth status`'s own text verbatim, but it also pulls two things out
 * of it: the scopes (which is the only honest answer to "what does this let agents do") and
 * the account name gh *thinks* it is signed in as. Both are parsed from text gh controls and
 * has changed the format of before, so the parsers have to fail by returning nothing rather
 * than by inventing a plausible-looking value.
 */

// The shape current gh prints. Token line included exactly as gh masks it, to be sure the
// parsers never reach for it.
const MODERN = `github.com
  ✓ Logged in to github.com account Kryhr (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'`;

const LEGACY = `github.com
  ✓ Logged in to github.com as hainesdrewh (oauth_token)
  ✓ Git operations for github.com configured to use https protocol.
  ✓ Token: *******************
  ✓ Token scopes: gist, read:org, repo`;

const SIGNED_OUT = `You are not logged into any GitHub hosts. To log in, run: gh auth login`;

test("scopes are read from the quoted modern format", () => {
  assert.deepEqual(parseTokenScopes(MODERN), ["gist", "read:org", "repo", "workflow"]);
});

test("scopes are read from the older unquoted format too", () => {
  assert.deepEqual(parseTokenScopes(LEGACY), ["gist", "read:org", "repo"]);
});

test("no scope line means undefined, never an empty list presented as 'no permissions'", () => {
  // These are different claims. "gh printed no scope line" is not "this token grants nothing",
  // and rendering the second when we only know the first would be a fabricated capability.
  assert.equal(parseTokenScopes(SIGNED_OUT), undefined);
  assert.equal(parseTokenScopes(""), undefined);
});

test("a scope line with nothing after it is an empty list, which is a real answer", () => {
  assert.deepEqual(parseTokenScopes("  - Token scopes: "), []);
});

test("the account name is read from both formats, without the trailing parenthetical", () => {
  assert.equal(parseReportedAccount(MODERN), "Kryhr");
  assert.equal(parseReportedAccount(LEGACY), "hainesdrewh");
});

test("no login line means undefined", () => {
  assert.equal(parseReportedAccount(SIGNED_OUT), undefined);
  assert.equal(parseReportedAccount(""), undefined);
});

test("the masked token is never mistaken for an account or a scope", () => {
  // The one value in this text that must never be surfaced. gh masks it already; this just
  // makes sure neither parser can reach it by accident if the layout shifts again.
  assert.ok(!parseReportedAccount(MODERN)?.includes("gho_"));
  assert.ok(!(parseTokenScopes(MODERN) ?? []).some((s) => s.includes("gho_")));
});

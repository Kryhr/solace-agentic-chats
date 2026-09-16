import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { capitalizeFirst, validateAgentPatch, validateNewAgentConfig } from "./validateAgentConfig";
import { WORKSPACE_ROOT } from "./workspace";

test("an agent's working folder can be repointed, with the same containment rule as creation", () => {
  // Needed after a project folder is deleted: the agent was left pointing at somewhere that no
  // longer exists and failed every turn, with no way to fix it but deleting and re-adding it.
  const ok = validateAgentPatch({ cwd: join(WORKSPACE_ROOT, "somewhere") });
  assert.ok("patch" in ok);
  assert.equal(ok.patch.cwd, resolve(join(WORKSPACE_ROOT, "somewhere")));
});

test("repointing outside the workspace is refused", () => {
  for (const bad of [join(WORKSPACE_ROOT, "..", "escape"), "C:\Windows\System32", "", "   "]) {
    assert.ok("error" in validateAgentPatch({ cwd: bad }), `${JSON.stringify(bad)} should be refused`);
  }
  assert.ok("error" in validateAgentPatch({ cwd: 42 as unknown as string }));
});

test("a patch that does not mention cwd leaves it alone", () => {
  const res = validateAgentPatch({ trustLevel: "plan" });
  assert.ok("patch" in res);
  assert.equal("cwd" in res.patch, false, "an absent key must not become an undefined write");
});

test("a new agent's handle is capitalised, so the roster reads like names", () => {
  const made = validateNewAgentConfig(
    { handle: "codex", provider: "codex-cli", trustLevel: "manual", cwd: WORKSPACE_ROOT },
    [],
  );
  assert.ok("config" in made);
  assert.equal(made.config.handle, "Codex");
});

test("only the first character is touched", () => {
  // A handle carrying a model version must keep its own casing, and one that does not start
  // with a lowercase letter is left exactly as typed.
  for (const [input, expected] of [
    ["OllamaQwen3.5", "OllamaQwen3.5"],
    ["gpt-5.5", "Gpt-5.5"],
    ["Claude", "Claude"],
    ["4o-mini", "4o-mini"],
    ["", ""],
  ] as const) {
    assert.equal(capitalizeFirst(input), expected, input);
  }
});

test("capitalising cannot sneak a duplicate past the uniqueness check", () => {
  // Uniqueness is compared case-insensitively, so "codex" must still collide with "Codex".
  const dupe = validateNewAgentConfig(
    { handle: "codex", provider: "codex-cli", trustLevel: "manual", cwd: WORKSPACE_ROOT },
    ["Codex"],
  );
  assert.ok("error" in dupe);
});

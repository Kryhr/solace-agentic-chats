import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CONNECTABLE_PROVIDERS,
  ConnectedProviderStore,
  connectableProvider,
  isConnectableProvider,
  sanitizeConnectedProviders,
} from "./connectedProviders";
import { loadState, saveState } from "./persistence";

function scratch(): string {
  const dir = join(tmpdir(), `solace-connected-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/* --------------------------------------------------------------------------
   The default. This is the whole point of the feature: a state file that
   predates it must read as "none connected", because the alternative silently
   restores the every-installed-CLI sidebar the feature exists to remove.
   -------------------------------------------------------------------------- */

test("an older state file, with no connected list at all, reads as none connected", () => {
  assert.deepEqual(sanitizeConnectedProviders(undefined), []);
  assert.deepEqual(new ConnectedProviderStore(undefined).list(), []);
});

test("a null, a string or an object where the list should be also reads as none - never as all", () => {
  for (const junk of [null, "claude-code", 7, { "claude-code": true }]) {
    assert.deepEqual(sanitizeConnectedProviders(junk), [], `${JSON.stringify(junk)} must not connect anything`);
  }
});

test("entries that are not CLI providers are dropped rather than carried into the sidebar", () => {
  // "custom" and "local" are HTTP endpoints with no binary; "gpt-9" is nothing at all. Each
  // would otherwise produce a row with no adapter and no --version behind it.
  assert.deepEqual(sanitizeConnectedProviders(["claude-code", "custom", "local", "gpt-9", 3, null]), ["claude-code"]);
});

test("duplicates collapse, and surviving order is the order on disk", () => {
  assert.deepEqual(sanitizeConnectedProviders(["codex-cli", "claude-code", "codex-cli"]), ["codex-cli", "claude-code"]);
});

/* --------------------------------------------------------------------------
   connect / disconnect
   -------------------------------------------------------------------------- */

test("connect appends, reports whether it actually changed anything, and fires onChange once", () => {
  const store = new ConnectedProviderStore([]);
  let changes = 0;
  store.onChange = () => changes++;

  assert.equal(store.connect("claude-code"), true);
  assert.equal(store.connect("codex-cli"), true);
  // Already there: no second entry, no second persist, and the route can say so honestly
  // rather than reporting a connection that did not happen.
  assert.equal(store.connect("claude-code"), false);

  assert.deepEqual(store.list(), ["claude-code", "codex-cli"]);
  assert.equal(changes, 2);
});

test("disconnect removes only that provider and leaves the rest in order", () => {
  const store = new ConnectedProviderStore(["claude-code", "codex-cli", "copilot-cli"]);
  let changes = 0;
  store.onChange = () => changes++;

  assert.equal(store.disconnect("codex-cli"), true);
  assert.deepEqual(store.list(), ["claude-code", "copilot-cli"]);

  // Disconnecting something that was never connected is not a change and must not persist.
  assert.equal(store.disconnect("codex-cli"), false);
  assert.equal(changes, 1);
});

test("isConnected answers for exactly the list, and list() hands back a copy", () => {
  const store = new ConnectedProviderStore(["opencode"]);
  assert.equal(store.isConnected("opencode"), true);
  assert.equal(store.isConnected("gemini-cli"), false);

  // Mutating what list() returned must not reach into the store - the sidebar holds this array.
  store.list().push("gemini-cli");
  assert.deepEqual(store.list(), ["opencode"]);
});

/* --------------------------------------------------------------------------
   Persistence round-trip. The list is only useful if it survives a restart.
   -------------------------------------------------------------------------- */

test("the connected list survives a save/load round-trip", () => {
  const dir = scratch();
  try {
    saveState(dir, {
      agents: [],
      history: [],
      archives: [],
      queues: [],
      sessions: [],
      rateLimits: [],
      chats: [],
      projects: [],
      settings: {} as never,
      coordination: {},
      mcpServers: [],
      connectedCliProviders: ["claude-code", "copilot-cli"],
    });
    assert.deepEqual(loadState(dir).connectedCliProviders, ["claude-code", "copilot-cli"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadState on a state file written before this feature existed connects nothing", () => {
  const dir = scratch();
  try {
    // Deliberately built by saving and then stripping the key, so this fixture is the real
    // on-disk shape rather than a hand-typed guess at it.
    saveState(dir, {
      agents: [],
      history: [],
      archives: [],
      queues: [],
      sessions: [],
      rateLimits: [],
      chats: [],
      projects: [],
      settings: {} as never,
      coordination: {},
      mcpServers: [],
      connectedCliProviders: ["claude-code"],
    });
    const path = join(dir, ".solace-state.json");
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    delete parsed.connectedCliProviders;
    writeFileSync(path, JSON.stringify(parsed));

    assert.deepEqual(loadState(dir).connectedCliProviders, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a brand-new install (no state file at all) connects nothing", () => {
  const dir = scratch();
  try {
    assert.deepEqual(loadState(dir).connectedCliProviders, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* --------------------------------------------------------------------------
   The catalogue. These assertions are about honesty, not about content:
   every card must offer either a real command or an explicit note, never a
   blank where a command should be.
   -------------------------------------------------------------------------- */

test("every connectable provider offers a sign-in command or says why there isn't one, with a source", () => {
  for (const p of CONNECTABLE_PROVIDERS) {
    assert.ok(p.name.trim(), `${p.provider} needs a name`);
    assert.ok(p.blurb.trim(), `${p.provider} needs a blurb`);
    assert.ok(p.installCommand.trim(), `${p.provider} needs an install command`);
    assert.ok(
      (p.signInCommand?.trim() || p.signInNote?.trim()),
      `${p.provider} must state how to sign in, even if the answer is "there is no command"`,
    );
    // The provenance line is what makes the command checkable rather than remembered.
    assert.ok(p.signInSource.trim(), `${p.provider} must record where its sign-in answer came from`);
  }
});

test("a sign-in command is never just the install command wearing a different label", () => {
  for (const p of CONNECTABLE_PROVIDERS) {
    if (!p.signInCommand) continue;
    assert.notEqual(p.signInCommand, p.installCommand, `${p.provider}'s sign-in command is its install command`);
    assert.ok(!p.signInCommand.startsWith("npm "), `${p.provider}'s sign-in command is an npm line`);
  }
});

test("the catalogue and the id guard agree, with no duplicates", () => {
  const ids = CONNECTABLE_PROVIDERS.map((p) => p.provider);
  assert.equal(new Set(ids).size, ids.length, "a provider is listed twice");
  for (const id of ids) {
    assert.equal(isConnectableProvider(id), true);
    assert.equal(connectableProvider(id)?.provider, id);
  }
  assert.equal(isConnectableProvider("custom"), false);
  assert.equal(isConnectableProvider("nope"), false);
});

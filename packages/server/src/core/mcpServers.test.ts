import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MCP_CATALOG, MCP_SERVER_NAME_PATTERN, RESERVED_MCP_SERVER_NAMES } from "@solace/shared";
import { listSecretValues, saveSecretCredential } from "./credentials";
import {
  McpServerStore,
  appliesToAgent,
  mcpServersForAgent,
  resolveMcpServers,
  sanitizeMcpServers,
  setMcpServerProvider,
  testMcpServer,
  toPublicMcpServer,
  validateMcpServer,
} from "./mcpServers";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "solace-mcp-"));
}

/* ------------------------------- validation ------------------------------- */

test("a reserved name is refused, because it would shadow a bridge we spawn every turn", () => {
  for (const name of RESERVED_MCP_SERVER_NAMES) {
    const result = validateMcpServer({ name, command: "node" }, []);
    assert.ok("error" in result, `"${name}" must be refused`);
  }
});

test("names are constrained to what both tool-id schemes can express", () => {
  // Claude/Qwen address a tool as mcp__<server>__<tool>; Copilot as <server>-<tool>. A name
  // with a space or a dot is ambiguous in at least one of them, and the failure mode is an
  // agent that cannot call the tool rather than any error we would see.
  assert.ok("error" in validateMcpServer({ name: "my server", command: "node" }, []));
  assert.ok("error" in validateMcpServer({ name: "My.Server", command: "node" }, []));
  assert.ok("value" in validateMcpServer({ name: "roblox-studio", command: "node" }, []));
});

test("a name is lowercased, so two entries cannot differ only by case", () => {
  const first = validateMcpServer({ name: "GitHub", command: "docker" }, []);
  assert.ok("value" in first);
  assert.equal(first.value.name, "github");
  assert.ok("error" in validateMcpServer({ name: "GITHUB", command: "docker" }, [{ ...first.value, id: "a", createdAt: "" }]));
});

test("a missing command is refused rather than saved as a server that can never start", () => {
  assert.ok("error" in validateMcpServer({ name: "x" }, []));
  assert.ok("error" in validateMcpServer({ name: "x", command: "   " }, []));
});

test("an invalid environment variable name is refused", () => {
  assert.ok("error" in validateMcpServer({ name: "x", command: "node", env: [{ name: "not a var", value: "1" }] }, []));
});

/* ------------------------------- redaction -------------------------------- */

test("a vault-referenced env value never leaves the server", () => {
  const server = toPublicMcpServer({
    id: "a",
    name: "github",
    transport: "stdio",
    command: "docker",
    args: [],
    env: [{ name: "GITHUB_PERSONAL_ACCESS_TOKEN", credentialId: "cred-1" }],
    enabled: true,
    scope: { kind: "global" },
    createdAt: "",
  });
  assert.deepEqual(server.env, [{ name: "GITHUB_PERSONAL_ACCESS_TOKEN", credentialId: "cred-1" }]);
  assert.equal(JSON.stringify(server).includes("value"), false);
});

test("redaction is fail-closed on a hand-edited entry carrying both forms", () => {
  // Only reachable by editing .solace-state.json by hand. The credential reference wins; the
  // literal is not echoed back out, the same way credentials.ts's toMeta never weakens to
  // accommodate an odd record.
  const server = toPublicMcpServer({
    id: "a",
    name: "x",
    transport: "stdio",
    command: "node",
    args: [],
    env: [{ name: "TOKEN", credentialId: "cred-1", value: "sk-leaked-inline" } as never],
    enabled: true,
    scope: { kind: "global" },
    createdAt: "",
  });
  assert.equal(JSON.stringify(server).includes("sk-leaked-inline"), false);
});

/* ------------------------------- resolution ------------------------------- */

const SERVER = {
  id: "a",
  name: "roblox-studio",
  transport: "stdio" as const,
  command: "cmd.exe",
  args: ["/c", "mcp.bat"],
  env: [],
  enabled: true,
  createdAt: "",
};

test("a per-agent server reaches only the agents it names", () => {
  const scoped = { ...SERVER, scope: { kind: "agents" as const, agentIds: ["studio-agent"] } };
  assert.equal(appliesToAgent(scoped, "studio-agent"), true);
  assert.equal(appliesToAgent(scoped, "someone-else"), false);
  // The whole reason scope exists: seven Roblox tools in every other agent's tool list is
  // noise they pay for in context on every turn they take.
  assert.deepEqual(resolveMcpServers([scoped], "someone-else", workspace()), []);
});

test("a disabled server reaches nobody, whatever its scope", () => {
  assert.equal(appliesToAgent({ ...SERVER, scope: { kind: "global" }, enabled: false }, "any"), false);
});

test("a vault-referenced env value is resolved at spawn time", () => {
  const root = workspace();
  try {
    const cred = saveSecretCredential(root, { label: "roblox open cloud", value: "rbx-live-TOKEN-123456" });
    const [resolved] = resolveMcpServers(
      [{ ...SERVER, scope: { kind: "global" }, env: [{ name: "ROBLOX_KEY", credentialId: cred.id }] }],
      "agent-1",
      root,
    );
    assert.equal(resolved.env.ROBLOX_KEY, "rbx-live-TOKEN-123456");

    // And the thing that makes a vault reference the SAFE option: the value is in the vault,
    // so listSecretValues already covers it - an agent echoing it into chat gets redacted
    // before that message is written to .solace-state.json. An inline literal would not be.
    assert.ok(listSecretValues(root).includes("rbx-live-TOKEN-123456"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a deleted credential omits the variable rather than setting it empty", () => {
  const root = workspace();
  try {
    const [resolved] = resolveMcpServers(
      [{ ...SERVER, scope: { kind: "global" }, env: [{ name: "TOKEN", credentialId: "gone" }] }],
      "agent-1",
      root,
    );
    // "" would look to the server like an authentication attempt that failed; absent looks
    // like missing configuration, which is what actually happened.
    assert.equal("TOKEN" in resolved.env, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* --------------------------------- store ---------------------------------- */

test("editing a server's launch drops its verification badge", () => {
  const store = new McpServerStore();
  const added = store.add({ name: "x", command: "node", args: ["a.js"] });
  assert.ok("server" in added);
  store.recordVerification(added.server.id, ["do_thing"]);
  assert.deepEqual(store.get(added.server.id)?.lastVerified?.tools, ["do_thing"]);

  // What was proven to list tools was the OLD command. Carrying the badge across would be
  // exactly the "configured, not verified" claim this feature exists not to make.
  store.update(added.server.id, { command: "python" });
  assert.equal(store.get(added.server.id)?.lastVerified, undefined);

  // A rename is not a relaunch, so that badge survives.
  store.recordVerification(added.server.id, ["do_thing"]);
  store.update(added.server.id, { note: "renamed note" });
  assert.deepEqual(store.get(added.server.id)?.lastVerified?.tools, ["do_thing"]);
});

test("removing an agent drops it from every per-agent scope", () => {
  const store = new McpServerStore();
  store.add({ name: "x", command: "node", scope: { kind: "agents", agentIds: ["a1", "a2"] } });
  store.forgetAgent("a1");
  assert.deepEqual(store.list()[0].scope, { kind: "agents", agentIds: ["a2"] });
});

/* ----------------------------- persistence load --------------------------- */

test("a hand-edited or older state file restores as no servers rather than throwing", () => {
  assert.deepEqual(sanitizeMcpServers(undefined), []);
  assert.deepEqual(sanitizeMcpServers(null), []);
  assert.deepEqual(sanitizeMcpServers("nonsense"), []);
  assert.deepEqual(sanitizeMcpServers([null, 5, {}]), []);
});

test("a reserved name written into the state file by hand is dropped on load", () => {
  const loaded = sanitizeMcpServers([{ id: "a", name: "solace", command: "evil" }, { id: "b", name: "ok", command: "node" }]);
  assert.deepEqual(
    loaded.map((s) => s.name),
    ["ok"],
  );
});

/* -------------------------------- registry -------------------------------- */

test("a throwing provider costs the turn nothing", () => {
  // A turn that would have run fine with the bridge alone must not die because the MCP store
  // is in a bad state.
  setMcpServerProvider(() => {
    throw new Error("boom");
  });
  assert.deepEqual(mcpServersForAgent("a"), []);
  setMcpServerProvider(undefined);
  assert.deepEqual(mcpServersForAgent("a"), []);
});

/* ------------------------------ live spawn -------------------------------- */

test("testMcpServer reports a command that does not exist rather than hanging", async () => {
  const result = await testMcpServer(
    { name: "nope", command: "solace-no-such-binary-xyz", args: [], env: {} },
    5000,
  );
  assert.equal(result.ok, false);
  assert.ok(result.error, "a failure must carry an explanation");
});

test("testMcpServer times out on a process that never speaks MCP", async () => {
  // node with a script that just sits there: it starts fine, so a liveness check would pass -
  // which is exactly why the test does a real handshake instead.
  const result = await testMcpServer(
    { name: "silent", command: process.execPath, args: ["-e", "setTimeout(()=>{}, 60000)"], env: {} },
    2000,
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /within 2s/);
});

test("testMcpServer completes a real MCP handshake and lists tools", async () => {
  // A minimal real stdio MCP server, inline: initialize -> notifications/initialized ->
  // tools/list. Proves the client half actually works, not just that failures are handled.
  const script = `
    let buf = "";
    process.stdin.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\\n")) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.method === "initialize") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake", version: "1.0" } } }) + "\\n");
        } else if (msg.method === "tools/list") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "insert_model" }, { name: "run_script" }] } }) + "\\n");
        }
      }
    });
  `;
  const result = await testMcpServer({ name: "fake", command: process.execPath, args: ["-e", script], env: {} }, 10_000);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.tools, ["insert_model", "run_script"]);
  assert.equal(result.serverInfo?.name, "fake");
});

/* -------------------------------- catalogue ------------------------------- */

test("every catalogue entry is shaped so it can actually be registered", () => {
  // The honesty rule for MCP_CATALOG is enforced by research, not by a unit test - a test
  // cannot tell a real package from an invented one. What it CAN pin is that no entry is
  // malformed in a way that would produce a server the user cannot save, and that every entry
  // carries the source URL that makes the claim checkable by hand later.
  // The upper bound is a sanity check, not a design limit - it started at 10 because that was
  // the size of the first research pass, and Blender made it 11. What matters is that the list
  // stays hand-verified: a bound loose enough to grow, tight enough that a bulk import of
  // unverified entries from some aggregator would trip it.
  assert.ok(MCP_CATALOG.length >= 3 && MCP_CATALOG.length <= 30, `3-30 entries, got ${MCP_CATALOG.length}`);
  for (const entry of MCP_CATALOG) {
    assert.ok(MCP_SERVER_NAME_PATTERN.test(entry.name), `${entry.name} is not a registrable name`);
    assert.ok(!(RESERVED_MCP_SERVER_NAMES as readonly string[]).includes(entry.name));
    assert.ok(entry.command.trim(), `${entry.name} has no command`);
    assert.match(entry.source, /^https:\/\//, `${entry.name} has no verifiable source URL`);
    assert.ok(entry.blurb.trim() && entry.title.trim());
    // A placeholder must actually appear in the args, or the UI would ask the user to replace
    // something that is not there.
    for (const placeholder of entry.placeholderArgs ?? []) {
      assert.ok(entry.args.includes(placeholder), `${entry.name}: placeholder "${placeholder}" is not in args`);
    }
    assert.ok("error" in validateMcpServer(entry, []) === false, `${entry.name} cannot be saved as-is`);
  }
});

test("catalogue names are unique", () => {
  assert.equal(new Set(MCP_CATALOG.map((e) => e.name)).size, MCP_CATALOG.length);
});

test("Roblox Studio is present, since it is the workflow this feature exists for", () => {
  const roblox = MCP_CATALOG.find((e) => e.name === "roblox-studio");
  assert.ok(roblox, "the motivating case must be in the catalogue");
  // And it must say plainly that Studio has to be open with the server switched on - a tile
  // that silently fails because Studio is closed is the exact dead end the honesty rule is
  // about.
  assert.ok(roblox.needsLocalApp, "it must state that Studio has to be running");
});

test("every entry needing a key or a local app says so", () => {
  for (const entry of MCP_CATALOG) {
    for (const env of entry.requiredEnv ?? []) {
      assert.ok(env.hint.trim(), `${entry.name}: ${env.name} has no hint about where the value comes from`);
    }
  }
});

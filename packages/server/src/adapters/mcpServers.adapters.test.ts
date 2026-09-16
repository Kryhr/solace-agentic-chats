import assert from "node:assert/strict";
import { test } from "node:test";
import { flagsForTrustLevel as claudeFlags } from "./claude-code";
import { buildQwenArgs } from "./qwen-code";
import { buildCopilotArgs } from "./copilot-cli";
import { solaceMcpConfigArgs as codexArgs } from "./codex-cli";
import { geminiSettings } from "./gemini-cli";
import type { ResolvedMcpServer } from "../core/mcpServers";

/**
 * The one invariant that matters for user-registered MCP servers, asserted once per provider:
 * the user's server survives injection AND the solace bridge is still there.
 *
 * Both halves are load-bearing and they fail in opposite directions. Lose the user's server and
 * the feature silently does nothing - the agent simply never has the tool and says so in a way
 * that reads like a model limitation. Lose `solace` and the agents stop being able to talk to
 * each other mid-turn, which is the entire point of this app. Each provider takes MCP config
 * through a DIFFERENT mechanism with different merge semantics (replace / additional / flat -c
 * overrides / a temp settings file), so this has to be proved five times, not once - exactly as
 * copilotArgs.test.ts and approvalMode.test.ts prove their per-provider flag vocabularies.
 */
const USER_SERVERS: ResolvedMcpServer[] = [
  {
    name: "roblox-studio",
    command: "cmd.exe",
    args: ["/c", "%LOCALAPPDATA%\\Roblox\\mcp.bat"],
    env: {},
  },
  {
    name: "github",
    command: "docker",
    args: ["run", "-i", "--rm", "ghcr.io/github/github-mcp-server"],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "resolved-from-vault" },
  },
];

const BASE = { agentId: "agent-1", serverPort: 4310, turnToken: "tok", newSessionId: "new-id" };

/** The JSON value that follows `flag` in an argv array. */
function jsonAfter(args: string[], flag: string): { mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> } {
  const at = args.indexOf(flag);
  assert.notEqual(at, -1, `${flag} missing from argv`);
  return JSON.parse(args[at + 1]);
}

test("claude-code: user servers are merged into the --mcp-config object alongside solace", () => {
  const args = claudeFlags("acceptEdits", USER_SERVERS);
  const config = jsonAfter(args, "--mcp-config");
  assert.ok(config.mcpServers.solace, "the group-chat bridge must survive");
  assert.ok(config.mcpServers["roblox-studio"], "the user's server must survive");
  assert.equal(config.mcpServers["github"].env?.GITHUB_PERSONAL_ACCESS_TOKEN, "resolved-from-vault");

  // Merging into the object is the ONLY thing that works here: --strict-mcp-config means this
  // JSON is the complete set of servers for the turn, so a server absent from it does not fall
  // back to the user's ~/.claude.json - it does not exist.
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(args.filter((a) => a === "--mcp-config").length, 1, "one config value, not two flags");
});

test("claude-code: manual mode keeps the approval bridge as well", () => {
  const config = jsonAfter(claudeFlags("manual", USER_SERVERS), "--mcp-config");
  assert.ok(config.mcpServers.solace);
  assert.ok(config.mcpServers["approval-bridge"], "manual mode's approval bridge must survive too");
  assert.ok(config.mcpServers["roblox-studio"]);
});

test("claude-code: a user server cannot displace either bridge", () => {
  // validateMcpServer rejects both reserved names at the write boundary; this is the second
  // line of defence, for a hand-edited state file that got past it.
  const config = jsonAfter(
    claudeFlags("manual", [{ name: "solace", command: "evil", args: [], env: {} }, ...USER_SERVERS]),
    "--mcp-config",
  );
  assert.notEqual(config.mcpServers.solace.command, "evil");
  assert.ok(config.mcpServers["roblox-studio"], "the legitimate servers still go through");
});

test("claude-code: user tools are NOT pre-allowed, only ours", () => {
  // Registering a server must not silently widen what an agent may do. Its tools go through
  // whatever --permission-mode the trust level set, like every other third-party tool.
  const args = claudeFlags("manual", USER_SERVERS);
  const allowed = args[args.indexOf("--allowedTools") + 1];
  assert.ok(allowed.includes("mcp__solace__post_to_group"));
  assert.ok(!allowed.includes("roblox"), "a user server's tools must not be pre-approved");
});

test("qwen-code: user servers are merged into --mcp-config alongside solace", () => {
  const config = jsonAfter(buildQwenArgs({ ...BASE, trustLevel: "acceptEdits", userServers: USER_SERVERS }), "--mcp-config");
  assert.ok(config.mcpServers.solace);
  assert.ok(config.mcpServers["roblox-studio"]);
  assert.equal(config.mcpServers["github"].env?.GITHUB_PERSONAL_ACCESS_TOKEN, "resolved-from-vault");
});

test("qwen-code: trust is set on our bridge only, never on a user server", () => {
  const config = jsonAfter(buildQwenArgs({ ...BASE, trustLevel: "manual", userServers: USER_SERVERS }), "--mcp-config") as unknown as {
    mcpServers: Record<string, { trust?: boolean }>;
  };
  assert.equal(config.mcpServers.solace.trust, true);
  assert.equal(config.mcpServers["roblox-studio"].trust, undefined, "a third-party server must not skip confirmations");
});

test("copilot-cli: user servers are merged into --additional-mcp-config alongside solace", () => {
  const args = buildCopilotArgs({
    ...BASE,
    loader: "C:\\npm\\node_modules\\@github\\copilot\\npm-loader.js",
    prompt: "do the thing",
    trustLevel: "acceptEdits",
    userServers: USER_SERVERS,
  });
  const config = jsonAfter(args, "--additional-mcp-config");
  assert.ok(config.mcpServers.solace);
  assert.ok(config.mcpServers["roblox-studio"]);
  assert.equal(config.mcpServers["github"].env?.GITHUB_PERSONAL_ACCESS_TOKEN, "resolved-from-vault");
});

test("copilot-cli: tools:[*] is set on our bridge only", () => {
  const args = buildCopilotArgs({
    ...BASE,
    loader: "loader.js",
    prompt: "x",
    trustLevel: "manual",
    userServers: USER_SERVERS,
  });
  const config = jsonAfter(args, "--additional-mcp-config") as unknown as { mcpServers: Record<string, { tools?: string[] }> };
  assert.deepEqual(config.mcpServers.solace.tools, ["*"]);
  assert.equal(config.mcpServers["roblox-studio"].tools, undefined);
});

test("codex-cli: user servers become their own -c overrides alongside solace's", () => {
  const args = codexArgs("agent-1", 4310, "tok", USER_SERVERS);
  // Codex has no config object at all - only flat dotted keys - so "merged" means "more keys".
  const pairs = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    assert.equal(args[i], "-c", "every codex override must be introduced by -c");
    const eq = args[i + 1].indexOf("=");
    pairs.set(args[i + 1].slice(0, eq), args[i + 1].slice(eq + 1));
  }
  assert.ok(pairs.has("mcp_servers.solace.command"), "the bridge must survive");
  assert.equal(pairs.get("mcp_servers.roblox-studio.command"), JSON.stringify("cmd.exe"));
  assert.equal(pairs.get("mcp_servers.roblox-studio.args"), JSON.stringify(["/c", "%LOCALAPPDATA%\\Roblox\\mcp.bat"]));
  // env goes one key at a time rather than as a whole table, so an override cannot wipe out
  // whatever the user's own ~/.codex/config.toml has under that server's env.
  assert.equal(pairs.get("mcp_servers.github.env.GITHUB_PERSONAL_ACCESS_TOKEN"), JSON.stringify("resolved-from-vault"));
});

test("codex-cli: every override value is valid JSON, so a Windows path cannot break the TOML", () => {
  const args = codexArgs("agent-1", 4310, undefined, USER_SERVERS);
  for (let i = 1; i < args.length; i += 2) {
    const value = args[i].slice(args[i].indexOf("=") + 1);
    assert.doesNotThrow(() => JSON.parse(value), `not JSON: ${args[i]}`);
  }
});

test("gemini-cli: user servers join solace in the system-defaults settings object", () => {
  const settings = geminiSettings("agent-1", 4310, "tok", USER_SERVERS) as {
    mcpServers: Record<string, { command: string; env?: Record<string, string>; trust?: boolean }>;
  };
  assert.ok(settings.mcpServers.solace);
  assert.ok(settings.mcpServers["roblox-studio"]);
  assert.equal(settings.mcpServers["github"].env?.GITHUB_PERSONAL_ACCESS_TOKEN, "resolved-from-vault");
  // Same rule as qwen: trust is ours to claim for our own bridge and nobody else's.
  assert.equal(settings.mcpServers.solace.trust, true);
  assert.equal(settings.mcpServers["roblox-studio"].trust, undefined);
});

test("every provider is unchanged when the user has registered nothing", () => {
  // A fresh install must produce byte-identical config to what it produced before this feature
  // existed - otherwise the blast radius of "registering MCP servers" includes every user who
  // never registered one.
  assert.deepEqual(Object.keys(jsonAfter(claudeFlags("acceptEdits"), "--mcp-config").mcpServers), ["solace"]);
  assert.deepEqual(
    Object.keys(jsonAfter(buildQwenArgs({ ...BASE, trustLevel: "acceptEdits" }), "--mcp-config").mcpServers),
    ["solace"],
  );
  assert.deepEqual(
    Object.keys(
      jsonAfter(buildCopilotArgs({ ...BASE, loader: "l.js", prompt: "x", trustLevel: "acceptEdits" }), "--additional-mcp-config")
        .mcpServers,
    ),
    ["solace"],
  );
  assert.deepEqual(Object.keys(geminiSettings("agent-1", 4310).mcpServers), ["solace"]);
  assert.ok(codexArgs("agent-1", 4310).every((a, i) => i % 2 === 1 || a === "-c"));
});

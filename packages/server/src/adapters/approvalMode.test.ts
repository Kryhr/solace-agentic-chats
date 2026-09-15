import assert from "node:assert/strict";
import { test } from "node:test";
import type { TrustLevel } from "@solace/shared";
import { buildGeminiArgs, geminiApprovalMode } from "./gemini-cli";
import { buildQwenArgs, qwenApprovalMode } from "./qwen-code";
import { getPermissionCatalog } from "../core/permissionCatalog";

// These two CLIs share an ancestor and spell the SAME mode differently - gemini takes
// "auto_edit", qwen takes "auto-edit" - and both use yargs `choices`, so the wrong spelling is
// a hard rejection before the turn ever starts. There is no runtime signal that would tell us
// apart from a turn that mysteriously never ran, so the spellings are pinned here.
// The authoritative lists came from the CLIs themselves, by handing each an invalid value:
//   gemini: "default", "auto_edit", "yolo", "plan"
//   qwen:   "plan", "default", "auto-edit", "auto", "yolo"
const GEMINI_CHOICES = new Set(["default", "auto_edit", "yolo", "plan"]);
const QWEN_CHOICES = new Set(["plan", "default", "auto-edit", "auto", "yolo"]);

const ALL_LEVELS: TrustLevel[] = ["plan", "manual", "acceptEdits", "bypassPermissions", "auto"];

test("every trust level maps to a mode the CLI actually accepts", () => {
  for (const level of ALL_LEVELS) {
    assert.ok(
      GEMINI_CHOICES.has(geminiApprovalMode(level)),
      `gemini rejects "${geminiApprovalMode(level)}" for ${level}`,
    );
    assert.ok(QWEN_CHOICES.has(qwenApprovalMode(level)), `qwen rejects "${qwenApprovalMode(level)}" for ${level}`);
  }
});

test("gemini uses the underscore spelling and qwen the hyphen spelling", () => {
  assert.equal(geminiApprovalMode("acceptEdits"), "auto_edit");
  assert.equal(qwenApprovalMode("acceptEdits"), "auto-edit");
});

test("qwen keeps auto distinct from yolo, gemini cannot", () => {
  // Qwen's "auto" is a real mode (an LLM classifier judges each tool call), so it must not be
  // flattened into yolo. Gemini has no such mode, so "auto" widening to yolo is the honest
  // approximation - and permissionCatalog therefore must not offer "auto" for gemini at all,
  // or the UI would show two differently-named options that do exactly the same thing.
  assert.equal(qwenApprovalMode("auto"), "auto");
  assert.notEqual(qwenApprovalMode("auto"), qwenApprovalMode("bypassPermissions"));
  assert.equal(geminiApprovalMode("auto"), "yolo");
  assert.equal(geminiApprovalMode("auto"), geminiApprovalMode("bypassPermissions"));
});

test("the least-trusting levels never map to an auto-approving mode", () => {
  // The direction that actually matters: a mapping bug here would silently let an agent the
  // user put in plan mode write files.
  for (const mode of [geminiApprovalMode("plan"), qwenApprovalMode("plan")]) {
    assert.equal(mode, "plan");
  }
  for (const mode of [geminiApprovalMode("manual"), qwenApprovalMode("manual")]) {
    assert.equal(mode, "default");
  }
});

test("the permission catalog only offers modes the mapping can honour", () => {
  const catalog = Object.fromEntries(getPermissionCatalog().map((info) => [info.provider, info.availableModes]));
  assert.deepEqual(catalog["gemini-cli"], ["plan", "manual", "acceptEdits", "bypassPermissions"]);
  assert.deepEqual(catalog["qwen-code"], ["plan", "manual", "acceptEdits", "bypassPermissions", "auto"]);
  // "auto" being absent for gemini is the whole point of the entry above - assert it directly
  // so re-adding it has to be a deliberate act rather than a copy-paste from the qwen line.
  assert.ok(!catalog["gemini-cli"].includes("auto"));
});

const QWEN_ARG_BASE = { agentId: "agent-1", serverPort: 4310, newSessionId: "new-id" };

test("a first turn registers a session id, a later turn resumes it", () => {
  const gFirst = buildGeminiArgs({ trustLevel: "plan", newSessionId: "new-id" });
  assert.deepEqual(gFirst.slice(gFirst.indexOf("--session-id"), gFirst.indexOf("--session-id") + 2), [
    "--session-id",
    "new-id",
  ]);
  assert.ok(!gFirst.includes("--resume"));

  const gLater = buildGeminiArgs({ trustLevel: "plan", sessionId: "old-id", newSessionId: "new-id" });
  assert.deepEqual(gLater.slice(gLater.indexOf("--resume"), gLater.indexOf("--resume") + 2), ["--resume", "old-id"]);
  // Passing both is not merely redundant: --session-id means "start a NEW session with this
  // UUID", so sending it alongside --resume is a contradiction the CLI has to resolve for us.
  assert.ok(!gLater.includes("--session-id"));

  const qLater = buildQwenArgs({ ...QWEN_ARG_BASE, trustLevel: "plan", sessionId: "old-id" });
  assert.deepEqual(qLater.slice(qLater.indexOf("--resume"), qLater.indexOf("--resume") + 2), ["--resume", "old-id"]);
  assert.ok(!qLater.includes("--session-id"));
});

test("neither adapter ever resumes a project-scoped 'latest' session", () => {
  // The bug this guards against is silent and cross-agent: gemini's `--resume latest` and
  // qwen's `-c/--continue` both resume the most recent session for the PROJECT, so two agents
  // of the same provider in one workspace would inherit each other's conversation.
  for (const args of [
    buildGeminiArgs({ trustLevel: "auto", newSessionId: "new-id" }),
    buildGeminiArgs({ trustLevel: "auto", sessionId: "old-id", newSessionId: "new-id" }),
  ]) {
    assert.ok(!args.includes("latest"));
  }
  for (const args of [
    buildQwenArgs({ ...QWEN_ARG_BASE, trustLevel: "auto" }),
    buildQwenArgs({ ...QWEN_ARG_BASE, trustLevel: "auto", sessionId: "old-id" }),
  ]) {
    assert.ok(!args.includes("-c") && !args.includes("--continue"));
  }
});

test("no argument ever contains a newline", () => {
  // Both CLIs resolve to a .cmd shim on Windows, where cmd.exe truncates the command line at
  // the first newline and silently discards the rest - spawnCli throws on this for exactly that
  // reason. The mcp-config JSON is the live risk here: JSON.stringify with an indent argument
  // would introduce newlines and break every qwen turn with no error message.
  const args = [
    ...buildGeminiArgs({ trustLevel: "manual", model: "gemini-2.5-pro", newSessionId: "new-id" }),
    ...buildQwenArgs({ ...QWEN_ARG_BASE, trustLevel: "manual", model: "coder-model", turnToken: "tok" }),
  ];
  for (const arg of args) assert.ok(!/[\r\n]/.test(arg), `newline in argument: ${JSON.stringify(arg)}`);
});

test("the qwen mcp config carries the bridge identity the server checks", () => {
  const args = buildQwenArgs({ ...QWEN_ARG_BASE, trustLevel: "manual", turnToken: "tok-123" });
  const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
  const solace = config.mcpServers.solace;
  // Without these the bridge has no identity and the server refuses every tool call, which
  // presents as an agent that simply never talks to the group rather than as an error.
  assert.equal(solace.env.SOLACE_AGENT_ID, "agent-1");
  assert.equal(solace.env.SOLACE_SERVER_PORT, "4310");
  assert.equal(solace.env.SOLACE_TURN_TOKEN, "tok-123");
  // No turn token must mean the key is absent, not present-and-empty: an empty string would be
  // sent as a real credential and rejected, instead of the server seeing none at all.
  const noToken = buildQwenArgs({ ...QWEN_ARG_BASE, trustLevel: "manual" });
  const withoutToken = JSON.parse(noToken[noToken.indexOf("--mcp-config") + 1]);
  assert.ok(!("SOLACE_TURN_TOKEN" in withoutToken.mcpServers.solace.env));
});

test("the prompt has no way of reaching argv", () => {
  // buildGeminiArgs/buildQwenArgs deliberately take no prompt parameter. `-p ""` is the flag
  // that forces headless mode; the text itself is written to stdin by runTurn.
  const args = buildQwenArgs({ ...QWEN_ARG_BASE, trustLevel: "plan" });
  assert.equal(args[args.indexOf("-p") + 1], "");
});

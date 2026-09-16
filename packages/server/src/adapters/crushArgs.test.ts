import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TrustLevel } from "@solace/shared";
import {
  buildCrushArgs,
  buildCrushConfig,
  defaultGlobalConfigDir,
  disabledToolsForTrustLevel,
  eventsFromSession,
  isNoProviderError,
  pickNewSession,
  writeTurnConfigDir,
  type CrushSessionDetail,
} from "./crush";

/**
 * Crush's ACTUAL headless tool inventory, read back out of the real v0.95.0 binary by having a
 * turn call a tool that does not exist; Crush answered with the full list. Pinned here because
 * a typo in disabledToolsForTrustLevel fails silently: Crush does not reject an unknown name in
 * disabled_tools, it just leaves the real tool enabled, so a misspelled "bash" would hand a
 * plan-mode agent a shell and nothing anywhere would say so.
 */
const REAL_TOOLS = new Set([
  "agent", "agentic_fetch", "bash", "crush_info", "crush_logs", "download", "edit", "fetch",
  "glob", "grep", "job_kill", "job_output", "list_mcp_resources", "ls", "lsp_call_hierarchy",
  "lsp_definition", "lsp_diagnostics", "lsp_references", "lsp_rename", "lsp_replace_symbol",
  "lsp_restart", "lsp_symbols", "multiedit", "read_mcp_resource", "sourcegraph", "todos",
  "view", "write",
]);

/* -------------------------------------------------------------------------- */
/* Trust levels                                                               */
/* -------------------------------------------------------------------------- */

test("every disabled tool is a tool Crush actually has", () => {
  for (const level of ["plan", "acceptEdits", "bypassPermissions"] as TrustLevel[]) {
    for (const tool of disabledToolsForTrustLevel(level)) {
      assert.ok(REAL_TOOLS.has(tool), `${level} disables unknown tool "${tool}"`);
    }
  }
});

test("plan mode can neither write nor run a shell command", () => {
  // Verified behaviourally against the real CLI: with these disabled, a turn whose model called
  // `write` got back "tool not found: write. Available tools: ..." and the file was NOT created
  // on disk. Without them the identical turn wrote the file with no approval of any kind.
  const disabled = disabledToolsForTrustLevel("plan");
  for (const tool of ["write", "edit", "multiedit", "bash", "download", "agent"]) {
    assert.ok(disabled.includes(tool), `plan must disable ${tool}`);
  }
});

test("acceptEdits allows edits but still removes the shell", () => {
  const disabled = disabledToolsForTrustLevel("acceptEdits");
  assert.ok(disabled.includes("bash"));
  assert.ok(disabled.includes("download"));
  // A sub-agent would be a way back to a shell, so it goes with bash rather than with edits.
  assert.ok(disabled.includes("agent"));
  assert.ok(!disabled.includes("write"));
  assert.ok(!disabled.includes("edit"));
  assert.ok(!disabled.includes("multiedit"));
});

test("bypassPermissions disables nothing", () => {
  assert.deepEqual(disabledToolsForTrustLevel("bypassPermissions"), []);
});

test("plan is strictly more restrictive than acceptEdits, which is stricter than bypass", () => {
  const plan = new Set(disabledToolsForTrustLevel("plan"));
  const accept = disabledToolsForTrustLevel("acceptEdits");
  for (const tool of accept) assert.ok(plan.has(tool), `plan must also disable ${tool}`);
  assert.ok(plan.size > accept.length);
});

/* -------------------------------------------------------------------------- */
/* Argv                                                                       */
/* -------------------------------------------------------------------------- */

test("the prompt is never an argv element", () => {
  const prompt = "line one\nline two with a \" quote";
  const args = buildCrushArgs({ cwd: "C:\\repo", model: "openai/gpt-5", effort: "high" });
  for (const arg of args) {
    assert.ok(!arg.includes(prompt), "prompt leaked into argv");
    assert.ok(!/[\r\n]/.test(arg), `argv element contains a newline: ${arg}`);
  }
});

test("a first turn asks for no session, a resumed turn passes the id Crush minted", () => {
  assert.ok(!buildCrushArgs({ cwd: "C:\\repo" }).includes("-s"));
  const resumed = buildCrushArgs({ cwd: "C:\\repo", sessionId: "b03dbea68686d1b9" });
  assert.deepEqual(resumed.slice(-2), ["-s", "b03dbea68686d1b9"]);
});

test("args start with the non-interactive subcommand and suppress the spinner", () => {
  const args = buildCrushArgs({ cwd: "C:\\repo" });
  assert.deepEqual(args.slice(0, 2), ["run", "-q"]);
  // --cwd is passed as well as being set on the spawn, because `crush run` resolves its project
  // (and therefore which sessions exist) from this flag.
  assert.deepEqual(args.slice(2, 4), ["--cwd", "C:\\repo"]);
});

test("model and effort use the flags crush run actually defines", () => {
  const args = buildCrushArgs({ cwd: "/repo", model: "anthropic/claude-opus-4-5", effort: "medium" });
  assert.ok(args.includes("-m"));
  assert.equal(args[args.indexOf("-m") + 1], "anthropic/claude-opus-4-5");
  // NOT "--effort" - `crush run --help` names it --reasoning-effort, and Crush rejects an
  // unknown flag outright ("Unknown flag: --yolo" is how --yolo was ruled out).
  assert.ok(args.includes("--reasoning-effort"));
  assert.ok(!args.includes("--effort"));
});

test("no trust level ever produces a --yolo flag", () => {
  // `crush run --yolo` is rejected by the CLI: --yolo exists only on the interactive TUI root
  // command. Passing it would fail every turn before it started.
  for (const level of ["plan", "acceptEdits", "bypassPermissions"] as TrustLevel[]) {
    const args = [...buildCrushArgs({ cwd: "/r" }), ...disabledToolsForTrustLevel(level)];
    assert.ok(!args.includes("--yolo"));
  }
});

/* -------------------------------------------------------------------------- */
/* Config                                                                     */
/* -------------------------------------------------------------------------- */

test("the solace bridge is registered at every trust level, in Crush's own MCP shape", () => {
  for (const level of ["plan", "acceptEdits", "bypassPermissions"] as TrustLevel[]) {
    const config = buildCrushConfig(level);
    const solace = config.mcp?.solace;
    assert.ok(solace, `${level} lost the solace bridge`);
    // Verified live: this shape made mcp_solace_post_to_group appear in Crush's real tool list.
    assert.equal(solace!.type, "stdio");
    assert.equal(solace!.command, "node");
    assert.ok(solace!.args[0].endsWith("solaceBridge.mjs"));
  }
});

test("a user MCP server cannot displace the bridges", () => {
  const config = buildCrushConfig("plan", [
    { name: "solace", command: "evil", args: [], env: {} },
    { name: "approval-bridge", command: "evil", args: [], env: {} },
    { name: "playwright", command: "npx", args: ["-y", "@playwright/mcp"], env: { X: "1" } },
  ]);
  assert.equal(config.mcp!.solace.command, "node");
  assert.ok(!config.mcp!["approval-bridge"]);
  assert.equal(config.mcp!.playwright.command, "npx");
  assert.deepEqual(config.mcp!.playwright.env, { X: "1" });
});

test("no allowed_tools is written, because headless Crush ignores it", () => {
  // permissions.allowed_tools is a PRE-APPROVAL list, not a restriction: with
  // allowed_tools:["view"] set, a `write` call still created the file. Writing one would imply
  // a gate that does not exist.
  for (const level of ["plan", "acceptEdits", "bypassPermissions"] as TrustLevel[]) {
    assert.equal((buildCrushConfig(level) as Record<string, unknown>).permissions, undefined);
  }
});

test("disabled_tools is only written when it restricts something", () => {
  assert.deepEqual(buildCrushConfig("plan").options?.disabled_tools, disabledToolsForTrustLevel("plan"));
  assert.equal(buildCrushConfig("bypassPermissions").options, undefined);
});

test("the turn config never touches the user's own crush.json", () => {
  const userDir = mkdtempSync(join(tmpdir(), "crush-user-"));
  const userConfig = join(userDir, "crush.json");
  const original = JSON.stringify({ providers: { mine: { type: "openai-compat" } }, options: { auto_lsp: false } });
  writeFileSync(userConfig, original, "utf8");

  const turnDir = writeTurnConfigDir(buildCrushConfig("plan"), userDir);
  try {
    assert.equal(readFileSync(userConfig, "utf8"), original, "user config was modified");
    assert.notEqual(turnDir, userDir);
    const written = JSON.parse(readFileSync(join(turnDir, "crush.json"), "utf8"));
    // The user's providers survive, or the turn would have no way to authenticate.
    assert.ok(written.providers.mine);
    // ...and so do their other options, merged with ours rather than replaced by them.
    assert.equal(written.options.auto_lsp, false);
    assert.deepEqual(written.options.disabled_tools, disabledToolsForTrustLevel("plan"));
    assert.ok(written.mcp.solace);
  } finally {
    rmSync(turnDir, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  }
});

test("a malformed user config does not take the turn down with it", () => {
  const userDir = mkdtempSync(join(tmpdir(), "crush-user-"));
  writeFileSync(join(userDir, "crush.json"), "{ not json", "utf8");
  const turnDir = writeTurnConfigDir(buildCrushConfig("plan"), userDir);
  try {
    const written = JSON.parse(readFileSync(join(turnDir, "crush.json"), "utf8"));
    assert.deepEqual(written.options.disabled_tools, disabledToolsForTrustLevel("plan"));
  } finally {
    rmSync(turnDir, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  }
});

test("the global config dir is a DIRECTORY, per Crush's own resolution", () => {
  // Pointing CRUSH_GLOBAL_CONFIG at the crush.json FILE was tested and fails with
  // "No providers configured", so this must never resolve to a file path.
  assert.equal(defaultGlobalConfigDir({ CRUSH_GLOBAL_CONFIG: "/x/y" } as NodeJS.ProcessEnv), "/x/y");
  assert.equal(defaultGlobalConfigDir({ XDG_CONFIG_HOME: join("/cfg") } as NodeJS.ProcessEnv), join("/cfg", "crush"));
  assert.equal(defaultGlobalConfigDir({ HOME: "/home/k" } as NodeJS.ProcessEnv), join("/home/k", ".config", "crush"));
  assert.equal(defaultGlobalConfigDir({} as NodeJS.ProcessEnv), undefined);
});

/* -------------------------------------------------------------------------- */
/* Session JSON -> events                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A REAL `crush session show --json` document, captured verbatim from crush v0.95.0 driven by
 * this adapter's own flags (the tool call and its result are the real ones Crush recorded when
 * it executed bash headlessly with no approval).
 */
const REAL_SESSION: CrushSessionDetail = {
  meta: {
    id: "434ac585b582aaaa",
    uuid: "74833265-11e2-424e-8f53-19214e43bfe7",
    title: "OK-FROM-FAKE",
    cost: 0,
    prompt_tokens: 123,
    completion_tokens: 45,
    total_tokens: 168,
  },
  messages: [
    { id: "cb810646", role: "user", parts: [{ type: "text", text: "Run bash" }, { type: "finish" }] },
    {
      id: "65616880",
      role: "assistant",
      model: "fake-model",
      provider: "fake",
      parts: [
        {
          type: "tool_call",
          name: "bash",
          input: '{"command":"echo hello-from-tool","description":"print a greeting"}',
        },
        { type: "finish" },
      ],
    },
    {
      id: "6e6d8dba",
      role: "tool",
      parts: [{ type: "tool_result", name: "bash", content: "hello-from-tool" }, { type: "finish" }],
    },
    {
      id: "df1314e9",
      role: "assistant",
      model: "fake-model",
      provider: "fake",
      parts: [{ type: "text", text: "OK-FROM-FAKE" }, { type: "finish" }],
    },
  ],
};

test("a real session document replays as model, tool-use, text, usage - in that order", () => {
  const events = eventsFromSession(REAL_SESSION);
  assert.deepEqual(events.map((e) => e.type), ["model", "tool-use", "text", "usage"]);
});

test("the model is reported as provider/model, the form crush -m accepts", () => {
  const [model] = eventsFromSession(REAL_SESSION);
  assert.deepEqual(model, { type: "model", model: "fake/fake-model" });
});

test("tool arguments are parsed out of Crush's JSON string into a real object", () => {
  const toolUse = eventsFromSession(REAL_SESSION).find((e) => e.type === "tool-use");
  assert.ok(toolUse && toolUse.type === "tool-use");
  assert.equal(toolUse.toolName, "bash");
  // Crush stores `input` as a string; toolLabel.ts needs the values, not the JSON text.
  assert.deepEqual(toolUse.input, { command: "echo hello-from-tool", description: "print a greeting" });
});

test("usage comes from Crush's own totals, not a number invented here", () => {
  const usage = eventsFromSession(REAL_SESSION).find((e) => e.type === "usage");
  assert.ok(usage && usage.type === "usage");
  assert.equal(usage.usage.inputTokens, 123);
  assert.equal(usage.usage.outputTokens, 45);
  assert.equal(usage.usage.totalCostUsd, 0);
});

test("a resumed session replays only the new turn, not the whole history", () => {
  // Observed for real before the cut existed: resuming a two-turn session re-emitted the first
  // turn's answer, so the chat showed "OK-FROM-FAKE" twice. The boundary is the LAST user
  // message, taken from the document rather than remembered in this process, so it survives a
  // server restart mid-conversation.
  const twoTurns: CrushSessionDetail = {
    meta: REAL_SESSION.meta,
    messages: [
      ...REAL_SESSION.messages,
      { id: "u2", role: "user", parts: [{ type: "text", text: "follow up" }] },
      { id: "a2", role: "assistant", model: "fake-model", provider: "fake", parts: [{ type: "text", text: "SECOND" }] },
    ],
  };
  const events = eventsFromSession(twoTurns);
  assert.deepEqual(events.map((e) => e.type), ["model", "text", "usage"]);
  const texts = events.filter((e) => e.type === "text");
  assert.equal(texts.length, 1);
  assert.ok(texts[0].type === "text" && texts[0].text === "SECOND");
});

test("a document with no user message at all still replays rather than dropping the turn", () => {
  const events = eventsFromSession({
    meta: { id: "x", uuid: "x" },
    messages: [{ id: "a", role: "assistant", model: "m", parts: [{ type: "text", text: "answer" }] }],
  });
  assert.ok(events.some((e) => e.type === "text"));
});

test("a tool_result never becomes a second tool-use", () => {
  // The "tool" role message carries the OUTPUT of the call already reported from the assistant
  // message. Emitting it again would double every tool call in the UI.
  assert.equal(eventsFromSession(REAL_SESSION).filter((e) => e.type === "tool-use").length, 1);
});

test("reasoning parts are reported as reasoning, never as plain answer text", () => {
  const events = eventsFromSession({
    meta: { id: "x", uuid: "x" },
    messages: [
      {
        id: "m1",
        role: "assistant",
        model: "m",
        parts: [{ type: "reasoning", text: "thinking out loud" }, { type: "text", text: "answer" }],
      },
    ],
  });
  assert.deepEqual(events.map((e) => e.type), ["model", "reasoning", "text"]);
});

test("an empty session produces no usage event rather than a zeroed fake one", () => {
  assert.deepEqual(eventsFromSession({ meta: { id: "x", uuid: "x" }, messages: [] }), []);
});

/* -------------------------------------------------------------------------- */
/* Session discovery                                                          */
/* -------------------------------------------------------------------------- */

test("the session created by this turn is the one that was not there before", () => {
  const before = [{ id: "old", uuid: "u1", modified: "2026-09-16T12:00:00-04:00" }];
  const after = [
    { id: "old", uuid: "u1", modified: "2026-09-16T12:00:00-04:00" },
    { id: "new", uuid: "u2", modified: "2026-09-16T12:05:00-04:00" },
  ];
  assert.equal(pickNewSession(before, after)?.id, "new");
});

test("with several new sessions the newest wins, and a stale one never does", () => {
  const after = [
    { id: "a", uuid: "u1", modified: "2026-09-16T12:09:00-04:00" },
    { id: "b", uuid: "u2", modified: "2026-09-16T12:01:00-04:00" },
  ];
  assert.equal(pickNewSession([], after)?.id, "a");
});

test("no sessions at all yields undefined rather than a fabricated id", () => {
  assert.equal(pickNewSession([], []), undefined);
});

/* -------------------------------------------------------------------------- */
/* Auth                                                                       */
/* -------------------------------------------------------------------------- */

test("the signed-out failure is recognised from Crush's own wording", () => {
  // Captured verbatim from a real `crush run` with no provider configured (exit code 1).
  assert.ok(isNoProviderError("ERROR\n\n  No providers configured - please run 'crush' to set up a provider interactively."));
  assert.ok(!isNoProviderError("some other failure"));
});

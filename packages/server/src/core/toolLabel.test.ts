import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  KNOWN_ACTION_NAMES,
  KNOWN_TOOL_NAMES,
  activityLabel,
  basename,
  classifyToolCall,
  commandHead,
  describeToolCall,
  humanizeToolName,
} from "./toolLabel";

/**
 * These tests are the guard on the one honesty rule in toolLabel.ts: a label is derived from the
 * tool name and arguments a provider actually sent, and an unrecognised tool falls back to that
 * provider's own name rather than to a guess about what the tool probably does.
 *
 * The argument shapes below are the real ones emitted by the adapters in ../adapters - Claude
 * Code's `file_path`, Gemini CLI's `absolute_path`, Codex's whole `command_execution` item - not
 * invented examples, so a provider changing its schema fails here rather than silently
 * degrading every label in the hub to "Working".
 */

test("basename handles both separators and returns the input when there is no separator", () => {
  assert.equal(basename("C:\\Users\\k\\repo\\packages\\web\\src\\styles.css"), "styles.css");
  assert.equal(basename("/home/k/repo/src/index.ts"), "index.ts");
  assert.equal(basename("styles.css"), "styles.css");
  assert.equal(basename("/trailing/slash/"), "slash");
});

test("commandHead strips paths, quotes and windows extensions", () => {
  assert.equal(commandHead("npm run build"), "npm");
  assert.equal(commandHead('"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command x'), "powershell");
  assert.equal(commandHead("  git   status "), "git");
  assert.equal(commandHead(""), undefined);
});

test("humanizeToolName turns an identifier into words without inventing any", () => {
  assert.equal(humanizeToolName("search_file_content"), "Search file content");
  assert.equal(humanizeToolName("TodoWrite"), "Todo write");
  assert.equal(humanizeToolName("command_execution"), "Command execution");
});

test("Claude Code file tools label by basename, not by full path", () => {
  assert.equal(describeToolCall("Read", { file_path: "C:\\repo\\packages\\web\\src\\styles.css" }).label, "Reading styles.css");
  assert.equal(describeToolCall("Edit", { file_path: "/repo/src/styles.css" }).label, "Editing styles.css");
  assert.equal(describeToolCall("Write", { file_path: "/repo/README.md" }).label, "Writing README.md");
});

test("Gemini CLI's different argument spelling reaches the same label", () => {
  assert.equal(describeToolCall("read_file", { absolute_path: "/repo/src/a.ts" }).label, "Reading a.ts");
  assert.equal(describeToolCall("replace", { file_path: "/repo/src/a.ts" }).label, "Editing a.ts");
  assert.equal(describeToolCall("search_file_content", { pattern: "onEvent" }).label, "Searching for onEvent");
});

test("shell tools are labelled by the program being run, and keep the full command in detail", () => {
  const summary = describeToolCall("Bash", { command: "npm run build --workspace=packages/web" });
  assert.equal(summary.label, "Running npm");
  assert.equal(summary.detail, "npm run build --workspace=packages/web");
});

test("a missing argument degrades to a generic label rather than an invented one", () => {
  assert.equal(describeToolCall("Read", {}).label, "Reading a file");
  assert.equal(describeToolCall("Bash", {}).label, "Running a command");
  assert.equal(describeToolCall("Grep", {}).label, "Searching files");
});

test("an unknown tool falls back to the provider's own name, humanised", () => {
  // The important part is the absence of a claim: nothing here asserts what `FrobnicateWidget`
  // does, because nothing knows.
  assert.equal(describeToolCall("FrobnicateWidget", { x: 1 }).label, "Frobnicate widget");
  assert.equal(describeToolCall("FrobnicateWidget", { x: 1 }).name, "FrobnicateWidget");
  assert.equal(describeToolCall("FrobnicateWidget", { x: 1 }).detail, 'FrobnicateWidget({"x":1})');
});

test("an MCP tool is labelled by its server", () => {
  assert.equal(describeToolCall("mcp__github__create_issue", { title: "x" }).label, "Using github");
});

test("exitCode is only set when the provider actually reported a number", () => {
  assert.equal(describeToolCall("command_execution", { command: "ls", exit_code: 0 }).exitCode, 0);
  assert.equal(describeToolCall("command_execution", { command: "ls", exit_code: 2 }).exitCode, 2);
  // status "in_progress" carries exit_code: null - that must not read as a clean exit.
  assert.equal(describeToolCall("command_execution", { command: "ls", exit_code: null }).exitCode, undefined);
  assert.equal(describeToolCall("Bash", { command: "ls" }).exitCode, undefined);
});

test("captured command output is clipped, and the clipping is stated in the text", () => {
  const detail = describeToolCall("command_execution", {
    command: "ls",
    aggregated_output: "x".repeat(5000),
  }).detail;
  assert.ok(detail.length < 5000, "output should be clipped");
  assert.match(detail, /truncated, 1000 more characters/);
});

test("argument values are never clipped - the old _used …_ line stored them whole", () => {
  const long = "y".repeat(9000);
  const detail = describeToolCall("Write", { file_path: "/a.txt", content: long }).detail;
  assert.ok(detail.includes(long), "argument values must survive intact");
});

test("codex file_change is labelled from the real paths it reports", () => {
  assert.equal(describeToolCall("file_change", { changes: [{ path: "/repo/src/styles.css" }] }).label, "Editing styles.css");
  assert.equal(
    describeToolCall("file_change", { changes: [{ path: "/a.ts" }, { path: "/b.ts" }, { path: "/c.ts" }] }).label,
    "Editing 3 files",
  );
  assert.equal(describeToolCall("file_change", {}).label, "Editing files");
});

test("activityLabel reports the latest call and never synthesises a summary of the run", () => {
  const summaries = [
    describeToolCall("Read", { file_path: "/a.ts" }),
    describeToolCall("Read", { file_path: "/b.ts" }),
    describeToolCall("Bash", { command: "npm test" }),
  ];
  assert.equal(activityLabel(summaries), "Running npm");
  assert.equal(activityLabel([]), "Working");
});

test("describeToolCall survives input it cannot serialise or recognise", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(describeToolCall("Weird", circular).detail, "Weird");
  assert.equal(describeToolCall("", undefined).name, "unknown");
  assert.equal(describeToolCall("Bash", "not-an-object").label, "Running a command");
});

/**
 * Replays a stream recorded from a real `codex exec --json` turn (two shell calls, a line of
 * narration, then a final answer). Before this work every one of those shell calls reached the
 * hub as the literal string "command_execution"; this asserts the real command is what drives
 * the label now.
 */
test("real recorded codex stream produces labels from the real commands", () => {
  const raw = readFileSync(join(import.meta.dirname, "__fixtures__codex-stream.jsonl"), "utf8").replace(/\r\n/g, "\n");
  const labels: string[] = [];
  let agentMessages = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (event.type !== "item.completed" || !event.item) continue;
    if (event.item.type === "agent_message") {
      agentMessages += 1;
      continue;
    }
    labels.push(describeToolCall(event.item.type, event.item).label);
  }
  assert.equal(agentMessages, 2, "fixture should contain one narration line and one final answer");
  assert.deepEqual(labels, ["Running powershell", "Running powershell"]);
  assert.ok(!labels.includes("command_execution"), "the raw item type must never be the label");
});

/**
 * Copilot CLI's tool vocabulary is its own again - names taken from the tool table in a real
 * turn's session.usage_checkpoint event, and arguments from the toolRequests it actually
 * emitted. The shell tool is named after the shell, which is why "powershell" has to be a
 * first-class entry rather than reaching the generic fallback.
 */
test("copilot's own tool names produce real labels, not identifiers", () => {
  assert.equal(
    describeToolCall("powershell", { command: "echo hello-copilot", description: "Run requested echo command" }).label,
    "Running echo",
  );
  assert.equal(describeToolCall("view", { path: "/repo/src/index.ts" }).label, "Reading index.ts");
  assert.equal(describeToolCall("rg", { pattern: "TODO" }).label, "Searching for TODO");
  assert.equal(describeToolCall("apply_patch", { path: "/repo/notes.md" }).label, "Editing notes.md");
  assert.equal(describeToolCall("stop_powershell", {}).label, "Stopping a running command");
  // Copilot addresses MCP tools as <server>-<tool>, so the group-chat bridge has to be
  // recognised through that spelling too, not only Claude's mcp__server__tool form.
  assert.equal(describeToolCall("solace-post_to_group", { text: "hi" }).label, "Using solace");
  assert.equal(describeToolCall("mcp__solace__post_to_group", { text: "hi" }).label, "Using solace");
  // A hyphenated name that is NOT one of our servers must not be invented into one.
  assert.equal(describeToolCall("fetch_copilot_cli_documentation", {}).label, "Fetch copilot cli documentation");
});

/**
 * The label table and the action table are two views of the same provider vocabulary, and the
 * progress digest counts from the second one. A name present in one and missing from the other
 * is the drift that would make a digest silently report "0 files written" for a whole provider
 * while the hub went on labelling its writes perfectly - a wrong number, posted to the group,
 * with nothing visibly broken.
 */
test("every tool the label table knows also has an action category, and vice versa", () => {
  assert.deepEqual([...KNOWN_TOOL_NAMES].sort(), [...KNOWN_ACTION_NAMES].sort());
});

test("an action is derived from the provider's real arguments, and an unknown tool counts as nothing", () => {
  assert.deepEqual(classifyToolCall("Write", { file_path: "C:/repo/src/app.ts" }), {
    kind: "write",
    paths: ["C:/repo/src/app.ts"],
    command: undefined,
  });
  // Gemini's spelling of the same thing.
  assert.equal(classifyToolCall("replace", { absolute_path: "/repo/a.ts" }).kind, "write");
  // Codex reports a list of changed paths rather than one.
  assert.deepEqual(classifyToolCall("file_change", { changes: [{ path: "/repo/a.ts" }, { path: "/repo/b.ts" }] }).paths, [
    "/repo/a.ts",
    "/repo/b.ts",
  ]);
  assert.equal(classifyToolCall("command_execution", { command: "npm test" }).command, "npm test");
  // The important negative: a tool nobody has catalogued is "other", never guessed into a write
  // because its name contains a promising word.
  assert.equal(classifyToolCall("write_memory_summary", {}).kind, "other");
  assert.deepEqual(classifyToolCall("write_memory_summary", {}).paths, []);
});

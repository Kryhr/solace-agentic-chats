import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { activityLabel, basename, commandHead, describeToolCall, humanizeToolName } from "./toolLabel";

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
  const raw = readFileSync(join(import.meta.dirname, "__fixtures__codex-stream.jsonl"), "utf8");
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

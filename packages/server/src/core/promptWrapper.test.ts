import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizePrompt, summarizeTaskLine } from "./agentManager";

/** The real pipeline a sidebar row goes through: strip the wrapper, then shorten. */
const taskLineFor = (prompt: string) => summarizeTaskLine(summarizePrompt(prompt));

/**
 * What a human reads in the sidebar must be the human's message, not the prompt scaffolding.
 *
 * The bug this pins, exactly as it happened: buildGroupPrompt wraps a message as
 *   [group context: ...]  [project context: ...]  [skills ...]  [group chat message from x]: real text
 * and stripPromptWrapper peeled the FIRST bracketed block, then expected the message marker to
 * be next. The moment the project-context pointer was inserted between them, that second strip
 * matched nothing, and a newly created agent's sidebar row read
 * "[project context: this project keeps a living context file at C:\Users\..." as its
 * current task. Observed live on a real turn.
 *
 * So the guard is not "strip these known blocks" - it is "whatever the wrapper grows, the
 * message begins after the marker".
 */
function wrapped(...blocks: string[]): string {
  return `${blocks.join("\n\n")}\n\n[group chat message from you]: fix the login bug`;
}

test("the task line is the message, whatever blocks precede it", () => {
  const cases = [
    wrapped("[group context: you are x]"),
    wrapped("[group context: you are x]", "[project context: read C:\p\CONTEXT.md]"),
    wrapped("[group context: you are x]", "[project context: read it]", "[skills: 96 installed]"),
    // A block added later that nobody has thought of yet must not reintroduce this.
    wrapped("[group context: x]", "[project context: y]", "[skills: z]", "[something new: w]"),
  ];
  for (const prompt of cases) {
    assert.equal(taskLineFor(prompt), "fix the login bug", `failed for: ${prompt.slice(0, 60)}…`);
  }
});

test("no bracketed block ever survives into the task line", () => {
  const line = taskLineFor(wrapped("[group context: a]", "[project context: b]", "[skills: c]"));
  assert.ok(!line.includes("project context"), "the context pointer leaked into the sidebar");
  assert.ok(!line.includes("group context"), "the group block leaked into the sidebar");
  assert.ok(!line.startsWith("["), "no scaffolding at all");
});

test("a direct hub message, which has no wrapper, is left alone", () => {
  assert.equal(taskLineFor("just do the thing"), "just do the thing");
});

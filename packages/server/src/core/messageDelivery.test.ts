import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deliverableText, summarizePrompt } from "./agentManager";

/**
 * A message handed to an agent to act on must arrive whole.
 *
 * What happened: takeInboundNotice built its delivery lines with summarizePrompt(), which caps at
 * 200 characters because it feeds the sidebar's task line. So a numbered audit sent between two
 * agents arrived as finding #1 and an ellipsis. Twice. In the agents' own words:
 *   "I only received a truncated preview of your audit findings"
 *   "the group-chat notification truncates long messages, so I've now twice only gotten #1"
 * The sender gave up and wrote its findings to a file on disk to get them across - two turns
 * spent working around a 200-character cap that nothing in the UI mentioned.
 */

test("a long message is delivered whole, not summarised", () => {
  const findings = Array.from({ length: 12 }, (_, i) => `${i + 1}. A real finding with a file path at src/pages/index.astro:${i}`).join("\n");
  const delivered = deliverableText(`[group chat message from claude]: ${findings}`);
  assert.ok(delivered.includes("12. A real finding"), "the last finding must survive");
  assert.ok(!delivered.includes("…"), "no ellipsis - nothing was summarised");
  // The exact failure: the same input through the sidebar summariser loses everything after #4.
  assert.ok(summarizePrompt(`[group chat message from claude]: ${findings}`).length <= 201);
});

test("newlines survive, because these are numbered lists and file paths", () => {
  const delivered = deliverableText("[group chat message from claude]: 1. first\n2. second\n3. third");
  assert.match(delivered, /1\. first\n2\. second\n3\. third/);
});

test("the prompt wrapper is still stripped", () => {
  const delivered = deliverableText("[group context: you are x]\n\n[group chat message from claude]: do the thing");
  assert.equal(delivered, "do the thing");
});

test("a genuinely enormous message is cut, and SAYS it was cut", () => {
  // The cap exists only because Codex and Copilot take their prompt on argv, where Windows stops
  // at ~32,764 characters for the whole command line. A silent ellipsis is what made the original
  // failure invisible, so when this bites it has to be legible to the agent receiving it.
  const huge = "x".repeat(40_000);
  const delivered = deliverableText(`[group chat message from claude]: ${huge}`);
  assert.ok(delivered.length < 13_000, "must be bounded for argv-limited providers");
  assert.match(delivered, /was cut here/, "the recipient is told, rather than left guessing");
  assert.match(delivered, /40000 characters/, "and told how much there really was");
});

test("takeInboundNotice uses the deliverer, never the sidebar summariser", () => {
  // Guards the specific regression: the two functions look interchangeable at the call site and
  // one of them silently destroys content.
  const src = readFileSync(join(import.meta.dirname, "agentManager.ts"), "utf8");
  const at = src.indexOf("takeInboundNotice(");
  const body = src.slice(at, src.indexOf("\n  }\n", at));
  assert.match(body, /deliverableText\(t\.prompt\)/);
  assert.ok(!/summarizePrompt\(t\.prompt\)/.test(body), "the 200-char summariser must not deliver messages");
});

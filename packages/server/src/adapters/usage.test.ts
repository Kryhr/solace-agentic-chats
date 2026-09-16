import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TurnUsage } from "@solace/shared";
import { addStepFinishUsage, addUsage, isEmptyUsage } from "../core/usage";
import { claudeCodeUsage } from "./claude-code";
import { codexUsage } from "./codex-cli";
import { copilotCallUsage, copilotCheckpointUsage, copilotResultUsage, copilotTurnUsage } from "./copilot-cli";
import { crushUsage } from "./crush";
import { droidUsage } from "./droid";
import { geminiUsage } from "./gemini-cli";
import { qwenUsage } from "./qwen-code";

/**
 * Per-provider usage extraction, driven by payloads captured from the real CLIs rather than
 * invented for the test. Each block names how its payload was obtained - live run, on-disk
 * session record, or the CLI's own shipped source - because "we checked" and "we read the
 * bundle" are different levels of confidence and the tests should not blur them.
 *
 * Every test here pins a bug that was actually shipped. They are deliberately about the
 * numbers, not the plumbing: the failures being prevented are silent wrong figures, which no
 * amount of "it emitted a usage event" asserting would have caught.
 */

function readFixture(name: string): unknown[] {
  const path = join(__dirname, "__fixtures__", name);
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

// ───────────────────────────────────────────────────────────────────────── claude code
//
// Shape from the shipped binary's own Zod schema (@anthropic-ai/claude-code, bin/claude.exe):
// the result message carries `usage` (main agent loop only), `modelUsage` (per model, including
// subagents, "prefer[red] for token/cost accounting" in its own words) and `total_cost_usd`.
// The `usage` literal below matches the one this machine's own transcripts record verbatim.

const CLAUDE_RESULT = {
  type: "result",
  subtype: "success",
  total_cost_usd: 0.4213,
  usage: {
    input_tokens: 2,
    cache_creation_input_tokens: 19443,
    cache_read_input_tokens: 36411,
    output_tokens: 123,
    output_tokens_details: { thinking_tokens: 0 },
  },
  modelUsage: {
    "claude-opus-5": {
      inputTokens: 2,
      outputTokens: 123,
      thinkingTokens: 40,
      cacheReadInputTokens: 36411,
      cacheCreationInputTokens: 19443,
      webSearchRequests: 0,
      costUSD: 0.4213,
      contextWindow: 200000,
    },
  },
};

test("claude code: the cache buckets survive - they are most of the prompt, and were being dropped", () => {
  const usage = claudeCodeUsage(CLAUDE_RESULT)!;
  assert.equal(usage.cacheReadTokens, 36411);
  assert.equal(usage.cacheWriteTokens, 19443);
  // The bug this pins: input alone is 2 tokens against a real prompt of nearly 56,000. Showing
  // the user "2 in" for that turn was wrong by four orders of magnitude.
  assert.equal(usage.inputTokens, 2);
  assert.equal(usage.cacheCountedInInput, false, "Anthropic reports the prompt buckets separately");
});

test("claude code: cost comes from the provider's own total_cost_usd, and is not an estimate", () => {
  const usage = claudeCodeUsage(CLAUDE_RESULT)!;
  assert.equal(usage.totalCostUsd, 0.4213);
  assert.equal(usage.estimatedCostUsd, undefined);
});

test("claude code: no total is invented, because the result message states none", () => {
  assert.equal(claudeCodeUsage(CLAUDE_RESULT)!.totalTokens, undefined);
});

test("claude code: modelUsage wins over usage, because it covers subagents and total_cost_usd does too", () => {
  const withSubagents = {
    ...CLAUDE_RESULT,
    modelUsage: {
      "claude-opus-5": { inputTokens: 2, outputTokens: 123, cacheReadInputTokens: 36411, cacheCreationInputTokens: 19443 },
      "claude-haiku-4-5": { inputTokens: 900, outputTokens: 4500, cacheReadInputTokens: 100, cacheCreationInputTokens: 0 },
    },
  };
  const usage = claudeCodeUsage(withSubagents)!;
  assert.equal(usage.outputTokens, 4623, "the subagent's output is part of what the user is billed for");
  assert.equal(usage.inputTokens, 902);
});

test("claude code: a result with no modelUsage still reports, falling back to usage", () => {
  const usage = claudeCodeUsage({ ...CLAUDE_RESULT, modelUsage: {} })!;
  assert.equal(usage.inputTokens, 2);
  assert.equal(usage.cacheReadTokens, 36411);
});

test("claude code: a result carrying no usage at all reports nothing, rather than zeros", () => {
  assert.equal(claudeCodeUsage({ type: "result" } as never), undefined);
});

// ───────────────────────────────────────────────────────────────────────── codex
//
// Field list read off the shipped codex.exe (TurnCompletedEvent -> TokenUsage). The numbers are
// a real `last_token_usage` record from this machine's own rollout file,
// ~/.codex/sessions/2026/09/16/rollout-*.jsonl.

const CODEX_USAGE = {
  input_tokens: 137957,
  cached_input_tokens: 137600,
  cache_write_input_tokens: 0,
  output_tokens: 254,
  reasoning_output_tokens: 34,
  total_tokens: 138211,
};

test("codex: the provider's own total is kept, not replaced by a sum of the parts", () => {
  const usage = codexUsage(CODEX_USAGE)!;
  assert.equal(usage.totalTokens, 138211);
});

test("codex: cached tokens are recorded as being INSIDE the input count, so nothing double-counts", () => {
  const usage = codexUsage(CODEX_USAGE)!;
  assert.equal(usage.cacheReadTokens, 137600);
  assert.equal(usage.cacheCountedInInput, true);
  // Codex's own arithmetic, which is what makes the flag above a fact rather than a guess.
  assert.equal(usage.inputTokens! + usage.outputTokens!, usage.totalTokens);
});

test("codex: reasoning tokens are kept, and recorded as already inside the output count", () => {
  const usage = codexUsage(CODEX_USAGE)!;
  assert.equal(usage.reasoningTokens, 34);
  assert.equal(usage.reasoningCountedInOutput, true);
});

test("codex: no cost is reported, because codex exec states none", () => {
  const usage = codexUsage(CODEX_USAGE)!;
  assert.equal(usage.totalCostUsd, undefined);
  assert.equal(usage.estimatedCostUsd, undefined);
});

// ───────────────────────────────────────────────────────────────────────── opencode / kilo
//
// LIVE. Captured by running `opencode run --format json -m opencode/mimo-v2.5-free` on a real
// three-step turn; the whole stream is in __fixtures__/opencode-run.jsonl. Kilo is the same
// stream format and goes through the same accumulator.

const OPENCODE_STEPS = readFixture("opencode-run.jsonl")
  .filter((e): e is { type: string; part: { tokens: unknown; cost: unknown } } => (e as { type?: string }).type === "step_finish");

test("opencode fixture: the capture really is a multi-step turn", () => {
  assert.equal(OPENCODE_STEPS.length, 3);
});

test("opencode: every step's stated total equals input + output + reasoning + cache, exactly", () => {
  // This is the arithmetic that settles the two "counted in" flags. If OpenCode ever changes
  // how it counts, this fails and the flags below have to be re-derived rather than trusted.
  for (const step of OPENCODE_STEPS) {
    const t = step.part.tokens as { total: number; input: number; output: number; reasoning: number; cache: { read: number; write: number } };
    assert.equal(t.total, t.input + t.output + t.reasoning + t.cache.read + t.cache.write);
  }
});

test("opencode: cache and reasoning are recorded as OUTSIDE input/output - the opposite of codex", () => {
  const usage = addStepFinishUsage(undefined, OPENCODE_STEPS[0].part.tokens, OPENCODE_STEPS[0].part.cost);
  assert.equal(usage.cacheCountedInInput, false);
  assert.equal(usage.reasoningCountedInOutput, false);
});

test("opencode: a multi-step turn accumulates every step, and does not report only the last", () => {
  let usage: TurnUsage | undefined;
  for (const step of OPENCODE_STEPS) usage = addStepFinishUsage(usage, step.part.tokens, step.part.cost);
  // 20354 + 127 + 271 - the real figures from the capture, not the last step's 271.
  assert.equal(usage!.inputTokens, 20752);
  assert.equal(usage!.outputTokens, 122);
  assert.equal(usage!.reasoningTokens, 38);
  assert.equal(usage!.cacheReadTokens, 43840);
  assert.equal(usage!.cacheWriteTokens, 0);
  assert.equal(usage!.totalTokens, 64752, "the sum of OpenCode's own per-step totals");
});

test("opencode: the previously-kept fields alone would have dropped most of the turn", () => {
  let usage: TurnUsage | undefined;
  for (const step of OPENCODE_STEPS) usage = addStepFinishUsage(usage, step.part.tokens, step.part.cost);
  const oldBehaviour = usage!.inputTokens! + usage!.outputTokens!;
  assert.ok(oldBehaviour < usage!.totalTokens! / 3, "input+output is a small fraction of the real total");
});

test("opencode: a free model's stated cost of 0 is reported as 0, because the provider stated it", () => {
  const usage = addStepFinishUsage(undefined, { input: 1 }, 0);
  assert.equal(usage.totalCostUsd, 0);
});

test("opencode: a step with no cost field reports no cost, rather than 0", () => {
  const usage = addStepFinishUsage(undefined, { input: 1 }, undefined);
  assert.equal(usage.totalCostUsd, undefined);
});

// ───────────────────────────────────────────────────────────────────────── copilot
//
// LIVE. Captured by running one real Copilot turn through `--output-format json` on 1.1.21;
// the usage-bearing events are in __fixtures__/copilot-run.jsonl (opaque ids stripped).

const COPILOT_EVENTS = readFixture("copilot-run.jsonl") as { type: string; data?: unknown; usage?: unknown }[];
const COPILOT_CHECKPOINT = COPILOT_EVENTS.find((e) => e.type === "session.usage_checkpoint")!;
const COPILOT_RESULT = COPILOT_EVENTS.find((e) => e.type === "result")!;

test("copilot: the live stream really does carry no assistant.usage event on this build", () => {
  // The reason the checkpoint fallback exists at all. If a future Copilot build starts emitting
  // it, this fails, and the richer path (with real output tokens) should become the tested one.
  assert.equal(COPILOT_EVENTS.some((e) => e.type === "assistant.usage"), false);
});

test("copilot: output tokens are ABSENT, not zero - the provider never states them", () => {
  const usage = copilotTurnUsage(undefined, copilotCheckpointUsage(COPILOT_CHECKPOINT.data), copilotResultUsage(COPILOT_RESULT.usage))!;
  // The shipped bug: `{ inputTokens: m.prompt_tokens }` with nothing else meant the UI rendered
  // a confident "0 out" for every Copilot turn. Absent is the only honest value here.
  assert.equal(usage.outputTokens, undefined);
  assert.ok(usage.caveat && /output-token/.test(usage.caveat), "and the UI is told why in words");
});

test("copilot: the prompt figure is the one Copilot printed, with its cache split", () => {
  const usage = copilotCheckpointUsage(COPILOT_CHECKPOINT.data)!;
  assert.equal(usage.inputTokens, 11425);
  assert.equal(usage.cacheReadTokens, 1280);
  assert.equal(usage.cacheWriteTokens, 0);
  assert.equal(usage.cacheCountedInInput, true);
});

test("copilot: premium requests are reported in Copilot's own unit, never converted to dollars", () => {
  const usage = copilotResultUsage(COPILOT_RESULT.usage)!;
  assert.deepEqual(usage.otherCosts, [{ amount: 1, unit: "premium request" }]);
  assert.equal(usage.totalCostUsd, undefined);
  assert.equal(usage.estimatedCostUsd, undefined);
});

test("copilot: only the main conversation's baseline is read, not every sub-agent's", () => {
  const usage = copilotCheckpointUsage({
    promptCacheBreakState: [
      { conversation: "main", models: { m: { prompt_tokens: 100, cache_read: 10 } } },
      { conversation: "subagent-1", models: { m: { prompt_tokens: 999999, cache_read: 0 } } },
    ],
  })!;
  assert.equal(usage.inputTokens, 100);
});

test("copilot: when assistant.usage IS present it is preferred, because it has real output tokens", () => {
  const call = copilotCallUsage({
    model: "mai-code-1.1-flash",
    inputTokens: 11425,
    outputTokens: 42,
    cacheReadTokens: 1280,
    reasoningTokens: 8,
    copilotUsage: { totalNanoAiu: 185454000 },
  })!;
  const usage = copilotTurnUsage(call, copilotCheckpointUsage(COPILOT_CHECKPOINT.data), undefined)!;
  assert.equal(usage.outputTokens, 42);
  assert.equal(usage.caveat, undefined, "the checkpoint's caveat does not apply when the real event arrived");
  assert.deepEqual(usage.otherCosts, [{ amount: 185454000, unit: "nano-AIU" }]);
});

// ───────────────────────────────────────────────────────────────────────── crush
//
// Shape from the real session document a previous capture recorded, cross-checked against the
// sessions table in the shipped crush.exe, which stores only prompt_tokens, completion_tokens
// and cost - so there are genuinely no cache or reasoning figures to lose.

test("crush: its figures are marked session-scoped, because that is what Crush publishes", () => {
  const usage = crushUsage({ id: "x", uuid: "x", prompt_tokens: 123, completion_tokens: 45, total_tokens: 168, cost: 0.02 })!;
  assert.equal(usage.scope, "session");
  assert.equal(usage.inputTokens, 123);
  assert.equal(usage.totalTokens, 168, "Crush's own total, passed through");
  assert.equal(usage.totalCostUsd, 0.02);
});

test("crush: a session total is REPLACED in the running total, never added to it again", () => {
  // The shipped bug: three turns of one Crush session reported ~3x the tokens Crush itself
  // shows, because each turn's cumulative snapshot was added to the previous one.
  const first = crushUsage({ id: "x", uuid: "x", prompt_tokens: 100, completion_tokens: 10, cost: 0.01 })!;
  const second = crushUsage({ id: "x", uuid: "x", prompt_tokens: 260, completion_tokens: 31, cost: 0.03 })!;
  const total = addUsage(addUsage({}, first), second);
  assert.equal(total.inputTokens, 260);
  assert.equal(total.totalCostUsd, 0.03);
});

// ───────────────────────────────────────────────────────────────────────── gemini / qwen
//
// SOURCE-READ ONLY. Neither CLI is signed in on this machine (`gemini -p` asks for an auth
// method, `qwen -p` says no auth type is selected), so these shapes come from the installed
// bundles - gemini-cli's convertToStreamStats and qwen-code's computeUsageFromMetrics.

test("gemini: the stated total is kept even though it exceeds input + output", () => {
  // tokens.total covers thought and tool tokens the stream never itemises, so recomputing it
  // from the parts would show the user a smaller number than their own CLI prints.
  const usage = geminiUsage({ total_tokens: 4000, input_tokens: 3000, output_tokens: 500, cached: 2000, input: 1000 })!;
  assert.equal(usage.totalTokens, 4000);
  assert.notEqual(usage.totalTokens, usage.inputTokens! + usage.outputTokens!);
});

test("gemini: cached content is recorded as inside the prompt count, the Gemini convention", () => {
  const usage = geminiUsage({ total_tokens: 4000, input_tokens: 3000, output_tokens: 500, cached: 2000 })!;
  assert.equal(usage.cacheReadTokens, 2000);
  assert.equal(usage.cacheCountedInInput, true);
});

test("qwen: cache reads and the stated total both survive, and neither was kept before", () => {
  const usage = qwenUsage({ input_tokens: 3000, output_tokens: 500, cache_read_input_tokens: 2048, total_tokens: 3600 })!;
  assert.equal(usage.cacheReadTokens, 2048);
  assert.equal(usage.totalTokens, 3600);
  assert.equal(usage.cacheCountedInInput, true);
});

test("qwen: an error result whose counts are genuinely zero still reports those zeros", () => {
  // Qwen's unauthenticated failure really does carry {"input_tokens":0,"output_tokens":0}. That
  // is a figure the provider stated, so it is reported - the absent/zero rule cuts both ways.
  const usage = qwenUsage({ input_tokens: 0, output_tokens: 0 })!;
  assert.equal(usage.inputTokens, 0);
  assert.equal(usage.outputTokens, 0);
});

// ───────────────────────────────────────────────────────────────────────── droid
//
// SOURCE-READ ONLY (not signed in). Literal built by the shipped droid.exe from
// getInclusiveTokenUsage().

test("droid: cache and thinking tokens survive, and credits stay in Droid's own unit", () => {
  const usage = droidUsage({
    input_tokens: 500,
    output_tokens: 200,
    cache_read_input_tokens: 40000,
    cache_creation_input_tokens: 1200,
    factory_credits: 7,
    thinking_tokens: 64,
  })!;
  assert.equal(usage.cacheReadTokens, 40000);
  assert.equal(usage.cacheWriteTokens, 1200);
  assert.equal(usage.reasoningTokens, 64);
  assert.equal(usage.cacheCountedInInput, false, "Droid reports Anthropic-style separate buckets");
  assert.deepEqual(usage.otherCosts, [{ amount: 7, unit: "Factory credit" }]);
  assert.equal(usage.totalCostUsd, undefined, "a Factory credit is not a dollar");
});

// ───────────────────────────────────────────────────────────────────────── the absent/zero rule

test("a field nobody reported stays absent through accumulation, and never becomes 0", () => {
  const total = addUsage({ inputTokens: 10 }, { inputTokens: 5 });
  assert.equal(total.inputTokens, 15);
  assert.equal(total.outputTokens, undefined);
  assert.equal(total.cacheReadTokens, undefined);
  assert.equal(total.totalCostUsd, undefined);
});

test("a field one side reported is kept, treating the silent side as nothing to add", () => {
  const total = addUsage({ inputTokens: 10 }, { inputTokens: 5, cacheReadTokens: 7 });
  assert.equal(total.cacheReadTokens, 7);
});

test("non-dollar costs accumulate per unit, and units are never mixed", () => {
  const total = addUsage(
    { otherCosts: [{ amount: 1, unit: "premium request" }] },
    { otherCosts: [{ amount: 2, unit: "premium request" }, { amount: 5, unit: "nano-AIU" }] },
  );
  assert.deepEqual(total.otherCosts, [
    { amount: 3, unit: "premium request" },
    { amount: 5, unit: "nano-AIU" },
  ]);
});

test("an estimated cost is never folded into the provider-stated cost", () => {
  const total = addUsage({ totalCostUsd: 0.5 }, { estimatedCostUsd: 0.2 });
  assert.equal(total.totalCostUsd, 0.5);
  assert.equal(total.estimatedCostUsd, 0.2);
});

test("a usage report with no numbers at all is recognised as empty and never emitted", () => {
  assert.equal(isEmptyUsage({}), true);
  assert.equal(isEmptyUsage(undefined), true);
  assert.equal(isEmptyUsage({ inputTokens: 0 }), false, "a reported zero is not an empty report");
});

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MIN_TURN_SAMPLES, medianOf } from "./agentManager.ts";

/**
 * The queue indicator promises a wait: "@claude is mid-turn - queued #2, ~3 min".
 *
 * That is the app making a claim about the future, which this project only does from real
 * measurements. These pin the two halves of keeping it honest: too few samples means NO estimate
 * at all rather than a confident one built from a single turn, and one long turn must not drag
 * the estimate for every short turn around it.
 *
 * The measured reality this exists for: reply latency ran 41-58s at the median and 5-20 MINUTES
 * at p90, entirely because the recipient was busy. An average across that distribution would
 * quote a number that describes almost none of the actual turns.
 */

test("no estimate at all until there are enough turns to mean anything", () => {
  assert.equal(medianOf([]), undefined, "an agent that has never finished a turn says nothing");
  assert.equal(medianOf([8_000]), undefined, "one turn is an anecdote, not an estimate");
  assert.equal(medianOf([8_000, 700_000]), undefined);
  assert.equal(MIN_TURN_SAMPLES, 3);
  // At exactly the threshold it starts answering - the bound is inclusive, so the rule and the
  // constant cannot drift apart.
  assert.equal(medianOf([8_000, 10_000, 12_000]), 10_000);
});

test("the median, not the mean - one long build must not move twenty short turns", () => {
  // Real shape from the roadmap's own numbers: a cluster of short turns and a twelve-minute one.
  const durations = [30_000, 40_000, 45_000, 50_000, 720_000];
  assert.equal(medianOf(durations), 45_000);
  const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
  assert.ok(mean > 170_000, "the mean would have quoted nearly three minutes for a 45-second agent");
});

test("an even number of samples averages the middle pair, and the input is not mutated", () => {
  const durations = [40_000, 10_000, 30_000, 20_000];
  assert.equal(medianOf(durations), 25_000);
  assert.deepEqual(durations, [40_000, 10_000, 30_000, 20_000], "sorting in place would reorder the live array");
});

/**
 * Asserted against the source because it needs a real turn, a real provider process and a real
 * abort to exercise end to end - and because the thing being guarded is a line going missing
 * rather than a value coming out wrong, which is the house pattern (see chatNoise.test.ts).
 */
test("only a turn that finished normally is counted as evidence of how long turns take", () => {
  // Normalised, because this repo's working tree is CRLF and every `\s*\n` in a source
  // assertion silently stops matching without it.
  const src = readFileSync(join(import.meta.dirname, "agentManager.ts"), "utf8").replace(/\r\n/g, "\n");
  // An interrupted turn's duration is how long it lasted before being killed, and an errored
  // one's is how long it took to fail. Neither answers "how long will this take".
  //
  // Two branches built this tracker independently. The one kept excludes EVERY cancelled turn -
  // stop, interrupt and idle-timeout alike - rather than interrupts alone, so a turn the
  // operator stopped after ten seconds cannot drag the estimate down.
  assert.match(src, /if \(!hadError && !cancelled\) \{\s*\n\s*runtime\.turnDurationsMs\.push/);
  // Bounded, so the estimate follows what the agent is doing now rather than being anchored by
  // turns from hours ago.
  assert.match(src, /runtime\.turnDurationsMs\.length > TURN_DURATION_SAMPLES/);
  // The queue depth is counted off the real queue, never tracked in a second place that could
  // drift from what will actually run.
  assert.match(src, /queuedTurns: runtime\.queue\.length/);
  // "working on" is cleared with the turn: a tool label left behind would claim an idle agent
  // was still running something.
  assert.match(src, /runtime\.workingOn = undefined;/);
  assert.match(src, /workingOn: runtime\.busy \? runtime\.workingOn : undefined/);
});

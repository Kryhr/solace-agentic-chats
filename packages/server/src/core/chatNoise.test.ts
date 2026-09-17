import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Four fixes for things that filled a real session's chat with noise, or dropped real messages.
 *
 * All asserted against the source: each one is a branch inside routing or turn-completion that
 * needs a live agent, a live turn and a provider process to exercise end to end, and the thing
 * being guarded in every case is a line going missing rather than a value coming out wrong.
 */
const SRC = readFileSync(join(import.meta.dirname, "agentManager.ts"), "utf8");

test("a message that is ONLY the end-of-thread marker is not posted", () => {
  // Four messages reading exactly "[no-reply]" appeared in one session. The old line was
  //   text.replace(MARKER, "").trim() || text.trim()
  // so when the whole message was the marker, stripping left "" - which is falsy - and the
  // fallback put the raw marker back. Routing metadata rendered as conversation.
  assert.match(SRC, /const isMarkerOnly = displayText\.length === 0 && END_THREAD_MARKER\.test\(text\)/);
  assert.match(SRC, /if \(!isMarkerOnly\) this\.bus\.postMessage\(message\)/);
  assert.ok(
    !/END_THREAD_MARKER, ""\)\.trim\(\) \|\| text\.trim\(\)/.test(SRC),
    "the fallback that re-showed the marker must stay gone",
  );
});

test("real work resets the agent-to-agent hop counter", () => {
  // "Stopped an agent-to-agent reply chain after 6 hops" fired TEN times in one session. With
  // four agents the depth advances in steps of two, so a cap of six is spent in about three
  // exchanges - and every cutoff is a message that never reached its recipient. The cap is for
  // loops; a chain that is producing work is not one.
  assert.match(SRC, /currentTurnDidWork\?: boolean/);
  assert.match(SRC, /runtime\.currentTurnDidWork = true/);
  assert.match(SRC, /runtime\.currentTurnDidWork = false/, "and it must reset each turn");
  const resets = SRC.match(/runtime\.currentTurnDidWork \? 0 :/g) ?? [];
  assert.equal(resets.length, 2, "both routing paths - mid-turn and final answer - must reset");
});

test("a final answer does not repeat to the group what the turn already posted", () => {
  // The old check was exact text equality, so a REWORDED restatement went through. One session
  // produced pairs like "@claude @copilot I'm taking the Codex lane..." followed by "I posted my
  // Codex lane update to the group" - same news, same channel, twice.
  assert.match(SRC, /const saidSomethingAlready = midTurnPosts\.length > 0/);
  assert.match(SRC, /saidSomethingAlready && newMentions\.length === 0/);
  // A new @mention still gets through: that is addressed to somebody who has not had it.
  assert.match(SRC, /newMentions/);
});

test("a file claim states the directory it is in", () => {
  // A bare path is ambiguous between two agents in different folders, and that ambiguity nearly
  // caused real damage - see coordinationWiring.test.ts for the full incident.
  assert.match(SRC, /\(under \$\{ctx\.runtime\.config\.cwd\}\)/);
});

test("Stop cancels a scheduled rate-limit retry, and works with nothing in flight", () => {
  // Codex hit its provider usage limit, two re-runs were armed for when the quota reset, and
  // Stop answered "no turn in flight" - there was no way to call them off short of deleting the
  // agent or restarting the server.
  const at = SRC.indexOf("stopAgent(id: string): boolean {");
  const body = SRC.slice(at, SRC.indexOf("\n  }\n", at));
  assert.match(body, /clearTimeout\(runtime\.scheduledRetryTimeout\)/);
  assert.match(body, /runtime\.scheduledRetryAt = undefined/);
  assert.ok(!/if \(!runtime\?\.activeController\) return false;/.test(body), "must not bail when idle");
});

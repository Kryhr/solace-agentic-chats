import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentGate } from "./agentGate";

/**
 * Muting and pausing, and the difference between them.
 *
 * Until these existed the only way to stop an agent answering everything in a room was to
 * delete it. That is a destructive answer to a temporary problem, and it takes the agent's
 * session and its place in the chat with it.
 *
 * The two are NOT interchangeable, and the tests below are mostly about that: a muted agent
 * never receives the work, so unmuting costs nothing, while a paused agent receives all of it
 * and resuming spends a real billed turn on every message that piled up. An implementation that
 * quietly conflated them would look identical until the bill arrived.
 */
const MANAGER = readFileSync(join(import.meta.dirname, "agentManager.ts"), "utf8");

test("setting a gate reports whether it actually changed anything", () => {
  // So /mute can say "already muted" instead of reporting an action it did not take.
  const gate = new AgentGate();
  assert.equal(gate.setMuted("a1", true), true);
  assert.equal(gate.setMuted("a1", true), false);
  assert.equal(gate.isMuted("a1"), true);
  assert.equal(gate.setMuted("a1", false), true);
  assert.equal(gate.isMuted("a1"), false);
});

test("the two gates are independent - muting does not pause and pausing does not mute", () => {
  const gate = new AgentGate();
  gate.setMuted("a1", true);
  assert.equal(gate.isPaused("a1"), false);
  gate.setPaused("a2", true);
  assert.equal(gate.isMuted("a2"), false);
});

test("un-pausing calls back, so the backlog really runs", () => {
  // Without this the queue would only drain when the next message happened to arrive - and for
  // an agent nobody is talking to, that is never. /resume would look like it had silently
  // thrown away everything that piled up.
  const gate = new AgentGate();
  const resumed: string[] = [];
  gate.onResumed = (id) => resumed.push(id);
  gate.setPaused("a1", true);
  assert.deepEqual(resumed, [], "pausing is not a resume");
  gate.setPaused("a1", false);
  assert.deepEqual(resumed, ["a1"]);
  gate.setPaused("a1", false);
  assert.deepEqual(resumed, ["a1"], "and an agent that was not paused does not get drained twice");
});

test("a deleted agent does not leave a gate nothing can ever clear", () => {
  const gate = new AgentGate();
  gate.setMuted("a1", true);
  gate.setPaused("a1", true);
  gate.forget("a1");
  assert.deepEqual(gate.listMuted(), []);
  assert.deepEqual(gate.listPaused(), []);
});

test("routing consults the mute gate, and drainQueue consults the pause gate", () => {
  // Asserted against the source because both are branches inside routing and turn dispatch that
  // need a live agent and a real provider process to exercise end to end - the same reasoning
  // chatNoise.test.ts is built on.
  assert.match(MANAGER, /if \(this\.gate\.isMuted\(runtime\.config\.id\)\)/);
  assert.match(MANAGER, /if \(this\.gate\.isPaused\(agentId\)\) return;/);
  // The pause check must sit BEFORE the shift, or the turn it holds back is taken off the queue
  // and dropped - "held" would silently become "lost".
  const drain = MANAGER.indexOf("private async drainQueue(agentId: string)");
  const pauseAt = MANAGER.indexOf("this.gate.isPaused(agentId)", drain);
  const shiftAt = MANAGER.indexOf("runtime.queue.shift()", drain);
  assert.ok(pauseAt > drain && pauseAt < shiftAt, "a paused agent's work must stay on its queue");
});

test("a message not routed to a muted agent is announced, never silently dropped", () => {
  // A message that vanishes with no word is indistinguishable from the app losing it, and this
  // codebase has already paid for that once - see chatNoise.test.ts on the reply-chain cutoff
  // that fired ten times in one session while saying nothing at all.
  assert.ok(MANAGER.includes("mutedSkipped.push(runtime.config.handle)"), "the skip has to be recorded, not just taken");
  assert.ok(MANAGER.includes("muted, so "), "and announced");
  assert.ok(MANAGER.includes("that message was not routed to "), "in terms that say nothing was queued");
});

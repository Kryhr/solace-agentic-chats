import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentConfig } from "@solace/shared";
import { AgentManager } from "./agentManager";
import { ChatBus } from "./chatBus";
import { ChatStore } from "./chatStore";

/**
 * Several messages that arrived while an agent was busy become ONE turn, not several.
 *
 * Observed live: claude was @mentioned eight times mid-build. Each mention enqueued its own
 * turn, so it answered them one at a time, minutes apart, charged eight times - and each of
 * those turns carried a full copy of the context block to deliver one sentence.
 */
function agent(id: string, handle: string): AgentConfig {
  return { id, handle, provider: "claude-code", cwd: process.cwd(), trustLevel: "manual" };
}

function harness() {
  const agents = [agent("a1", "claude"), agent("a2", "codex"), agent("a3", "copilot")];
  const chats = new ChatStore();
  const manager = new AgentManager(new ChatBus(), chats, agents);
  const started: string[] = [];
  const inner = manager as unknown as {
    agents: Map<string, { queue: Array<{ prompt: string }>; pendingInbound: unknown[]; busy: boolean }>;
    coalesceQueuedMessages: (r: unknown, t: unknown) => void;
  };
  // Capture the prompt a turn would run with, without spawning anything. Respects `busy` exactly
  // as the real drainQueue does - that is what makes messages queue up rather than each starting
  // its own turn the instant it arrives, which is the situation being tested.
  (manager as unknown as { drainQueue: (id: string) => Promise<void> }).drainQueue = async (id: string) => {
    const runtime = inner.agents.get(id)!;
    if (runtime.busy) return;
    const turn = runtime.queue.shift();
    if (!turn) return;
    inner.coalesceQueuedMessages(runtime, turn);
    started.push(turn.prompt);
  };
  const chat = chats.createChat("Build");
  const queueFor = (id: string) => inner.agents.get(id)!.queue;
  /** The agent is mid-turn, so everything that arrives waits - the live situation. */
  const setBusy = (id: string, busy: boolean) => {
    inner.agents.get(id)!.busy = busy;
  };
  const drain = async (id: string) => {
    setBusy(id, false);
    await (manager as unknown as { drainQueue: (i: string) => Promise<void> }).drainQueue(id);
  };
  setBusy("a1", true);
  return { manager, chat, started, queueFor, drain, setBusy };
}

test("eight mentions become one turn, in the order they were sent", async () => {
  const h = harness();
  for (let i = 1; i <= 8; i++) {
    h.manager.submitMessage(h.chat.id, "a2", "codex", `@claude question number ${i}`);
  }
  assert.equal(h.queueFor("a1").length, 8, "eight arrived");

  await h.drain("a1");

  assert.equal(h.started.length, 1, "one turn ran, not eight");
  assert.equal(h.queueFor("a1").length, 0, "nothing left queued behind it");
  const prompt = h.started[0];
  for (let i = 1; i <= 8; i++) assert.ok(prompt.includes(`question number ${i}`), `message ${i} missing`);
  assert.ok(
    prompt.indexOf("question number 1") < prompt.indexOf("question number 8"),
    "arrival order is the promise made to whoever sent them",
  );
  assert.match(prompt, /8 messages arrived for you/);
});

test("the context block is sent once, not once per message", async () => {
  // This is the actual saving. Eight rendered prompts would each carry identity, roster,
  // coordination, house style and the skills pointer to deliver one sentence.
  const h = harness();
  for (let i = 0; i < 5; i++) h.manager.submitMessage(h.chat.id, "a2", "codex", `@claude msg ${i}`);
  await h.drain("a1");
  const prompt = h.started[0];
  assert.equal(prompt.split("[group context:").length - 1, 1, "one context block for the whole batch");
});

test("a batch containing a question is treated as a question", async () => {
  // Otherwise a batch that somebody is waiting on gets classified as ordinary work.
  const h = harness();
  h.manager.submitMessage(h.chat.id, "a2", "codex", "@claude here is some context for later");
  h.manager.submitMessage(h.chat.id, "a3", "copilot", "@claude what is the order API?");
  const queue = h.queueFor("a1") as Array<{ kind: string }>;
  const merged = queue[0];
  await h.drain("a1");
  assert.equal(merged.kind, "question");
});

test("messages for a DIFFERENT chat are never folded in", async () => {
  // They are different conversations; answering one inside the other would post the reply into
  // the wrong room.
  const h = harness();
  const other = (h.manager as unknown as { chats: ChatStore }).chats.createChat("Other");
  h.manager.submitMessage(h.chat.id, "a2", "codex", "@claude one");
  h.manager.submitMessage(other.id, "a2", "codex", "@claude two");
  await h.drain("a1");
  assert.ok(h.started[0].includes("one"));
  assert.ok(!h.started[0].includes("two"), "the other chat's message stays put");
  assert.equal(h.queueFor("a1").length, 1);
});

test("a single message is left exactly as it was", async () => {
  // No batching footer, no rewriting, when there is nothing to batch.
  const h = harness();
  h.manager.submitMessage(h.chat.id, "a2", "codex", "@claude just one thing");
  await h.drain("a1");
  assert.ok(h.started[0].includes("just one thing"));
  assert.doesNotMatch(h.started[0], /messages arrived for you while you were working/);
});

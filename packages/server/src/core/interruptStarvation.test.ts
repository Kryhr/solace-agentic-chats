import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentConfig } from "@solace/shared";
import { AgentManager } from "./agentManager";
import { ChatBus } from "./chatBus";
import { ChatStore } from "./chatStore";

/**
 * Who is allowed to kill a running turn.
 *
 * The live failure this guards: in a three-agent run, claude was hard-interrupted four times in
 * a row by questions from codex and copilot, finished nothing, and posted NOTHING to the group -
 * while those two, blocked waiting on it, kept asking, which is what kept killing it.
 */
function agent(id: string, handle: string): AgentConfig {
  return { id, handle, provider: "claude-code", cwd: process.cwd(), trustLevel: "manual" };
}

/** Reaches into the private interrupt machinery: these are internals with no public surface, and
 * the behaviour under test is precisely that they do nothing for an agent-authored question. */
function armFor(manager: AgentManager, agentId: string) {
  const inner = manager as unknown as {
    agents: Map<string, { interruptTimer?: NodeJS.Timeout; pendingInbound: unknown[] }>;
    armInterruptTimer: (r: unknown) => void;
  };
  const runtime = inner.agents.get(agentId)!;
  inner.armInterruptTimer(runtime);
  const armed = runtime.interruptTimer !== undefined;
  if (runtime.interruptTimer) clearTimeout(runtime.interruptTimer);
  runtime.interruptTimer = undefined;
  return armed;
}

function withPending(manager: AgentManager, agentId: string, pending: unknown[]) {
  const inner = manager as unknown as { agents: Map<string, { pendingInbound: unknown[] }> };
  inner.agents.get(agentId)!.pendingInbound = pending;
}

function setCurrentTurn(manager: AgentManager, agentId: string, turn: Record<string, unknown>) {
  const inner = manager as unknown as { agents: Map<string, { currentTurn?: unknown }> };
  inner.agents.get(agentId)!.currentTurn = turn;
}

function harness() {
  const agents = [agent("a1", "claude"), agent("a2", "codex")];
  const manager = new AgentManager(new ChatBus(), new ChatStore(), agents);
  (manager as unknown as { drainQueue: (id: string) => Promise<void> }).drainQueue = async () => {};
  return manager;
}

const QUESTION = { kind: "question", receivedAt: new Date().toISOString(), prompt: "what is the contract?" };

test("an operator question arms the interrupt", () => {
  const manager = harness();
  withPending(manager, "a1", [{ ...QUESTION }]);
  assert.equal(armFor(manager, "a1"), true);
});

test("an agent's question arms the interrupt, but only once per turn", () => {
  // Both extremes were live failures. Interrupting on every agent question killed claude four
  // times in a row so it finished nothing; interrupting on none of them let it work straight
  // through eight @mentions while the others sat blocked. It stops once, answers, carries on.
  const manager = harness();
  withPending(manager, "a1", [{ ...QUESTION, addressedBy: { id: "a2", handle: "codex" } }]);
  assert.equal(armFor(manager, "a1"), true);

  setCurrentTurn(manager, "a1", { agentInterruptUsed: true });
  assert.equal(armFor(manager, "a1"), false, "the allowance is spent for this turn");
});

test("a pile of agent questions is still only one interruption", () => {
  // The exact live shape: four in a row, from two different agents. They are answered together
  // in the one turn that follows, not one interruption each.
  const manager = harness();
  withPending(manager, "a1", [
    { ...QUESTION, addressedBy: { id: "a2", handle: "codex" } },
    { ...QUESTION, addressedBy: { id: "a3", handle: "copilot" } },
    { ...QUESTION, addressedBy: { id: "a2", handle: "codex" } },
    { ...QUESTION, addressedBy: { id: "a3", handle: "copilot" } },
  ]);
  assert.equal(armFor(manager, "a1"), true);
  setCurrentTurn(manager, "a1", { agentInterruptUsed: true });
  assert.equal(armFor(manager, "a1"), false);
});

test("the operator is never subject to the once-per-turn cap", () => {
  const manager = harness();
  setCurrentTurn(manager, "a1", { agentInterruptUsed: true });
  withPending(manager, "a1", [{ ...QUESTION }]);
  assert.equal(armFor(manager, "a1"), true, "their question still stops the turn");
});

test("an operator question mixed in with agent chatter still arms it", () => {
  const manager = harness();
  withPending(manager, "a1", [
    { ...QUESTION, addressedBy: { id: "a2", handle: "codex" } },
    { ...QUESTION },
  ]);
  assert.equal(armFor(manager, "a1"), true, "the operator is never starved by agent traffic");
});

test("work and fyi never arm it, whoever sent them", () => {
  const manager = harness();
  withPending(manager, "a1", [
    { ...QUESTION, kind: "work" },
    { ...QUESTION, kind: "fyi" },
  ]);
  assert.equal(armFor(manager, "a1"), false);
});

/**
 * The second half of the same problem: not being killed is not enough. An agent answering a
 * question must also finish THAT answer before another agent's question is pasted into the same
 * turn - otherwise one reply tries to address four questions at once, which is what produced
 * "Same stale context replaying - already resolved" in the live run.
 */
function noticeFor(manager: AgentManager, agentId: string, current: unknown, pending: unknown[]) {
  const inner = manager as unknown as {
    agents: Map<string, { currentTurn?: unknown; pendingInbound: unknown[]; activeTurnToken?: string }>;
  };
  const runtime = inner.agents.get(agentId)!;
  runtime.currentTurn = current;
  runtime.pendingInbound = pending;
  runtime.activeTurnToken = "tok";
  const notice = manager.takeInboundNotice(agentId, "tok");
  return { notice, stillPending: runtime.pendingInbound.length };
}

const fromCodex = { id: "q1", kind: "question", receivedAt: "2026-01-01T00:00:00.000Z", prompt: "from codex", addressedBy: { id: "a2", handle: "codex" } };
const fromOperator = { id: "q2", kind: "question", receivedAt: "2026-01-01T00:00:01.000Z", prompt: "from you" };
const someWork = { id: "w1", kind: "work", receivedAt: "2026-01-01T00:00:02.000Z", prompt: "also do this" };

test("an agent's question is held back while another answer is in progress", () => {
  const manager = harness();
  const { notice, stillPending } = noticeFor(manager, "a1", { kind: "question" }, [{ ...fromCodex }]);
  assert.equal(notice, undefined, "nothing is pasted into the in-progress answer");
  assert.equal(stillPending, 1, "and it is kept, to run as its own turn next");
});

test("the operator's question is never held back", () => {
  const manager = harness();
  const { notice } = noticeFor(manager, "a1", { kind: "question" }, [{ ...fromOperator }]);
  assert.match(String(notice), /from you/);
});

test("work still rides along during an answer", () => {
  // Work is context for what the agent is already doing, not a competing demand on the reply.
  const manager = harness();
  const { notice } = noticeFor(manager, "a1", { kind: "question" }, [{ ...someWork }]);
  assert.match(String(notice), /also do this/);
});

test("during ordinary work, every question is delivered as before", () => {
  const manager = harness();
  const { notice, stillPending } = noticeFor(manager, "a1", { kind: "work" }, [{ ...fromCodex }, { ...fromOperator }]);
  assert.match(String(notice), /from codex/);
  assert.match(String(notice), /from you/);
  assert.equal(stillPending, 0);
});

test("a held-back question does not drag the delivered ones back with it", () => {
  const manager = harness();
  const { notice, stillPending } = noticeFor(manager, "a1", { kind: "question" }, [{ ...fromCodex }, { ...someWork }]);
  assert.match(String(notice), /also do this/);
  assert.doesNotMatch(String(notice), /from codex/);
  assert.equal(stillPending, 1, "only the agent question stays behind");
});

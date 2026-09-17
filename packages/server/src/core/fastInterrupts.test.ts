import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentConfig } from "@solace/shared";
import { AgentManager } from "./agentManager";
import { ChatBus } from "./chatBus";
import { ChatStore } from "./chatStore";
import { SettingsStore } from "./settingsStore";

/**
 * v1.5 step 5: the operator preempts unconditionally, and a finding about a file you own
 * preempts too.
 *
 * The failure this file exists for is a silent one, which is why it is pinned so tightly. The
 * old guard at the top of armInterruptTimer was a bare `if (runtime.interruptTimer) return`. So
 * when an AGENT asked a busy agent something first, the four-minute agent-question grace was
 * armed - and the operator's question, arriving seconds later with a human sitting in front of
 * it, inherited that deadline instead of its own fifty seconds. Nothing reported this: the
 * operator simply waited out a grace period that exists to protect turns FROM agents.
 *
 * Reaches into the private interrupt machinery for the same reason interruptStarvation.test.ts
 * does: these are internals with no public surface, and the behaviour under test is which
 * deadline gets armed, which is not observable from outside without waiting minutes in real time.
 */
function agent(id: string, handle: string): AgentConfig {
  return { id, handle, provider: "claude-code", cwd: process.cwd(), trustLevel: "manual" };
}

interface Runtime {
  interruptTimer?: NodeJS.Timeout;
  interruptArmedFor?: { turnId: string; fromOperator: boolean; firesAt: number };
  pendingInbound: unknown[];
  currentTurn?: unknown;
  busy?: boolean;
}

function inner(manager: AgentManager) {
  return manager as unknown as {
    agents: Map<string, Runtime>;
    armInterruptTimer: (r: Runtime) => void;
  };
}

function harness() {
  const agents = [agent("a1", "claude"), agent("a2", "codex")];
  const manager = new AgentManager(
    new ChatBus(),
    new ChatStore(),
    agents,
    undefined,
    [],
    [],
    [],
    // The documented defaults, stated rather than assumed: 50 seconds for the operator, four
    // minutes for an agent. The whole test is the gap between those two numbers.
    new SettingsStore({ interruptGraceSeconds: 50, agentQuestionGraceMinutes: 4 }),
  );
  (manager as unknown as { drainQueue: (id: string) => Promise<void> }).drainQueue = async () => {};
  return manager;
}

/** Arm, read back the deadline that was armed, then disarm so no timer outlives the test. */
function armAndRead(manager: AgentManager, agentId: string) {
  const runtime = inner(manager).agents.get(agentId)!;
  inner(manager).armInterruptTimer(runtime);
  const armed = runtime.interruptArmedFor;
  const inMs = armed ? armed.firesAt - Date.now() : undefined;
  return { armed, inMs };
}

function disarm(manager: AgentManager, agentId: string) {
  const runtime = inner(manager).agents.get(agentId)!;
  if (runtime.interruptTimer) clearTimeout(runtime.interruptTimer);
  runtime.interruptTimer = undefined;
  runtime.interruptArmedFor = undefined;
}

const now = () => new Date().toISOString();
const agentQuestion = (id: string) => ({
  id,
  kind: "question",
  receivedAt: now(),
  prompt: "what palette did you settle on?",
  addressedBy: { id: "a2", handle: "codex" },
});
const operatorQuestion = (id: string) => ({
  id,
  kind: "question",
  receivedAt: now(),
  prompt: "which port is it on?",
});

test("an operator question that arrives BEHIND an agent's does not inherit the agent grace", () => {
  const manager = harness();
  const runtime = inner(manager).agents.get("a1")!;

  runtime.pendingInbound = [agentQuestion("q-agent")];
  const first = armAndRead(manager, "a1");
  assert.equal(first.armed?.fromOperator, false);
  assert.ok(first.inMs! > 200_000, `agent grace should be ~4 min, was ${first.inMs}ms`);

  // The operator now asks something. Nothing else changes.
  runtime.pendingInbound.push(operatorQuestion("q-operator"));
  const second = armAndRead(manager, "a1");

  assert.equal(second.armed?.fromOperator, true, "the armed escalation must now be the operator's");
  assert.equal(second.armed?.turnId, "q-operator");
  assert.ok(second.inMs! <= 50_000, `operator grace should be ~50s, was ${second.inMs}ms`);
  disarm(manager, "a1");
});

test("an agent question arriving behind the operator's never pushes the deadline out", () => {
  // The inverse mistake, and the one that would be easy to introduce while fixing the first:
  // re-arming on every arrival would let a stream of agent chatter keep postponing the
  // operator's escalation forever.
  const manager = harness();
  const runtime = inner(manager).agents.get("a1")!;

  runtime.pendingInbound = [operatorQuestion("q-operator")];
  const first = armAndRead(manager, "a1");
  assert.equal(first.armed?.fromOperator, true);

  runtime.pendingInbound.push(agentQuestion("q-agent"));
  const second = armAndRead(manager, "a1");

  assert.equal(second.armed?.turnId, "q-operator", "the operator's escalation stands");
  assert.ok(second.armed!.firesAt <= first.armed!.firesAt, "and its deadline was not pushed out");
  disarm(manager, "a1");
});

test("a second operator question does not restart the first one's clock", () => {
  const manager = harness();
  const runtime = inner(manager).agents.get("a1")!;

  runtime.pendingInbound = [{ ...operatorQuestion("q1"), receivedAt: new Date(Date.now() - 30_000).toISOString() }];
  const first = armAndRead(manager, "a1");
  assert.ok(first.inMs! <= 21_000, `30s already waited should leave ~20s, was ${first.inMs}ms`);

  runtime.pendingInbound.push(operatorQuestion("q2"));
  const second = armAndRead(manager, "a1");

  assert.equal(second.armed?.turnId, "q1", "the oldest question still owns the deadline");
  assert.ok(second.armed!.firesAt <= first.armed!.firesAt);
  disarm(manager, "a1");
});

test("a finding about a file this agent OWNS preempts, at the agent grace", () => {
  // The owner is the only agent who can act on it, and every minute it waits is a minute the
  // owner may spend building on the premise the finding contradicts. It is not a question, so it
  // never gets the operator's short grace.
  const manager = harness();
  const runtime = inner(manager).agents.get("a1")!;
  runtime.pendingInbound = [
    {
      id: "f1",
      kind: "work",
      class: "finding",
      ownedFileFinding: true,
      receivedAt: now(),
      prompt: "src/api/routes.ts looks wrong - the auth guard is missing",
      addressedBy: { id: "a2", handle: "codex" },
    },
  ];

  const armed = armAndRead(manager, "a1");

  assert.equal(armed.armed?.turnId, "f1");
  assert.ok(armed.inMs! > 200_000, `should ride the agent grace, was ${armed.inMs}ms`);
  disarm(manager, "a1");
});

test("a finding about a file this agent does NOT own never preempts", () => {
  // A finding that fell back to the addressee is ordinary work for somebody who does not own the
  // file. Killing a turn for it would spend a billed resume on a message the recipient cannot
  // even act on authoritatively.
  const manager = harness();
  const runtime = inner(manager).agents.get("a1")!;
  runtime.pendingInbound = [
    {
      id: "f2",
      kind: "work",
      class: "finding",
      receivedAt: now(),
      prompt: "src/api/routes.ts looks wrong",
      addressedBy: { id: "a2", handle: "codex" },
    },
  ];

  assert.equal(armAndRead(manager, "a1").armed, undefined);
});

test("the once-per-turn cap still applies to an owned-file finding", () => {
  // Whatever the class, agent traffic may stop one turn once. A second pile-up waits for the
  // turn that answers the first - that cap is what makes this an interruption and not a livelock.
  const manager = harness();
  const runtime = inner(manager).agents.get("a1")!;
  runtime.pendingInbound = [
    {
      id: "f3",
      kind: "work",
      class: "finding",
      ownedFileFinding: true,
      receivedAt: now(),
      prompt: "src/api/routes.ts looks wrong",
      addressedBy: { id: "a2", handle: "codex" },
    },
  ];
  runtime.currentTurn = { agentInterruptUsed: true };

  assert.equal(armAndRead(manager, "a1").armed, undefined, "the allowance is spent for this turn");
});

test("clearing the interrupt also forgets what it was armed for", () => {
  // Stop/Remove disarm through clearInterruptTimer. A stale interruptArmedFor left behind would
  // make the NEXT operator question compare itself against a deadline that no longer exists and
  // decline to re-arm - i.e. it would reintroduce exactly the bug above, one turn later.
  const manager = harness();
  const runtime = inner(manager).agents.get("a1")!;
  runtime.pendingInbound = [operatorQuestion("q1")];
  armAndRead(manager, "a1");
  assert.notEqual(runtime.interruptArmedFor, undefined);

  manager.stopAgent("a1");

  assert.equal(runtime.interruptArmedFor, undefined);
  assert.equal(runtime.interruptTimer, undefined);
});

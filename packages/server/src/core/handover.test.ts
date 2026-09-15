import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DEFAULT_APP_SETTINGS, sanitizeAppSettings, type AgentConfig } from "@solace/shared";
import {
  AgentManager,
  MAX_HANDOVERS,
  buildHandoverPrompt,
  eligibleHandoverAgents,
  looksLikeUsageExhausted,
  type QueuedTurn,
} from "./agentManager";
import { ChatBus } from "./chatBus";
import { ChatStore, sameWorkingDirectory } from "./chatStore";
import { SettingsStore } from "./settingsStore";

/**
 * Handing one agent's work to another when its provider runs out of usage.
 *
 * No provider turn is ever started: drainQueue is replaced on the instance, exactly as
 * chatRouting.test.ts does, so an enqueued turn stays inspectable in the queue instead of
 * spawning a real CLI and spending the user's tokens to run a unit test. The failure itself is
 * simulated by calling the private attemptHandover with a runtime whose lastError is set - the
 * same state drainQueue puts it in when a turn throws.
 */

const HERE = process.cwd();
const ELSEWHERE = join(HERE, "..", "some-other-project");

function agent(id: string, handle: string, cwd: string, trustLevel: AgentConfig["trustLevel"] = "acceptEdits"): AgentConfig {
  return { id, handle, provider: "claude-code", cwd, trustLevel };
}

function turnFor(chatId: string, overrides: Partial<QueuedTurn> = {}): QueuedTurn {
  return {
    id: "t1",
    prompt: "fix the build",
    replyChannel: { chatId },
    mentionChainDepth: 0,
    kind: "work",
    receivedAt: new Date().toISOString(),
    ...overrides,
  };
}

interface Harness {
  bus: ChatBus;
  manager: AgentManager;
  settings: SettingsStore;
  chatId: string;
  /** Drive the failure path the way drainQueue does: set the error, then attempt the handover. */
  fail: (agentId: string, error: string, turn: QueuedTurn) => string;
  queuedFor: (agentId: string) => QueuedTurn[];
  systemTexts: () => string[];
}

function harness(agents: AgentConfig[], handoverOn: boolean, chats = new ChatStore()): Harness {
  const bus = new ChatBus();
  const chat = chats.listChats()[0] ?? chats.createChat("Work");
  const settings = new SettingsStore({ handoverOnUsageExhausted: handoverOn });
  const manager = new AgentManager(bus, chats, agents, undefined, [], [], [], settings);
  (manager as unknown as { drainQueue: (id: string) => Promise<void> }).drainQueue = async () => {};

  const internals = manager as unknown as {
    agents: Map<string, { config: AgentConfig; lastError?: string; lastFailedTurn?: QueuedTurn; scheduledRetryAt?: string }>;
    attemptHandover: (runtime: unknown, turn: QueuedTurn, resetAt: Date | undefined) => string;
  };

  return {
    bus,
    manager,
    settings,
    chatId: chat.id,
    fail(agentId, error, turn) {
      const runtime = internals.agents.get(agentId)!;
      runtime.lastError = error;
      runtime.lastFailedTurn = turn;
      return internals.attemptHandover.call(manager, runtime, turn, undefined);
    },
    queuedFor(agentId) {
      return manager.getPersistableQueues().find((q) => q.agentId === agentId)?.queued ?? [];
    },
    systemTexts() {
      return bus.getHistory().filter((m) => m.authorId === "system").map((m) => m.text);
    },
  };
}

test("handover is opt-in and off by default", () => {
  assert.equal(DEFAULT_APP_SETTINGS.handoverOnUsageExhausted, false);
  assert.equal(sanitizeAppSettings({}).handoverOnUsageExhausted, false);
  assert.equal(sanitizeAppSettings(undefined).handoverOnUsageExhausted, false);
  // A non-boolean must not be half-believed into an on state.
  assert.equal(sanitizeAppSettings({ handoverOnUsageExhausted: "yes" }).handoverOnUsageExhausted, false);
  assert.equal(sanitizeAppSettings({ handoverOnUsageExhausted: true }).handoverOnUsageExhausted, true);

  // And with the default store, a real usage limit still hands nothing to the idle agent
  // sitting in the same directory.
  const agents = [agent("a1", "claude", HERE), agent("a2", "codex", HERE)];
  const h = harness(agents, false);
  const result = h.fail("a1", "Claude usage limit reached. Your limit will reset at 10:50 PM.", turnFor(h.chatId));

  assert.equal(result, "not-applicable");
  assert.deepEqual(h.queuedFor("a2"), []);
  assert.deepEqual(h.systemTexts(), [], "nothing is announced, because nothing happened");
});

test("only an agent in the SAME working directory is eligible", () => {
  const from = agent("a1", "claude", HERE);
  const roster = [from, agent("a2", "codex", ELSEWHERE), agent("a3", "gemini", HERE)];

  const eligible = eligibleHandoverAgents(from, roster, turnFor("c"));

  assert.deepEqual(eligible.map((a) => a.handle), ["gemini"]);
});

test("the cwd comparison is case- and separator-insensitive, like agentInProject", () => {
  assert.ok(sameWorkingDirectory("C:\\Users\\x\\site", "c:/Users/x/site"));
  assert.ok(sameWorkingDirectory("C:\\Users\\x\\site\\", "C:\\Users\\x\\site"));
  // The "/site2" prefix trap: containment must not be mistaken for sameness.
  assert.equal(sameWorkingDirectory("C:\\Users\\x\\site", "C:\\Users\\x\\site2"), false);
  // Nor is a subdirectory the same directory - that CLI runs somewhere else.
  assert.equal(sameWorkingDirectory("C:\\Users\\x\\site\\packages", "C:\\Users\\x\\site"), false);
});

test("an exhausted agent's work goes to an agent in the same directory, and it is announced", () => {
  const agents = [agent("a1", "claude", HERE), agent("a2", "codex", HERE)];
  const h = harness(agents, true);
  const turn = turnFor(h.chatId);

  const result = h.fail("a1", "Claude usage limit reached. Your limit will reset at 10:50 PM.", turn);

  assert.equal(result, "handed-over");
  const queued = h.queuedFor("a2");
  assert.equal(queued.length, 1, "codex now owns exactly one turn");
  assert.equal(queued[0].handover?.count, 1);
  assert.deepEqual(queued[0].handover?.agentIds, ["a1", "a2"]);
  assert.notEqual(queued[0].id, turn.id, "a new turn id, so the original exists in exactly one queue");
  assert.match(queued[0].prompt, /fix the build/);

  const announced = h.systemTexts();
  assert.equal(announced.length, 1);
  assert.match(announced[0], /@codex is picking up @claude's work/);
  assert.match(announced[0], /out of usage/);
  assert.match(announced[0], /acceptEdits/, "the receiving agent's OWN permission level is stated");
});

test("no eligible agent means no handover, and the chat says so and why", () => {
  const agents = [agent("a1", "claude", HERE), agent("a2", "codex", ELSEWHERE)];
  const h = harness(agents, true);

  const result = h.fail("a1", "Claude usage limit reached. Your limit will reset at 10:50 PM.", turnFor(h.chatId));

  assert.equal(result, "declined");
  assert.deepEqual(h.queuedFor("a2"), [], "the agent in another project is NOT given the work");
  const announced = h.systemTexts();
  assert.equal(announced.length, 1);
  assert.match(announced[0], /no other agent works in/);
  assert.match(announced[0], /waiting/i);
});

test("a declined handover still names the reset time when the provider gave one", () => {
  const agents = [agent("a1", "claude", HERE)];
  const h = harness(agents, true);
  const internals = h.manager as unknown as {
    agents: Map<string, { lastError?: string }>;
    attemptHandover: (runtime: unknown, turn: QueuedTurn, resetAt: Date | undefined) => string;
  };
  const runtime = internals.agents.get("a1")!;
  runtime.lastError = "Claude usage limit reached. Your limit will reset at 10:50 PM.";
  const resetAt = new Date(2026, 0, 1, 22, 50, 0, 0);

  const result = internals.attemptHandover.call(h.manager, runtime, turnFor(h.chatId), resetAt);

  assert.equal(result, "declined");
  assert.match(h.systemTexts()[0], new RegExp(resetAt.toLocaleTimeString().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("work cannot bounce onward forever - the chain is capped and stops with an explanation", () => {
  const agents = [agent("a1", "claude", HERE), agent("a2", "codex", HERE), agent("a3", "gemini", HERE), agent("a4", "qwen", HERE)];
  const h = harness(agents, true);
  const error = "Claude usage limit reached. Your limit will reset at 10:50 PM.";

  // Hop 1: a1 -> a2.
  assert.equal(h.fail("a1", error, turnFor(h.chatId)), "handed-over");
  const first = h.queuedFor("a2")[0];
  // Hop 2: a2 -> a3, carrying the chain forward.
  assert.equal(h.fail("a2", error, first), "handed-over");
  const second = h.queuedFor("a3")[0];
  assert.equal(second.handover?.count, MAX_HANDOVERS);
  assert.deepEqual(second.handover?.agentIds, ["a1", "a2", "a3"]);

  // Hop 3 would exceed the cap, even though a4 is idle in the same directory.
  assert.equal(h.fail("a3", error, second), "declined");
  assert.deepEqual(h.queuedFor("a4"), [], "a fourth agent is never drawn in");
  const last = h.systemTexts().at(-1)!;
  assert.match(last, new RegExp(`handed over ${MAX_HANDOVERS} times`));
  assert.match(last, /NOT finished/);
});

test("an agent that already had this work is never handed it back", () => {
  const from = agent("a1", "claude", HERE);
  const other = agent("a2", "codex", HERE);
  const turn = turnFor("c", { handover: { ofTurnId: "t0", count: 1, agentIds: ["a2", "a1"] } });

  assert.deepEqual(eligibleHandoverAgents(from, [from, other], turn), [], "a2 already ran out on this");
});

test("a non-quota error never triggers a handover", () => {
  const agents = [agent("a1", "claude", HERE), agent("a2", "codex", HERE)];
  for (const error of [
    "SyntaxError: Unexpected token '}'",
    "spawn claude ENOENT",
    "turn stopped: no output for 5 minutes, so it was treated as stuck",
    "Error: ENOSPC: no space left on device",
  ]) {
    const h = harness(agents, true);
    const result = h.fail("a1", error, turnFor(h.chatId));
    assert.equal(result, "not-applicable", `"${error}" must not read as exhaustion`);
    assert.deepEqual(h.queuedFor("a2"), [], `"${error}" must not burn a second agent`);
    assert.deepEqual(h.systemTexts(), []);
  }
});

test("exhaustion detection is exactly the test that already schedules a rate-limit retry", () => {
  assert.ok(looksLikeUsageExhausted("Claude usage limit reached. Your limit will reset at 10:50 PM."));
  assert.ok(looksLikeUsageExhausted("429 rate limit exceeded"));
  assert.equal(looksLikeUsageExhausted("SyntaxError: Unexpected token"), false);
  assert.equal(looksLikeUsageExhausted(undefined), false);
});

test("a handed-over turn does not also stay armed on the agent that failed", () => {
  // This is the double-execution guard: the original agent must lose both its scheduled retry
  // and its manual Retry affordance for a turn somebody else now owns.
  const agents = [agent("a1", "claude", HERE), agent("a2", "codex", HERE)];
  const h = harness(agents, true);
  const internals = h.manager as unknown as {
    agents: Map<string, { lastFailedTurn?: QueuedTurn; scheduledRetryAt?: string }>;
  };

  h.fail("a1", "Claude usage limit reached. Your limit will reset at 10:50 PM.", turnFor(h.chatId));

  const runtime = internals.agents.get("a1")!;
  assert.equal(runtime.lastFailedTurn, undefined);
  assert.equal(runtime.scheduledRetryAt, undefined);
  assert.equal(h.manager.retryAgent("a1"), false, "Retry offers nothing, because nothing is owed here");
  assert.deepEqual(h.queuedFor("a1"), [], "and the work was not left queued on the failed agent either");
});

test("a plan-mode agent can receive work, but is picked last and the limitation is stated", () => {
  const from = agent("a1", "claude", HERE);
  const planner = agent("a2", "planner", HERE, "plan");
  const writer = agent("a3", "codex", HERE);

  assert.deepEqual(
    eligibleHandoverAgents(from, [from, planner, writer], turnFor("c")).map((a) => a.handle),
    ["codex", "planner"],
    "an agent that can actually change files comes first",
  );

  const h = harness([from, planner], true);
  h.fail("a1", "Claude usage limit reached. Your limit will reset at 10:50 PM.", turnFor(h.chatId));
  const announced = h.systemTexts()[0];
  assert.match(announced, /plan mode/);
  assert.match(announced, /cannot change any files/);
});

test("a chat filed under a project never acquires an agent it cannot reach", () => {
  // cwd equality already implies this in practice; asserted because the two rules are separate
  // and a future change to one must not silently widen the other.
  const chats = new ChatStore([], [{ id: "p1", name: "site", path: HERE, createdAt: "2025-01-01T00:00:00.000Z" }]);
  chats.createChat("Site", "p1");
  const agents = [agent("a1", "claude", HERE), agent("a2", "codex", HERE)];
  const h = harness(agents, true, chats);

  assert.equal(h.fail("a1", "Claude usage limit reached.", turnFor(h.chatId)), "handed-over");
  assert.equal(h.queuedFor("a2").length, 1);
});

test("the handover prompt carries the real request, not a nested pile of preambles", () => {
  const once = buildHandoverPrompt(turnFor("c", { prompt: "fix the build in landing-page-test" }), "claude");
  assert.match(once, /fix the build in landing-page-test/);

  // Handing on an already-handed-over turn must re-state the ORIGINAL work, not the last
  // preamble - otherwise the real task is buried deeper on every hop.
  const twice = buildHandoverPrompt(turnFor("c", { prompt: once }), "codex");
  assert.match(twice, /fix the build in landing-page-test$/);
  assert.equal(twice.split("was given this work").length, 2, "exactly one preamble");
});

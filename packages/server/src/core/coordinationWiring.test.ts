import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig } from "@solace/shared";
import { AgentManager } from "./agentManager";
import { ChatBus } from "./chatBus";
import { ChatStore } from "./chatStore";
import { CoordinationBoard } from "./coordination";

/**
 * The wiring, not the board: that a tool call from a real in-flight turn reaches the board, and
 * that the board's answer turns into the thing it is supposed to (a queued turn, a system
 * message, a refused write).
 */
function agent(id: string, handle: string, cwd = process.cwd()): AgentConfig {
  return { id, handle, provider: "claude-code", cwd, trustLevel: "manual" };
}

function harness(cwd = process.cwd()) {
  const agents = [agent("a1", "claude", cwd), agent("a2", "codex", cwd), agent("a3", "copilot", cwd)];
  const bus = new ChatBus();
  const chats = new ChatStore();
  const board = new CoordinationBoard();
  const manager = new AgentManager(bus, chats, agents, undefined, [], [], [], undefined, board);
  (manager as unknown as { drainQueue: (id: string) => Promise<void> }).drainQueue = async () => {};
  const chat = chats.createChat("Build");

  /** Put an agent into the state a solace tool call requires: an in-flight turn with a token. */
  const startTurn = (agentId: string) => {
    const runtime = (manager as unknown as { agents: Map<string, Record<string, unknown>> }).agents.get(agentId)!;
    runtime.activeTurnToken = `tok-${agentId}`;
    runtime.currentTurn = { id: `t-${agentId}`, kind: "work", replyChannel: { chatId: chat.id }, prompt: "x" };
    runtime.busy = true;
    return `tok-${agentId}`;
  };

  const queuedFor = (agentId: string) =>
    manager.getPersistableQueues().find((q) => q.agentId === agentId)?.queued ?? [];

  return { manager, bus, chats, board, chat, startTurn, queuedFor, agents };
}

test("a claim from a real turn is recorded and announced to the user", () => {
  const h = harness();
  const token = h.startTurn("a1");
  const res = h.manager.claimFiles("a1", token, ["src/checker.py"], "core logic");
  assert.equal(res.ok, true);
  assert.deepEqual(h.board.forChat(h.chat.id).claims[0].paths, ["src/checker.py"]);
  // Every coordination act is visible to the user rather than happening invisibly.
  const posted = h.bus.getHistoryFor({ chatId: h.chat.id });
  assert.match(posted.at(-1)!.text, /@claude is now working in: src\/checker\.py \(core logic\)/);
});

test("a claim without an in-flight turn is refused", () => {
  const h = harness();
  const res = h.manager.claimFiles("a1", "bogus-token", ["x.py"]);
  assert.deepEqual(res, { ok: false, error: "no matching in-flight turn" });
});

test("a second agent claiming an owned path is told who owns it, and claims nothing", () => {
  const h = harness();
  h.manager.claimFiles("a1", h.startTurn("a1"), ["src/checker.py"]);
  const res = h.manager.claimFiles("a2", h.startTurn("a2"), ["src/checker.py"]);
  assert.ok(res.ok);
  assert.deepEqual(res.claimed, []);
  assert.deepEqual(res.conflicts, [{ path: "src/checker.py", owner: "claude" }]);
});

test("publishing a contract wakes whoever was blocked on it, with a real queued turn", () => {
  // The live failure this whole feature exists for: codex said it was blocked until the checker
  // contract landed, then sat idle after it landed because nobody thought to name it.
  const h = harness();
  h.manager.blockOn("a2", h.startTurn("a2"), "contract", "checker", "need the signature");
  assert.equal(h.queuedFor("a2").length, 0, "blocked, not queued");

  const res = h.manager.postContract("a1", h.startTurn("a1"), "checker API", "check_url(url, options)");
  assert.ok(res.ok);
  assert.deepEqual(res.woken, ["a2"]);

  const queued = h.queuedFor("a2");
  assert.equal(queued.length, 1, "the wake is a real turn, not just a message");
  assert.match(queued[0].prompt, /waiting on "checker"/);
  assert.match(queued[0].prompt, /@claude posted the contract "checker API"/);
  assert.deepEqual(h.board.forChat(h.chat.id).blocks, [], "and the block is cleared");
});

test("an unrelated contract wakes nobody", () => {
  const h = harness();
  h.manager.blockOn("a2", h.startTurn("a2"), "contract", "checker");
  const res = h.manager.postContract("a1", h.startTurn("a1"), "design tokens", "--bg: #111");
  assert.ok(res.ok);
  assert.deepEqual(res.woken, []);
  assert.equal(h.queuedFor("a2").length, 0);
});

test("blocking on something that already happened wakes immediately instead of parking forever", () => {
  const dir = mkdtempSync(join(tmpdir(), "solace-wiring-"));
  writeFileSync(join(dir, "checker.py"), "x");
  const h = harness(dir);
  const res = h.manager.blockOn("a2", h.startTurn("a2"), "file", "checker.py");
  assert.ok(res.ok);
  assert.equal(res.wokenImmediately, true);
  assert.equal(h.queuedFor("a2").length, 1);
});

test("a contract is pinned into every other agent's context, and is not re-asked", () => {
  const h = harness();
  h.manager.postContract("a1", h.startTurn("a1"), "checker API", "check_url(url, options)");
  const prompt = (
    h.manager as unknown as { buildGroupPrompt: (c: string, f: string, t: string, a: string) => string }
  ).buildGroupPrompt(h.chat.id, "you", "carry on", "a2");
  assert.match(prompt, /Agreed contracts/);
  assert.match(prompt, /check_url\(url, options\)/);
  assert.match(prompt, /do not ask for them again/);
});

test("claims appear in other agents' context as a do-not-edit list, and as ownership in your own", () => {
  const h = harness();
  h.manager.claimFiles("a1", h.startTurn("a1"), ["src/checker.py"]);
  const build = (forAgent: string) =>
    (
      h.manager as unknown as { buildGroupPrompt: (c: string, f: string, t: string, a: string) => string }
    ).buildGroupPrompt(h.chat.id, "you", "carry on", forAgent);

  assert.match(build("a2"), /Files other agents own: @claude -> src\/checker\.py/);
  assert.match(build("a2"), /Do not edit those/);
  assert.match(build("a1"), /You own: src\/checker\.py/);
});

test("an announcement costs nobody a turn, and is shown once", () => {
  const h = harness();
  const res = h.manager.announce("a1", h.startTurn("a1"), "checker.py has landed");
  assert.ok(res.ok);
  // The whole point: an ordinary unaddressed message would have queued a turn for both others.
  assert.equal(h.queuedFor("a2").length, 0);
  assert.equal(h.queuedFor("a3").length, 0);

  const build = () =>
    (
      h.manager as unknown as { buildGroupPrompt: (c: string, f: string, t: string, a: string) => string }
    ).buildGroupPrompt(h.chat.id, "you", "carry on", "a2");
  assert.match(build(), /Since your last turn: @claude: checker\.py has landed/);
  assert.doesNotMatch(build(), /Since your last turn/, "not re-pasted on the next turn");
});

test("an agent never sees its own announcement replayed to it", () => {
  const h = harness();
  h.manager.announce("a1", h.startTurn("a1"), "mine");
  const prompt = (
    h.manager as unknown as { buildGroupPrompt: (c: string, f: string, t: string, a: string) => string }
  ).buildGroupPrompt(h.chat.id, "you", "carry on", "a1");
  assert.doesNotMatch(prompt, /Since your last turn/);
});

test("a chat with an untouched board adds nothing to the prompt", () => {
  // A two-agent chat that never coordinates must not pay a prompt tax for the feature existing.
  const h = harness();
  const prompt = (
    h.manager as unknown as { buildGroupPrompt: (c: string, f: string, t: string, a: string) => string }
  ).buildGroupPrompt(h.chat.id, "you", "hello", "a1");
  assert.doesNotMatch(prompt, /Agreed contracts|Files other agents own|Coordination tools/);
});

test("deleting an agent releases its lane and drops its block", () => {
  const h = harness();
  h.manager.claimFiles("a1", h.startTurn("a1"), ["src/checker.py"]);
  h.manager.blockOn("a1", h.startTurn("a1"), "agent", "codex");
  h.manager.removeAgent("a1");
  assert.deepEqual(h.board.forChat(h.chat.id).claims, []);
  assert.deepEqual(h.board.forChat(h.chat.id).blocks, []);
});

test("releasing a lane lets someone else take it", () => {
  const h = harness();
  h.manager.claimFiles("a1", h.startTurn("a1"), ["src/checker.py"]);
  const released = h.manager.releaseFiles("a1", h.startTurn("a1"));
  assert.ok(released.ok);
  assert.equal(released.released, 1);
  const res = h.manager.claimFiles("a2", h.startTurn("a2"), ["src/checker.py"]);
  assert.ok(res.ok);
  assert.deepEqual(res.claimed, ["src/checker.py"]);
});

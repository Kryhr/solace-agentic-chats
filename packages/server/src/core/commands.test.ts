import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentConfig, ChatChannel } from "@solace/shared";
import { COMMAND_DEFINITIONS, helpText } from "@solace/shared";
import { AgentManager } from "./agentManager";
import { ArchiveStore } from "./archiveStore";
import { ChatBus } from "./chatBus";
import { ChatStore } from "./chatStore";
import { CoordinationBoard } from "./coordination";
import { tryHandleCommand, type CommandContext } from "./commands";

/**
 * The rule these tests exist to hold: a command either does the real thing or says it could
 * not. Nothing here may post an answer it did not compute - a board it cannot see must not
 * render as an empty board, and "stopped" must not be printed for an agent that was not
 * running. Each command is exercised through tryHandleCommand exactly as the HTTP routes
 * call it, so a command that is wired up wrongly fails here rather than only in the browser.
 */

function agent(id: string, handle: string): AgentConfig {
  return { id, handle, provider: "claude-code", cwd: process.cwd(), trustLevel: "manual" };
}

function harness() {
  const configs = [agent("a1", "claude"), agent("a2", "codex")];
  const bus = new ChatBus();
  const chats = new ChatStore();
  const board = new CoordinationBoard();
  const agents = new AgentManager(bus, chats, configs, undefined, [], [], [], undefined, board);
  // Turns must never actually run in a unit test - every command under test is about state,
  // not about generation.
  (agents as unknown as { drainQueue: (id: string) => Promise<void> }).drainQueue = async () => {};
  const archive = new ArchiveStore();
  const chat = chats.createChat("Build");

  const run = (text: string, channel: ChatChannel, withBoard = true) =>
    tryHandleCommand(text, { channel, agents, bus, chats, archive, board: withBoard ? board : undefined } as CommandContext);

  const lastIn = (channel: ChatChannel) => bus.getHistoryFor(channel).at(-1)?.text ?? "";

  return { agents, bus, chats, board, archive, chat, run, lastIn, chatChannel: { chatId: chat.id } as ChatChannel };
}

// --- the single-source property ------------------------------------------------------------

test("every command the autocomplete offers is one /help also lists", () => {
  // The drift this file's shared definitions were introduced to stop: /trust existed on the
  // server and not in the client's list, so it was implemented and undiscoverable.
  const help = helpText();
  for (const command of COMMAND_DEFINITIONS) {
    assert.ok(help.includes(`/${command.name}`), `/${command.name} is missing from /help`);
  }
});

test("no command the menu offers answers with 'unknown command'", async () => {
  // Scope is honoured so nothing is offered where it can only refuse, but a command that is
  // defined and not implemented at all would be a dead menu row anywhere.
  const h = harness();
  for (const command of COMMAND_DEFINITIONS) {
    const channel: ChatChannel = command.scope === "hub" ? { agentId: "a1" } : h.chatChannel;
    await h.run(`/${command.name}`, channel);
    assert.doesNotMatch(h.lastIn(channel), /unknown command/, `/${command.name} is defined but not implemented`);
  }
});

// --- /board ---------------------------------------------------------------------------------

test("/board on an untouched chat says the board is empty", async () => {
  const h = harness();
  await h.run("/board", h.chatChannel);
  assert.match(h.lastIn(h.chatChannel), /board is empty/i);
});

test("/board reports the real claims, contracts and blocks the board holds", async () => {
  const h = harness();
  const [claude, codex] = h.agents.listAgents();
  h.board.claim(h.chat.id, claude, ["src/checker.py"], "core logic");
  h.board.postContract(h.chat.id, codex, "Checker API", "returns a Result");
  h.board.blockOn(h.chat.id, codex, "contract", "Checker API", "need the shape first");

  await h.run("/board", h.chatChannel);
  const text = h.lastIn(h.chatChannel);
  assert.match(text, /claude - src\/checker\.py \(core logic\)/);
  assert.match(text, /"Checker API" - by codex/);
  assert.match(text, /codex - waiting for a contract matching "Checker API"/);
  assert.match(text, /need the shape first/);
});

test("/board describes each kind of block in the terms that kind actually means", async () => {
  const h = harness();
  const [claude] = h.agents.listAgents();
  h.board.blockOn(h.chat.id, claude, "file", "dist/out.js");
  await h.run("/board", h.chatChannel);
  assert.match(h.lastIn(h.chatChannel), /waiting for dist\/out\.js to exist/);

  h.board.blockOn(h.chat.id, claude, "agent", "codex");
  await h.run("/board", h.chatChannel);
  assert.match(h.lastIn(h.chatChannel), /waiting for @codex to post/);
});

test("/board refuses in an agent's hub rather than showing another chat's board", async () => {
  const h = harness();
  const hub: ChatChannel = { agentId: "a1" };
  await h.run("/board", hub);
  assert.match(h.lastIn(hub), /only works in a chat/);
});

test("/board with no board wired up says so instead of printing an empty board", async () => {
  // The distinction that matters: "nothing is claimed" and "I cannot see the board" are
  // different statements, and rendering the second as the first is the exact failure mode
  // these commands are not allowed to have.
  const h = harness();
  const [claude] = h.agents.listAgents();
  h.board.claim(h.chat.id, claude, ["src/checker.py"]);
  await h.run("/board", h.chatChannel, false);
  const text = h.lastIn(h.chatChannel);
  assert.match(text, /isn't available/);
  assert.doesNotMatch(text, /empty/i);
});

// --- /stop ----------------------------------------------------------------------------------

test("/stop says nothing was running when nothing was running", async () => {
  // Never an unconditional "stopped." - stopAgent reports whether there was an in-flight turn
  // at all, and that is what gets printed.
  const h = harness();
  await h.run("/stop", h.chatChannel);
  const text = h.lastIn(h.chatChannel);
  assert.match(text, /Nothing running to stop/);
  assert.match(text, /claude/);
  assert.match(text, /codex/);
});

test("/stop really cancels an in-flight turn, and only the named agent's", async () => {
  const h = harness();
  const runtimes = (h.agents as unknown as { agents: Map<string, { activeController?: AbortController }> }).agents;
  const claudeController = new AbortController();
  const codexController = new AbortController();
  runtimes.get("a1")!.activeController = claudeController;
  runtimes.get("a2")!.activeController = codexController;

  await h.run("/stop @claude", h.chatChannel);
  assert.equal(claudeController.signal.aborted, true, "the named agent's turn was really aborted");
  assert.equal(codexController.signal.aborted, false, "an agent nobody named was left alone");
  assert.match(h.lastIn(h.chatChannel), /Stopped: claude/);
});

test("/stop in an agent's own hub needs no handle", async () => {
  const h = harness();
  const runtimes = (h.agents as unknown as { agents: Map<string, { activeController?: AbortController }> }).agents;
  const controller = new AbortController();
  runtimes.get("a1")!.activeController = controller;
  const hub: ChatChannel = { agentId: "a1" };
  await h.run("/stop", hub);
  assert.equal(controller.signal.aborted, true);
  assert.match(h.lastIn(hub), /Stopped: claude/);
});

test("/stop names an unknown handle rather than silently stopping everyone", async () => {
  const h = harness();
  const runtimes = (h.agents as unknown as { agents: Map<string, { activeController?: AbortController }> }).agents;
  const controller = new AbortController();
  runtimes.get("a1")!.activeController = controller;
  await h.run("/stop @nobody", h.chatChannel);
  assert.equal(controller.signal.aborted, false);
  assert.match(h.lastIn(h.chatChannel), /no agent called @nobody/);
});

// --- /retry ---------------------------------------------------------------------------------

test("/retry says there is nothing to retry when no turn has failed", async () => {
  const h = harness();
  await h.run("/retry @claude", h.chatChannel);
  assert.match(h.lastIn(h.chatChannel), /No failed turn to retry: claude/);
});

test("/retry re-queues the turn that actually failed", async () => {
  const h = harness();
  const runtimes = (h.agents as unknown as {
    agents: Map<string, { lastFailedTurn?: unknown; queue: unknown[] }>;
  }).agents;
  runtimes.get("a1")!.lastFailedTurn = {
    id: "t1",
    prompt: "build the checker",
    replyChannel: h.chatChannel,
    kind: "work",
    mentionChainDepth: 0,
  };

  await h.run("/retry @claude", h.chatChannel);
  assert.match(h.lastIn(h.chatChannel), /Re-running the last failed turn for: claude/);
  const queued = h.agents.getPersistableQueues().find((q) => q.agentId === "a1")?.queued ?? [];
  assert.equal(queued.length, 1, "the failed turn was really re-queued");
  assert.match(queued[0].prompt, /build the checker/);
});

// --- /providers -----------------------------------------------------------------------------

test("/providers reports every CLI it probed, and claims only that the binary ran", async () => {
  // A real `--version` spawn per provider, so the pass/fail per row depends on this machine.
  // What is asserted is the shape and the honesty, not which CLIs happen to be installed here.
  const h = harness();
  await h.run("/providers", h.chatChannel);
  const text = h.lastIn(h.chatChannel);
  for (const provider of ["claude-code", "codex-cli", "gemini-cli", "qwen-code", "copilot-cli", "opencode"]) {
    assert.ok(text.includes(provider), `${provider} is missing from /providers`);
  }
  // The line that keeps this row from being read as "these agents are ready to go".
  assert.match(text, /does not prove any of them is signed in/);
  for (const line of text.split("\n").filter((l) => l.includes(" - "))) {
    assert.ok(
      /installed · .+|not found on PATH · .+/.test(line),
      `a provider line states neither a real version nor a real install command: ${line}`,
    );
  }
});

// --- scope ----------------------------------------------------------------------------------

test("every hub-only command refuses in a chat, and says where it does work", async () => {
  const h = harness();
  for (const command of COMMAND_DEFINITIONS.filter((c) => c.scope === "hub")) {
    await h.run(`/${command.name} x`, h.chatChannel);
    assert.match(h.lastIn(h.chatChannel), /hub/, `/${command.name} should explain it is hub-only`);
  }
});

test("a chat-only command is never offered in a hub, and a hub-only one never in a chat", () => {
  // Scope is what stops the menu offering something that can only refuse where the user is
  // typing, so it has to be right on every definition, not just the new ones.
  for (const command of COMMAND_DEFINITIONS) {
    assert.ok(["hub", "chat", "both"].includes(command.scope), `/${command.name} has no usable scope`);
  }
  assert.equal(COMMAND_DEFINITIONS.find((c) => c.name === "board")?.scope, "chat");
  assert.equal(COMMAND_DEFINITIONS.find((c) => c.name === "model")?.scope, "hub");
});

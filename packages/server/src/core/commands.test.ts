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
import { ProgressDigest } from "./progressDigest";
import { SettingsStore } from "./settingsStore";
import type { BoardTask, ChatFeatures } from "./chatFeatures";

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

  // The digest counts real tool events; nothing here generates text, so a test can feed it the
  // same (toolName, input) pairs an adapter would and read the result back through /summary.
  const digest = new ProgressDigest(new SettingsStore(), () => {});
  // /accounts otherwise spawns every provider's real CLI to ask who is signed in. A unit test
  // must never start a coding-agent binary, so the probe is injected - see CommandContext.
  const accounts: CommandContext["accounts"] = async () => [
    { label: undefined, loggedIn: true, email: "default@example.com" },
    { label: "work", loggedIn: true, email: "work@example.com", subscriptionType: "max" },
  ];

  const run = (text: string, channel: ChatChannel, withBoard = true, features?: ChatFeatures) =>
    tryHandleCommand(text, {
      channel,
      agents,
      bus,
      chats,
      archive,
      board: withBoard ? board : undefined,
      features,
      digest,
      accounts,
    } as CommandContext);

  const lastIn = (channel: ChatChannel) => bus.getHistoryFor(channel).at(-1)?.text ?? "";

  return { agents, bus, chats, board, archive, chat, digest, run, lastIn, chatChannel: { chatId: chat.id } as ChatChannel };
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

// --- /help, and the refusal ------------------------------------------------------------------

test("/help lists every command, with its argument shape and what it does", async () => {
  // /help is the only discovery surface for anyone who does not know to type "/", so a command
  // missing from it is a command nobody finds.
  const h = harness();
  await h.run("/help", h.chatChannel);
  const text = h.lastIn(h.chatChannel);
  for (const command of COMMAND_DEFINITIONS) {
    assert.ok(text.includes(`/${command.name}`), `/${command.name} is missing from /help`);
    assert.ok(text.includes(command.help), `/${command.name} has no help text in /help`);
    if (command.hint) assert.ok(text.includes(command.hint), `/${command.name} does not show its arguments`);
  }
});

test("an unknown command is refused, and says how to find the real ones", async () => {
  // It must not fall through to submitMessage either: "/tsks build it" would otherwise be sent
  // to every agent in the chat as a prompt, costing a real turn each for a typo.
  const h = harness();
  const handled = await h.run("/tsks do the thing", h.chatChannel);
  assert.equal(handled, true, "an unrecognised slash command is still handled here, never routed to agents");
  const text = h.lastIn(h.chatChannel);
  assert.match(text, /unknown command \/tsks/);
  assert.match(text, /\/help/);
  const queued = h.agents.getPersistableQueues().flatMap((q) => q.queued);
  assert.equal(queued.length, 0, "a typo must not spend a turn");
});

// --- /fyi -------------------------------------------------------------------------------------

function queuedFor(h: ReturnType<typeof harness>, agentId: string) {
  return (h.agents as unknown as { agents: Map<string, { queue: { prompt: string; kind?: string }[] }> }).agents.get(agentId)!.queue;
}

test("/fyi costs nobody a turn", async () => {
  // The whole point of the command. 65% of a measured session's agent messages were broadcast
  // nobody asked for, and every one of them gave every addressed agent a real billed turn. An
  // FYI is the case where the sender explicitly does not want that.
  const h = harness();
  await h.run("/fyi the palette lives in tokens.css, do not invent a second one", h.chatChannel);
  assert.equal(queuedFor(h, "a1").length, 0);
  assert.equal(queuedFor(h, "a2").length, 0);
});

test("/fyi still actually reaches the agents, rather than being visible only to you", async () => {
  // A plain system message would have been the easy version of this command and a silent
  // nothing: agents are never handed chat history, so they would never have seen it. Posting it
  // as an announcement is what makes coordinationBlock fold it into each agent's next turn.
  const h = harness();
  await h.run("/fyi the palette lives in tokens.css", h.chatChannel);
  const announcement = h.bus.getHistoryFor(h.chatChannel).find((m) => m.agentKind === "announcement");
  assert.ok(announcement, "an /fyi nothing will ever read is not context, it is a note to yourself");
  assert.equal(announcement.text, "the palette lives in tokens.css");
});

test("/fyi does not quietly widen a scope you set deliberately", () => {
  // The trap this avoids: the chat's scope is derived from the @mentions on your most recent
  // message, so an /fyi filed as a user message - which has none - would silently un-scope a
  // chat you had narrowed to two agents, and the next agent reply would summon everybody. It is
  // filed as a system message for exactly this reason; see the comment on the post in /fyi.
  const h = harness();
  h.agents.submitMessage(h.chat.id, "user", "you", "@claude take the landing page");
  return h.run("/fyi the palette lives in tokens.css", h.chatChannel).then(() => {
    // An agent trying to pull in somebody outside the scope must still be refused.
    h.agents.submitMessage(h.chat.id, "a1", "claude", "@codex can you take the API");
    const refusal = h.bus.getHistoryFor(h.chatChannel).find((m) => m.text.includes("you scoped this work to"));
    assert.ok(refusal, "the scope set before the /fyi must still be in force after it");
  });
});

// --- /ask -------------------------------------------------------------------------------------

test("/ask declares the message a question rather than leaving it to be guessed", async () => {
  // classifyIncoming infers from wording, which is a guess; whether a message is a question
  // decides whether it may interrupt a running turn, which is expensive either way.
  const h = harness();
  await h.run("/ask @codex which port did you take", h.chatChannel);
  const queued = queuedFor(h, "a2");
  assert.equal(queued.length, 1);
  assert.equal(queued[0].kind, "question");
  assert.equal(queuedFor(h, "a1").length, 0, "only the agent asked gets a turn");
});

test("/ask names an unknown handle instead of broadcasting to everyone", async () => {
  const h = harness();
  await h.run("/ask @nobody are you there", h.chatChannel);
  assert.match(h.lastIn(h.chatChannel), /no agent called @nobody/);
  assert.equal(queuedFor(h, "a1").length + queuedFor(h, "a2").length, 0);
});

// --- /interrupt ------------------------------------------------------------------------------

test("/interrupt preempts immediately, with no grace period", async () => {
  // The graced path waits interruptGraceSeconds (50 by default) for the agent to pick the
  // message up between tool calls. /interrupt is for when it is confidently doing the wrong
  // thing and you are not willing to wait fifty seconds to say so - so the abort has to happen
  // inside this call, not on a timer.
  const h = harness();
  const runtimes = (h.agents as unknown as {
    agents: Map<string, { busy: boolean; activeController?: AbortController; abortKind?: string }>;
  }).agents;
  const controller = new AbortController();
  runtimes.get("a1")!.busy = true;
  runtimes.get("a1")!.activeController = controller;

  await h.run("/interrupt @claude stop, that is the wrong file", h.chatChannel);
  assert.equal(controller.signal.aborted, true, "the turn is aborted synchronously, not after a grace period");
  assert.equal(runtimes.get("a1")!.abortKind, "interrupt", "interrupt, not stop - so the work is resumed afterwards");
  assert.match(h.lastIn(h.chatChannel), /resumes what it was doing/);
});

test("/interrupt with nothing running says so rather than claiming it stopped something", async () => {
  const h = harness();
  await h.run("/interrupt @claude look at this instead", h.chatChannel);
  assert.match(h.lastIn(h.chatChannel), /was not running/);
});

// --- /mute, /pause ----------------------------------------------------------------------------

test("a muted agent is not routed to, and the chat is told rather than the message vanishing", async () => {
  // Silence would be indistinguishable from the app losing the message, which is the one thing
  // routing is not allowed to look like.
  const h = harness();
  await h.run("/mute @codex", h.chatChannel);
  h.agents.submitMessage(h.chat.id, "user", "you", "@codex take the API");
  assert.equal(queuedFor(h, "a2").length, 0, "nothing was queued for a muted agent");
  assert.match(h.lastIn(h.chatChannel), /@codex is muted/);

  await h.run("/unmute @codex", h.chatChannel);
  h.agents.submitMessage(h.chat.id, "user", "you", "@codex take the API");
  assert.equal(queuedFor(h, "a2").length, 1, "and unmuting really puts it back in circulation");
});

test("/mute twice says nothing changed rather than reporting the same action again", async () => {
  const h = harness();
  await h.run("/mute @codex", h.chatChannel);
  await h.run("/mute @codex", h.chatChannel);
  assert.match(h.lastIn(h.chatChannel), /already muted/);
});

test("pausing holds the queue, and the message says which of the two it did", async () => {
  // The distinction people get wrong: muting drops nothing because nothing is queued, while
  // resuming a paused agent immediately spends a real turn for everything that piled up.
  const h = harness();
  await h.run("/pause @codex", h.chatChannel);
  assert.equal(h.agents.gate.isPaused("a2"), true);
  assert.match(h.lastIn(h.chatChannel), /pile up/);

  h.agents.submitMessage(h.chat.id, "user", "you", "@codex take the API");
  assert.equal(queuedFor(h, "a2").length, 1, "paused holds work - it does not refuse it");

  await h.run("/resume @codex", h.chatChannel);
  assert.equal(h.agents.gate.isPaused("a2"), false);
  assert.match(h.lastIn(h.chatChannel), /real billed turn/);
});

// --- commands waiting on a sibling branch -----------------------------------------------------

test("a command whose backend is not merged says so, and never prints an empty result", async () => {
  // The rule from chatFeatures.ts. "No tasks on the board" and "the task board isn't running"
  // are different statements; rendering the second as the first is how something that does
  // nothing gets shipped looking like something that works.
  const h = harness();
  const pending: [string, string][] = [
    ["/assign @codex write the checker", "task board"],
    ["/tasks", "task board"],
    ["/done t1", "task board"],
    ["/unassign t1", "task board"],
    ["/only @codex", "explicit chat scope"],
    ["/all", "explicit chat scope"],
    ["/quiet", "message-class routing"],
    ["/loud", "message-class routing"],
    ["/servers", "server registry"],
    ["/ports", "port registry"],
  ];
  for (const [command, subsystem] of pending) {
    await h.run(command, h.chatChannel);
    const text = h.lastIn(h.chatChannel);
    assert.ok(text.includes(subsystem), `${command} should name the ${subsystem} it is waiting on - got: ${text}`);
    assert.match(text, /did nothing/, `${command} must say plainly that nothing happened`);
  }
});

test("the same commands do the real thing the moment the backend is passed in", async () => {
  // One property on the features object in index.ts is the whole wiring, and this is the proof.
  const h = harness();
  const rows: BoardTask[] = [];
  const features: ChatFeatures = {
    tasks: {
      assign: (_chatId, owner, description) => {
        const task: BoardTask = { id: `t${rows.length + 1}`, description, owner, status: "open" };
        rows.push(task);
        return task;
      },
      list: () => rows,
      finish: (_chatId, id) => {
        const row = rows.find((r) => r.id === id);
        if (row) row.status = "done";
        return !!row;
      },
      unassign: (_chatId, id) => {
        const row = rows.find((r) => r.id === id);
        if (row) row.owner = undefined;
        return !!row;
      },
    },
  };
  await h.run("/assign @codex write the checker", h.chatChannel, true, features);
  assert.match(h.lastIn(h.chatChannel), /t1 - write the checker · @codex/);

  await h.run("/tasks", h.chatChannel, true, features);
  assert.match(h.lastIn(h.chatChannel), /t1 \[open\] write the checker · @codex/);

  await h.run("/done t9", h.chatChannel, true, features);
  assert.match(h.lastIn(h.chatChannel), /no task t9/, "a missing id is reported, never silently accepted");

  await h.run("/done t1", h.chatChannel, true, features);
  assert.equal(rows[0].status, "done");
});

test("/only refuses a handle that does not exist rather than scoping the chat to nobody", async () => {
  // Checked BEFORE the backend, because scoping a chat to a typo would silence the whole room
  // and look exactly like the app having broken.
  const h = harness();
  await h.run("/only @nobody", h.chatChannel);
  const text = h.lastIn(h.chatChannel);
  assert.match(text, /no agent called @nobody/);
  assert.match(text, /nothing was scoped/);
});

// --- /who, /summary --------------------------------------------------------------------------

test("/who separates what an agent CLAIMED from what it actually wrote", async () => {
  // They can disagree, and when they do the disagreement is the most useful thing on screen -
  // so both are printed and each is labelled with which it is.
  const h = harness();
  const [claude] = h.agents.listAgents();
  h.board.claim(h.chat.id, claude, ["src/checker.py"], "core logic");
  h.digest.beginTurn("a2", "codex", h.chat.id);
  h.digest.recordTool("a2", "Write", { file_path: "C:/repo/src/checker.py" });

  await h.run("/who checker.py", h.chatChannel);
  const text = h.lastIn(h.chatChannel);
  assert.match(text, /Claimed by: @claude \(core logic\)/);
  assert.match(text, /Written to by: @codex/);
});

test("/who says nobody, rather than nothing, for a file with no claim and no writes", async () => {
  const h = harness();
  await h.run("/who nowhere.ts", h.chatChannel);
  const text = h.lastIn(h.chatChannel);
  assert.match(text, /Claimed by: nobody/);
  assert.match(text, /Written to by: nobody/);
});

test("/summary reports counted facts and names what it cannot see", async () => {
  const h = harness();
  h.digest.beginTurn("a1", "claude", h.chat.id);
  h.digest.recordTool("a1", "Write", { file_path: "C:/repo/src/app.ts" });
  h.digest.recordTool("a1", "Bash", { command: "npm test" });

  await h.run("/summary", h.chatChannel);
  const text = h.lastIn(h.chatChannel);
  assert.match(text, /1 file written/);
  assert.match(text, /1 test run/);
  assert.match(text, /@claude · 1 file written/);
  assert.match(text, /Files written: app\.ts/);
  // The two subsystems it cannot see are named, not rendered as empty.
  assert.match(text, /server registry isn't running/);
  assert.match(text, /task board isn't running/);
});

test("/summary on an untouched chat says nothing countable happened, and invents nothing", async () => {
  const h = harness();
  await h.run("/summary", h.chatChannel);
  const text = h.lastIn(h.chatChannel);
  assert.match(text, /Nothing countable has happened/);
  // The failure this guards: a "summary" that starts describing the conversation instead of
  // counting it. There is no path to a model from here, and no sentence to borrow.
  assert.doesNotMatch(text, /working|progress|going well|so far so/i);
});

// --- /accounts -------------------------------------------------------------------------------

test("/accounts says which login each agent is on, from the CLI's own answer", async () => {
  const h = harness();
  await h.run("/accounts", h.chatChannel);
  const text = h.lastIn(h.chatChannel);
  assert.match(text, /claude - claude-code · on \(the CLI's own default login\)/);
  assert.match(text, /never signs anyone in/);
});

test("/accounts refuses to switch to an account nobody has signed into, and changes nothing", async () => {
  // Solace cannot perform a device login and must never look as though it did. Switching an
  // agent to an empty credentials directory would sign it out mid-collaboration.
  const h = harness();
  await h.run("/accounts @claude personal", h.chatChannel);
  const text = h.lastIn(h.chatChannel);
  assert.match(text, /was NOT switched/);
  assert.match(text, /cannot sign anyone in/);
  assert.equal(h.agents.listAgents().find((a) => a.id === "a1")?.account, undefined);
});

test("/accounts switches to an account that really exists, and back to the default", async () => {
  const h = harness();
  await h.run("/accounts @claude work", h.chatChannel);
  assert.equal(h.agents.listAgents().find((a) => a.id === "a1")?.account, "work");
  assert.match(h.lastIn(h.chatChannel), /next turn uses that login/);

  await h.run("/accounts @claude default", h.chatChannel);
  assert.equal(h.agents.listAgents().find((a) => a.id === "a1")?.account, undefined);
});

// --- /diff -----------------------------------------------------------------------------------

test("/diff in a chat with no project says so instead of diffing something arbitrary", async () => {
  const h = harness();
  await h.run("/diff", h.chatChannel);
  assert.match(h.lastIn(h.chatChannel), /isn't filed under a project/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig, ChatMessage } from "@solace/shared";
import {
  AgentManager,
  capForGroup,
  eligibleHandoverAgents,
  handoverBand,
  medianMs,
  type QueuedTurn,
} from "./agentManager";
import { ChatBus } from "./chatBus";
import { ChatStore } from "./chatStore";
import { CoordinationBoard } from "./coordination";
import { SettingsStore } from "./settingsStore";
import { classifyMessageClass, extractFilePaths } from "./turnIntent";

/**
 * Message classes, the reply budget, and quota-aware routing - v1.5 steps 1, 2 and 6.
 *
 * The numbers quoted throughout come from the measured run in ROADMAP.md: 28 chats, 670
 * messages, 530 of them from agents. Each test names the message that actually appeared.
 *
 * No provider turn is ever started: drainQueue is replaced on the instance, exactly as
 * chatRouting.test.ts and handover.test.ts do, so an enqueued turn stays inspectable in the
 * queue instead of spawning a real CLI and spending the user's tokens to run a unit test.
 */

const HERE = process.cwd();

function agent(id: string, handle: string, extra: Partial<AgentConfig> = {}): AgentConfig {
  return { id, handle, provider: "claude-code", cwd: HERE, trustLevel: "acceptEdits", ...extra };
}

interface Harness {
  bus: ChatBus;
  manager: AgentManager;
  board: CoordinationBoard;
  chatId: string;
  /** Post as an AGENT, through the same private entry point an agent's final answer takes. */
  postAsAgent: (from: AgentConfig, text: string, opts?: Record<string, unknown>) => void;
  /** Which agents were actually given a turn, by handle. */
  turned: () => string[];
  group: () => ChatMessage[];
  hub: (agentId: string) => ChatMessage[];
  queued: (agentId: string) => QueuedTurn[];
}

function harness(agents: AgentConfig[], board = new CoordinationBoard()): Harness {
  const bus = new ChatBus();
  const chats = new ChatStore();
  const chat = chats.createChat("Build");
  const manager = new AgentManager(bus, chats, agents, undefined, [], [], [], new SettingsStore(), board);
  (manager as unknown as { drainQueue: (id: string) => Promise<void> }).drainQueue = async () => {};
  const route = (manager as unknown as {
    routeChatMessage: (
      chatId: string,
      authorId: string,
      authorHandle: string,
      text: string,
      opts: Record<string, unknown>,
    ) => void;
  }).routeChatMessage.bind(manager);
  return {
    bus,
    manager,
    board,
    chatId: chat.id,
    postAsAgent: (from, text, opts = {}) =>
      route(chat.id, from.id, from.handle, text, { broadcastIfUnmentioned: false, mentionChainDepth: 0, ...opts }),
    turned: () => {
      const byId = new Map(agents.map((a) => [a.id, a.handle]));
      return manager
        .getPersistableQueues()
        .filter((q) => q.queued.length > 0)
        .map((q) => byId.get(q.agentId)!)
        .sort();
    },
    group: () => bus.getHistoryFor({ chatId: chat.id }),
    hub: (agentId) => bus.getHistoryFor({ agentId }),
    queued: (agentId) => manager.getPersistableQueues().find((q) => q.agentId === agentId)?.queued ?? [],
  };
}

// ---------------------------------------------------------------------------------------------
// 1. Classification itself
// ---------------------------------------------------------------------------------------------

test("an acknowledgement-only message is classified as an ack", () => {
  // Seventeen of the 530 measured agent messages were exactly this shape, and every one of them
  // cost each addressed agent a real billed turn to read "I'm aligned".
  assert.equal(classifyMessageClass("I've read the skills and I'm aligned"), "ack");
  assert.equal(classifyMessageClass("Got it."), "ack");
  assert.equal(classifyMessageClass("Acknowledged"), "ack");
  assert.equal(classifyMessageClass("@claude sounds good"), "ack");
  assert.equal(classifyMessageClass("Nothing to add."), "ack");
});

test("an unasked status report is classified as status", () => {
  // "Verified: all routes 200" to a room that did not ask - 19 of these in the measured run.
  assert.equal(classifyMessageClass("Verified: all routes 200"), "status");
  assert.equal(classifyMessageClass("I verified all routes return 200."), "status");
  assert.equal(classifyMessageClass("Status: the header component is half done."), "status");
  assert.equal(classifyMessageClass("Done - pushed the palette change."), "status");
});

test("a question is never suppressed, however it opens", () => {
  // The expensive direction of this classifier: a message that asks something and is silently
  // given to nobody leaves the asker blocked forever, and nothing in the UI would say why.
  // "Done." in front of a question must not make the question disappear.
  assert.equal(classifyMessageClass("Done. Should I also wire the header?"), "question");
  assert.equal(classifyMessageClass("Verified all routes. Which port do you want?"), "question");
  // Even where classifyIncoming calls it "work" (it is biased that way for interrupt safety),
  // the presence of a question mark still blocks suppression.
  assert.notEqual(classifyMessageClass("Done - can you fix the header?"), "status");
});

test("length caps an ACK but not a STATUS report, because length is not what makes them safe", () => {
  // This started as "a long message is never suppressed, whatever it opens with", on the theory
  // that shortness is what makes suppression safe. The first measured run on the new code
  // disproved it: acks and status were still 32% of the room against a 10% target, and the cap
  // was the reason. Real status reports in the operator's chats run to a MEDIAN of 730
  // characters - "Verified independently: 1 eager (the hero), 11 lazy, and localhost:4321
  // returns 200 across every route I sampled" is a status report precisely BECAUSE it
  // enumerates what it checked. A 240-character ceiling only ever caught the short ones, which
  // were never the problem.
  //
  // What actually keeps suppression safe is the three guards, not the length: a question mark, a
  // request, or a reported problem each disqualify it outright. Those are asserted above and
  // below; this test pins the split that replaced the single cap.
  const longStatus = `Verified - ${"every route returns 200 and the footer carries both legal links. ".repeat(8)}`;
  assert.ok(longStatus.length > 240, "longer than the ack cap");
  assert.equal(classifyMessageClass(longStatus), "status", "a status report is long by nature");

  // An ACK keeps the tight cap for the opposite reason: a long one has nearly always stopped
  // being an acknowledgement and started carrying a caveat, and swallowing that loses content.
  const longAck = `Acknowledged - ${"and here is a further thought about the palette that matters. ".repeat(6)}`;
  assert.ok(longAck.length > 240);
  assert.equal(classifyMessageClass(longAck), "handoff", "a long ack is no longer an ack");

  // And there is still a ceiling on status, so a genuinely enormous report is delivered whole
  // rather than folded away where nobody reads it.
  const enormous = `Done - ${"a real paragraph of substantive findings that somebody has to act on. ".repeat(60)}`;
  assert.ok(enormous.length > 2400);
  assert.equal(classifyMessageClass(enormous), "handoff");
});

test("a problem reported about a named file is a finding", () => {
  // The case the operator specifically wants worked: an agent auditing a backend says "this file
  // looks wrong" and ONLY the file's owner pays a turn for it.
  assert.equal(classifyMessageClass("@claude src/api/routes.ts looks wrong"), "finding");
  assert.equal(classifyMessageClass("packages/server/src/index.ts is missing the auth guard"), "finding");
  // Both halves are required. A complaint with no file cannot be routed to an owner, and a bare
  // path is not a complaint.
  assert.equal(classifyMessageClass("something here is broken"), "handoff");
  assert.equal(classifyMessageClass("I'll take src/api/routes.ts"), "handoff");
});

test("file paths are pulled out of the shapes agents actually write them in", () => {
  assert.deepEqual(extractFilePaths("`src/api/routes.ts` looks wrong"), ["src/api/routes.ts"]);
  assert.deepEqual(extractFilePaths("check packages\\web\\src\\App.tsx now"), ["packages\\web\\src\\App.tsx"]);
  assert.deepEqual(extractFilePaths("vite.config.ts and tsconfig.json"), ["vite.config.ts", "tsconfig.json"]);
  // A bare sentence-ending word is not a file, or every full stop in the chat would be one.
  assert.deepEqual(extractFilePaths("that looks fine. really."), []);
});

// ---------------------------------------------------------------------------------------------
// 1b. Routing by class
// ---------------------------------------------------------------------------------------------

test("a status report from an agent costs nobody a turn and shows as a collapsible row", () => {
  // One operator prompt produced 28 messages before a single file was written, because a status
  // line and a question route identically and each one summons every addressed agent.
  const a = agent("a1", "claude");
  const b = agent("a2", "codex");
  const h = harness([a, b]);

  h.postAsAgent(a, "@codex Verified: all routes 200");

  assert.deepEqual(h.turned(), [], "nobody is charged a turn for a status line");
  const group = h.group();
  assert.equal(group.length, 1);
  assert.equal(group[0].agentKind, "status", "the group row is marked so the UI can collapse N of them");
  assert.equal(h.hub("a1").length, 1, "and the agent's own hub keeps it in full");
});

test("an acknowledgement never reaches the group at all", () => {
  const a = agent("a1", "claude");
  const b = agent("a2", "codex");
  const h = harness([a, b]);

  h.postAsAgent(a, "@codex got it, thanks");

  assert.deepEqual(h.turned(), []);
  assert.deepEqual(h.group(), [], "an ack is hub-only - the room never sees it");
  assert.equal(h.hub("a1").length, 1, "but it is still written down, so nothing lives only in a classifier's opinion");
});

test("an answer that somebody is WAITING for is never filed away as a status line", () => {
  // "@claude which port is it on?" can perfectly well be answered "Done - it's on 4321", which
  // classifies as status. Suppressing that leaves the asker waiting forever for a reply that was
  // written, sent, and silently filed in somebody else's hub - a worse failure than the noise
  // this whole class exists to remove.
  const a = agent("a1", "claude");
  const b = agent("a2", "codex");
  const h = harness([a, b]);

  h.postAsAgent(a, "Done - it's on 4321.", { replyTo: { id: "a2", handle: "codex" }, answeringAQuestion: true });

  const group = h.group();
  assert.equal(group.length, 1);
  assert.notEqual(group[0].agentKind, "status", "an answer that is owed is an ordinary message");
  assert.deepEqual(h.turned(), ["codex"], "and it reaches whoever asked");
});

test("the OPERATOR's messages are never suppressed, whatever they look like", () => {
  // The measured noise was all agent traffic. A human typing "done" into their own chat and
  // getting silence back would be the app deciding it knew better than the person using it.
  const a = agent("a1", "claude");
  const h = harness([a]);

  h.manager.submitMessage(h.chatId, "user", "you", "Verified: all routes 200");

  assert.deepEqual(h.turned(), ["claude"]);
  assert.equal(h.group()[0].agentKind, undefined, "and it is an ordinary message, not a collapsed row");
});

test("a finding is charged to the file's OWNER, and to nobody else", () => {
  const auditor = agent("a1", "auditor");
  const owner = agent("a2", "claude");
  const bystander = agent("a3", "codex");
  const board = new CoordinationBoard();
  const h = harness([auditor, owner, bystander], board);
  board.claim(h.chatId, owner, ["src/api"]);

  // Addressed to the bystander, as an auditor sweeping a repo naturally would be - and still
  // routed to the agent whose lane the file is in.
  h.postAsAgent(auditor, "@codex src/api/routes.ts looks wrong - the auth guard is missing");

  assert.deepEqual(h.turned(), ["claude"], "only the owner pays; the rest of the room is not charged");
  assert.equal(h.queued("a2")[0].ownedFileFinding, true);
  assert.equal(h.queued("a2")[0].class, "finding");
});

test("a finding about a file nobody has claimed falls back to the addressee", () => {
  // A finding that reaches the wrong agent wastes a turn; a finding that reaches nobody loses a
  // real defect report. So with no claim to go on, it routes exactly as it did before classes.
  const auditor = agent("a1", "auditor");
  const other = agent("a2", "codex");
  const h = harness([auditor, other]);

  h.postAsAgent(auditor, "@codex src/api/routes.ts looks wrong - the auth guard is missing");

  assert.deepEqual(h.turned(), ["codex"]);
  assert.notEqual(h.queued("a2")[0].ownedFileFinding, true, "and it does not get to preempt, because it is not their file");
});

test("a finding never routes back to the agent that reported it", () => {
  const auditor = agent("a1", "auditor");
  const other = agent("a2", "codex");
  const board = new CoordinationBoard();
  const h = harness([auditor, other], board);
  board.claim(h.chatId, auditor, ["src/api"]);

  h.postAsAgent(auditor, "@codex src/api/routes.ts looks wrong - the auth guard is missing");

  assert.deepEqual(h.turned(), ["codex"], "its own claim must not make it the recipient of its own message");
});

// ---------------------------------------------------------------------------------------------
// 2. Reply budget
// ---------------------------------------------------------------------------------------------

test("capForGroup returns undefined when nothing needed cutting", () => {
  assert.equal(capForGroup("short"), undefined);
  assert.equal(capForGroup("x".repeat(600)), undefined);
});

test("capForGroup cuts at a sentence end rather than mid-word", () => {
  const text = `${"a".repeat(560)}. ${"b".repeat(200)}`;
  const head = capForGroup(text)!;
  assert.ok(head.endsWith("."), `cut mid-word instead: ...${head.slice(-12)}`);
  assert.ok(head.length <= 600);
});

test("an unaddressed answer is capped for the room, with the full text kept in the hub", () => {
  // Agent messages measured median 282 / p90 1,359 characters. The tail is what turns a room of
  // four into a report queue.
  const a = agent("a1", "claude");
  const b = agent("a2", "codex");
  const h = harness([a, b]);
  const long = `I reconciled the palette. ${"Every page now uses the same tokens and here is the detail. ".repeat(30)}`;
  assert.ok(long.length > 1300);

  h.postAsAgent(a, long, { hubTurnId: "turn-7" });

  const posted = h.group()[0];
  assert.ok(posted.text.length <= 600, `group got ${posted.text.length} chars`);
  assert.equal(posted.fullTextInHub?.chars, long.trim().length, "the real length is stated, not estimated");
  assert.equal(posted.fullTextInHub?.turnId, "turn-7", "so the affordance opens the hub AT that turn");
});

test("an answer addressed to somebody is delivered whole", () => {
  // A message written TO someone is read by that person, not skimmed by a room. Capping it would
  // be the 200-character delivery cap incident again, where an agent had to write its findings
  // to a file on disk to get them across.
  const a = agent("a1", "claude");
  const b = agent("a2", "codex");
  const h = harness([a, b]);
  const long = `@codex here is the whole contract. ${"Each field and its type, in order. ".repeat(40)}`;

  h.postAsAgent(a, long);

  const posted = h.group()[0];
  assert.equal(posted.text, long.trim());
  assert.equal(posted.fullTextInHub, undefined);
});

test("the cap never truncates what another AGENT is actually given to act on", () => {
  // The cap is a display decision about the room. The prompt the recipient runs on must carry
  // every character, or this feature recreates the truncation bug it was written alongside.
  const a = agent("a1", "claude");
  const b = agent("a2", "codex");
  const h = harness([a, b]);
  const tail = "THE-LAST-THING-I-SAID";
  const long = `@codex ${"finding after finding, numbered and long. ".repeat(40)}${tail}`;

  h.postAsAgent(a, long);

  assert.ok(h.queued("a2")[0].prompt.includes(tail), "the recipient must receive the end of the message");
  assert.ok(h.queued("a2")[0].groupMessage!.text.includes(tail));
});

// ---------------------------------------------------------------------------------------------
// 5. Honest queue state
// ---------------------------------------------------------------------------------------------

test("medianMs reports nothing rather than zero when there is no history", () => {
  assert.equal(medianMs([]), undefined);
  assert.equal(medianMs([5_000]), 5_000);
  assert.equal(medianMs([1_000, 9_000]), 5_000);
  // Median, not mean: one twelve-minute build among short answers must not become the typical
  // wait shown to somebody deciding whether to hang around.
  assert.equal(medianMs([30_000, 40_000, 50_000, 720_000]), 45_000);
});

test("an agent that has never completed a turn offers a queue position but no estimate", () => {
  const a = agent("a1", "claude");
  const h = harness([a]);

  const status = h.manager.listStatuses()[0];
  assert.equal(status.queue?.waiting, 0);
  assert.equal(status.queue?.nextPosition, 1);
  assert.equal(status.queue?.samples, 0);
  assert.equal(status.queue?.medianTurnMs, undefined, "no history means no number, not a guessed one");
  assert.equal(status.queue?.etaMs, undefined);
});

test("queue position counts what is really queued, so the composer can say '#2'", () => {
  const a = agent("a1", "claude");
  const h = harness([a]);

  h.manager.submitMessage(h.chatId, "user", "you", "first thing");
  h.manager.submitMessage(h.chatId, "user", "you", "second thing");

  const queue = h.manager.listStatuses()[0].queue!;
  assert.equal(queue.waiting, 2);
  assert.equal(queue.nextPosition, 3, "a message sent now runs third");
});

test("the estimate is built from that agent's OWN observed turns", () => {
  const a = agent("a1", "claude");
  const h = harness([a]);
  const runtime = (h.manager as unknown as { agents: Map<string, { turnDurationsMs: number[] }> }).agents.get("a1")!;
  runtime.turnDurationsMs.push(60_000, 180_000, 120_000);

  h.manager.submitMessage(h.chatId, "user", "you", "something");
  const queue = h.manager.listStatuses()[0].queue!;

  assert.equal(queue.medianTurnMs, 120_000);
  assert.equal(queue.samples, 3);
  assert.equal(queue.etaMs, 120_000, "one turn ahead of it, idle agent, so one median");
});

// ---------------------------------------------------------------------------------------------
// 6. Quota-aware routing and same-provider handover
// ---------------------------------------------------------------------------------------------

test("a rate-limited agent is not routed to, and the chat is told when it resets", () => {
  const a = agent("a1", "claude");
  const b = agent("a2", "codex");
  const h = harness([a, b]);
  const resetAt = new Date(Date.now() + 30 * 60_000);
  const agents = (h.manager as unknown as { agents: Map<string, { scheduledRetryAt?: string }> }).agents;
  agents.get("a1")!.scheduledRetryAt = resetAt.toISOString();

  h.manager.submitMessage(h.chatId, "user", "you", "@claude @codex have a look");

  assert.deepEqual(h.turned(), ["codex"], "the exhausted agent is not given work that would fail on arrival");
  const system = h.group().filter((m) => m.authorId === "system");
  assert.equal(system.length, 1);
  assert.match(system[0].text, /@claude is rate-limited/);
  assert.ok(system[0].text.includes(resetAt.toLocaleTimeString()), "and it names when the limit resets");
});

test("a reset time already in the past never makes an agent permanently unreachable", () => {
  const a = agent("a1", "claude");
  const h = harness([a]);
  const agents = (h.manager as unknown as { agents: Map<string, { scheduledRetryAt?: string }> }).agents;
  agents.get("a1")!.scheduledRetryAt = new Date(Date.now() - 60_000).toISOString();

  h.manager.submitMessage(h.chatId, "user", "you", "@claude go");

  assert.deepEqual(h.turned(), ["claude"]);
});

test("handover prefers a SECOND ACCOUNT of the same provider over a different provider", () => {
  // The model and behaviour match, and the two accounts are separate real subscriptions, so the
  // limit that just stopped the first agent does not apply to the sibling at all.
  const from = agent("a1", "claude", { account: "work" });
  const sibling = agent("a2", "Claude2", { account: "personal" });
  const elsewhere = agent("a3", "codex", { provider: "codex-cli" });

  assert.equal(handoverBand(from, sibling), 0);
  assert.equal(handoverBand(from, elsewhere), 1);
});

test("an agent on the SAME account of the same provider is the last resort, not the first", () => {
  // Agents sharing one account share one real limit - the agent that just ran out is the same
  // login - so it would very likely fail on arrival. It stays eligible (a limit can be per-model
  // or per-window) but it is never preferred over an account that is definitely someone else's.
  const from = agent("a1", "claude", { account: "work" });
  const twin = agent("a2", "Claude2", { account: "work" });
  const other = agent("a3", "codex", { provider: "codex-cli" });

  assert.equal(handoverBand(from, twin), 2);
  assert.ok(handoverBand(from, other) < handoverBand(from, twin));
});

test("two agents that named no account at all are the same account, not two", () => {
  const from = agent("a1", "claude");
  const twin = agent("a2", "Claude2");
  assert.equal(handoverBand(from, twin), 2, "undefined and undefined is one login, not two");
  assert.equal(handoverBand(from, agent("a3", "Claude3", { account: "  " })), 2, "and neither is a blank label");
});

test("the handover candidate list puts the sibling account first", () => {
  const from = agent("a1", "claude", { account: "work" });
  const twin = agent("a2", "twin", { account: "work" });
  const other = agent("a3", "codex", { provider: "codex-cli" });
  const sibling = agent("a4", "Claude2", { account: "personal" });
  const turn: QueuedTurn = {
    id: "t1",
    prompt: "fix the build",
    replyChannel: { chatId: "c" },
    mentionChainDepth: 0,
    kind: "work",
    receivedAt: new Date().toISOString(),
  };

  assert.deepEqual(
    eligibleHandoverAgents(from, [from, twin, other, sibling], turn).map((a) => a.handle),
    ["Claude2", "codex", "twin"],
    "same provider + different account, then a different provider, then the shared login last",
  );
});

test("write capability still outranks the provider band", () => {
  // A plan-mode agent may not be able to finish the work at all, which is a harder blocker than
  // being on a busier account - so it stays last even when it is the perfect sibling account.
  const from = agent("a1", "claude", { account: "work" });
  const planningSibling = agent("a2", "Claude2", { account: "personal", trustLevel: "plan" });
  const writerElsewhere = agent("a3", "codex", { provider: "codex-cli" });
  const turn: QueuedTurn = {
    id: "t1",
    prompt: "fix the build",
    replyChannel: { chatId: "c" },
    mentionChainDepth: 0,
    kind: "work",
    receivedAt: new Date().toISOString(),
  };

  assert.deepEqual(
    eligibleHandoverAgents(from, [from, planningSibling, writerElsewhere], turn).map((a) => a.handle),
    ["codex", "Claude2"],
  );
});

// ---------------------------------------------------------------------------------------------
// Asserted against source: each of these is a branch inside a real turn's completion path, which
// needs a live agent, a live provider process and a finished turn to exercise end to end. The
// thing being guarded in every case is a value being recorded (or not recorded) at a point that
// only exists while a turn is actually running.
// ---------------------------------------------------------------------------------------------

const SRC = readFileSync(join(import.meta.dirname, "agentManager.ts"), "utf8").replace(/\r\n/g, "\n");

test("only a turn that genuinely completed is measured for the queue estimate", () => {
  // A turn that errored on arrival (seconds), one the user stopped, one killed for an interrupt
  // and one that hit the idle timeout are all real events, and none of them is an example of how
  // long this agent's work takes. Feeding them in drags the estimate toward the length of a
  // failure, which is the one duration nobody is asking about.
  assert.match(SRC, /if \(!hadError && !cancelled\) \{\s*\n\s*runtime\.turnDurationsMs\.push\(Date\.now\(\) - turnStartedAt\)/);
  assert.match(SRC, /runtime\.turnDurationsMs\.slice\(-TURN_DURATION_SAMPLES\)/, "and the window is bounded");
});

test("the capped group message can point at the hub AT the turn that produced it", () => {
  // Without the turn id the "full detail in hub" affordance can only open the top of a hub that
  // may be hundreds of messages long, which is a link to a haystack.
  assert.match(SRC, /hubTurnId: turnId,/);
  assert.match(SRC, /fullTextInHub: groupHead \? \{ chars: displayText\.length, turnId: opts\.hubTurnId \} : undefined/);
});

test("the handover announcement says WHY this agent and not another", () => {
  // A second account of the same provider is the best possible recipient and the least obvious
  // one - the two agents look identical in the sidebar apart from a label.
  assert.match(SRC, /const band = handoverBand\(from, to\);/);
  assert.match(SRC, /so the model and its behaviour match and it has its own separate limit/);
  assert.match(SRC, /shares the same real \` \+\s*\n\s*\`limit and may well hit it too/);
});

test("routing reads only a real parsed reset time, never a usage percentage", () => {
  // An agent at 97% of its five-hour window can still run. Refusing to route on a percentage
  // would stop work that would have succeeded, which is a worse failure than the one it prevents.
  const at = SRC.indexOf("private rateLimitedUntil(");
  const body = SRC.slice(at, SRC.indexOf("\n  }\n", at));
  assert.match(body, /runtime\.scheduledRetryAt/);
  assert.ok(!/rateLimits\.get|runtime\.rateLimit/.test(body), "must not gate routing on a reported window");
});

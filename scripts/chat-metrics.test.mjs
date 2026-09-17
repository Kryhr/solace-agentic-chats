/**
 * Unit tests for the pure analysis behind chat-metrics.
 *
 *   node --test scripts/chat-metrics.test.mjs
 *
 * Every fixture here is hand-written. Nothing in this file reads a real `.solace-state.json`,
 * deliberately: the operator's state is live data that changes under us, and a test that depends
 * on it is a test that fails for reasons that have nothing to do with the code.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  aggregate,
  analyzeChat,
  buildReport,
  compareBaseline,
  evaluateTargets,
  isAckOnly,
  isBareNoReply,
  isChainCutoff,
  isDeliveryComplaint,
  isLiveClaim,
  isLiveContradiction,
  isRateLimitNotice,
  isStatusReport,
  isWatchdogKill,
  isWriteTool,
  median,
  normalizeState,
  percentile,
  portsIn,
  share,
  similarity,
} from "./lib/chat-metrics-core.mjs";

// ---------------------------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------------------------

const T0 = Date.parse("2026-09-17T10:00:00.000Z");
const at = (seconds) => new Date(T0 + seconds * 1000).toISOString();

let seq = 0;
function msg(overrides = {}) {
  seq += 1;
  return {
    id: `m${seq}`,
    channel: { chatId: "c1" },
    authorId: "a1",
    authorHandle: "alice",
    mentions: [],
    text: "hello",
    createdAt: at(0),
    ...overrides,
  };
}

const AGENTS = new Map([
  ["a1", { id: "a1", handle: "alice", provider: "claude-code" }],
  ["a2", { id: "a2", handle: "bob", provider: "codex-cli" }],
]);

// ---------------------------------------------------------------------------------------------

test("percentile and median", () => {
  assert.equal(median([]), null);
  assert.equal(median([5]), 5);
  assert.equal(median([1, 2, 3, 4]), 2);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
  assert.equal(percentile([], 90), null);
  assert.equal(share(1, 4), 25);
  assert.equal(share(0, 0), null, "no denominator is 'no data', not 0%");
});

test("similarity catches the mid-turn post repeated as the final answer", () => {
  const a = "Build is complete: all seven routes return 200 and the production build is clean.";
  const b = "Build is complete - all seven routes return 200 and the production build is clean.";
  assert.ok(similarity(a, b) > 0.8);
  assert.ok(similarity(a, "The palette should use a warmer accent for small text.") < 0.2);
  assert.equal(similarity("", "anything"), 0);
});

test("ack-only classification", () => {
  assert.ok(isAckOnly("Acknowledged. I'm not taking a code change right now."));
  assert.ok(isAckOnly("Noted, no action needed on my end."));
  assert.ok(isAckOnly("I've read the skills and I'm aligned."));
  assert.ok(isAckOnly("Sounds good."));
  assert.ok(!isAckOnly("Acknowledged - but the mobile menu does not close on Escape at 375px."), "carries a fact");
  assert.ok(!isAckOnly("Got it. Which port should I use?"), "a question is not an ack");
  assert.ok(!isAckOnly(""));
});

test("unaddressed status reports need the status in the lead", () => {
  assert.ok(isStatusReport("Verified: all routes return 200 and the build is clean."));
  assert.ok(isStatusReport("Status this turn - server confirmed live, tests pass."));
  assert.ok(
    !isStatusReport(`We should pick a warmer accent. ${"x".repeat(250)} That work is done.`),
    "a marker buried on line forty is not a status report",
  );
  assert.ok(!isStatusReport("Is the build complete on your side?"));
});

test("bare [no-reply], cutoffs, rate limits, watchdog kills", () => {
  assert.ok(isBareNoReply("[no-reply]"));
  assert.ok(isBareNoReply("  no-reply "));
  assert.ok(!isBareNoReply("Done, nothing else needed. [no-reply]"));
  assert.ok(isChainCutoff("Stopped an agent-to-agent reply chain after 6 hops to avoid a runaway loop."));
  assert.ok(isChainCutoff("Agents are not allowed to trigger each other (0 hops), so this reply went no further."));
  assert.ok(!isChainCutoff("We went back and forth six times on this."));
  assert.ok(isRateLimitNotice("That looks like a rate limit - will automatically retry at 4:10 PM."));
  assert.ok(isRateLimitNotice("error: usage limit reached"));
  assert.ok(isWatchdogKill("turn stopped: no output for 6 minutes, so it was treated as stuck"));
  assert.ok(isWatchdogKill("error: turn stopped after 15 minutes without finishing"));
  assert.ok(!isWatchdogKill("The turn stopped because I finished."));
});

test("delivery complaints", () => {
  assert.ok(isDeliveryComplaint("I only received a truncated preview of your audit findings."));
  assert.ok(isDeliveryComplaint("I never got finding #2 - the message was cut off."));
  assert.ok(!isDeliveryComplaint("I received the full design audit and the build summary."));
});

test("liveness claims are judged per sentence, and tense matters", () => {
  assert.ok(isLiveClaim("BUILD IS UP AND RUNNING at http://localhost:4321 - I just curled it."));
  assert.ok(isLiveClaim("Ferro is live at http://localhost:5453 (HTTP 200)."));
  assert.ok(
    !isLiveClaim("Port 4321 is currently free. Once the demo lands I can verify the exact URL."),
    "a promise is not a claim",
  );
  assert.ok(!isLiveClaim("The palette is locked and the copy is done."), "no URL or port at all");
  assert.ok(!isLiveClaim("It is not live at http://localhost:4321 any more."));
  assert.ok(isLiveContradiction("I just curled 127.0.0.1:5453 and got connection-refused - nothing is listening."));
  assert.ok(isLiveContradiction("The server had actually died between turns."));
  assert.ok(
    !isLiveContradiction("Per the operator I tore down Ferro and killed the node process on :5453."),
    "a deliberate teardown does not contradict a claim that was true when made",
  );
  assert.deepEqual(portsIn("running on http://localhost:4321 and port 5453").sort(), [4321, 5453]);
  assert.deepEqual(portsIn("no ports here, just 42"), []);
});

test("write-tool detection covers shell writes", () => {
  assert.ok(isWriteTool("Write"));
  assert.ok(isWriteTool("file_change"));
  assert.ok(isWriteTool("apply_patch"));
  assert.ok(isWriteTool("Bash", "cat > index.html <<'EOF'\n<html>\nEOF"));
  assert.ok(isWriteTool("powershell", "Set-Content -Path index.html -Value $html"));
  assert.ok(!isWriteTool("Bash", "curl -s http://localhost:4321/"));
  assert.ok(!isWriteTool("Read"));
  assert.ok(!isWriteTool(undefined));
});

test("reply latency pairs a mention with the next message from that handle", () => {
  const chat = {
    id: "c1",
    title: "T",
    messages: [
      msg({ authorId: "user", authorHandle: "you", mentions: ["bob"], text: "@bob please check", createdAt: at(0) }),
      msg({ authorId: "a1", authorHandle: "alice", text: "unrelated", createdAt: at(10) }),
      msg({ authorId: "a2", authorHandle: "bob", text: "checked, all good", createdAt: at(30), agentKind: "answer" }),
      msg({ authorId: "a2", authorHandle: "bob", mentions: ["alice"], text: "@alice over to you", createdAt: at(40), agentKind: "answer" }),
      msg({ authorId: "a1", authorHandle: "alice", text: "on it", createdAt: at(400), agentKind: "answer" }),
    ],
  };
  const r = analyzeChat(chat, { agentsById: AGENTS });
  assert.equal(r.reply.samples, 2);
  assert.deepEqual([r.reply.medianMs, r.reply.p90Ms], [30_000, 360_000]);
  assert.equal(r.reply.over120s, 1);
  assert.equal(r.reply.unanswered, 0);
});

test("an unanswered mention is counted, not silently dropped, and self-mentions are ignored", () => {
  const chat = {
    id: "c1",
    title: "T",
    messages: [
      msg({ authorId: "a1", authorHandle: "alice", mentions: ["bob", "alice"], text: "@bob @alice", createdAt: at(0), agentKind: "answer" }),
      msg({ authorId: "a1", authorHandle: "alice", text: "still waiting", createdAt: at(60), agentKind: "answer" }),
    ],
  };
  const r = analyzeChat(chat, { agentsById: AGENTS });
  assert.equal(r.reply.samples, 0);
  assert.equal(r.reply.unanswered, 1, "bob never replied; alice mentioning herself is not a question");
});

test("addressed share, acks, status, duplicates, no-reply and lengths", () => {
  const long = "Build is complete: all seven routes return 200 and the production build is clean.";
  const chat = {
    id: "c1",
    title: "T",
    messages: [
      msg({ authorId: "a1", authorHandle: "alice", mentions: ["bob"], text: "@bob take the nav", createdAt: at(0), agentKind: "answer" }),
      msg({ authorId: "a2", authorHandle: "bob", text: "Acknowledged.", createdAt: at(10), agentKind: "answer" }),
      msg({ authorId: "a2", authorHandle: "bob", text: long, createdAt: at(20), agentKind: "answer" }),
      msg({ authorId: "a2", authorHandle: "bob", text: `${long} `, createdAt: at(30), agentKind: "answer" }),
      msg({ authorId: "a2", authorHandle: "bob", text: "[no-reply]", createdAt: at(40), agentKind: "answer" }),
      msg({ authorId: "system", authorHandle: "system", text: "Stopped an agent-to-agent reply chain after 6 hops.", createdAt: at(50) }),
    ],
  };
  const r = analyzeChat(chat, { agentsById: AGENTS });
  assert.equal(r.agentMessages, 5);
  assert.equal(r.addressed, 1);
  assert.equal(r.addressedShare, 20);
  assert.equal(r.counts.acks, 1);
  assert.equal(r.counts.statusReports, 2, "both build reports are unaddressed status");
  assert.equal(r.counts.nearDuplicates, 1);
  assert.equal(r.counts.bareNoReply, 1);
  assert.equal(r.counts.cutoffs, 1);
  assert.equal(r.length.maxChars, long.length + 1);
  assert.equal(r.length.medianChars, "@bob take the nav".length);
  assert.ok(r.length.medianChars > "[no-reply]".length, "the bare [no-reply] is excluded from length stats");
});

test("a live claim contradicted about the same port counts; a different port does not", () => {
  const chat = (contradictionText) => ({
    id: "c1",
    title: "T",
    messages: [
      msg({ authorId: "a1", authorHandle: "alice", text: "Ferro is live at http://localhost:5453 (200).", createdAt: at(0), agentKind: "answer" }),
      msg({ authorId: "a2", authorHandle: "bob", text: contradictionText, createdAt: at(60), agentKind: "answer" }),
    ],
  });
  const hit = analyzeChat(chat("curl 127.0.0.1:5453 - connection refused, nothing is listening."), { agentsById: AGENTS });
  assert.deepEqual([hit.live.claims, hit.live.contradicted], [1, 1]);

  const miss = analyzeChat(chat("The old demo on :4321 is down, unrelated."), { agentsById: AGENTS });
  assert.deepEqual([miss.live.claims, miss.live.contradicted], [1, 0]);
});

test("messages before the first file written, from hub tool markers", () => {
  const chat = {
    id: "c1",
    title: "T",
    messages: [
      msg({ authorId: "user", authorHandle: "you", text: "build it", createdAt: at(0) }),
      msg({ authorId: "a1", authorHandle: "alice", text: "planning", createdAt: at(10), agentKind: "answer" }),
      msg({ authorId: "a1", authorHandle: "alice", text: "still planning", createdAt: at(20), agentKind: "answer" }),
      msg({ authorId: "a1", authorHandle: "alice", text: "written", createdAt: at(60), agentKind: "answer" }),
    ],
  };
  const hub = [
    msg({ channel: { agentId: "a1" }, agentKind: "tool", tool: { name: "Read" }, createdAt: at(15) }),
    msg({ channel: { agentId: "a1" }, agentKind: "tool", tool: { name: "Write" }, createdAt: at(30) }),
  ];
  const r = analyzeChat(chat, { hub, agentsById: AGENTS });
  assert.deepEqual([r.firstFile.found, r.firstFile.messages, r.firstFile.approximate], [true, 3, true]);

  const none = analyzeChat(chat, { hub: [hub[0]], agentsById: AGENTS });
  assert.deepEqual([none.firstFile.found, none.firstFile.messages], [false, null]);
});

test("an empty chat produces nulls, not NaN, and never throws", () => {
  const r = analyzeChat({ id: "c1", title: "empty", messages: [] }, { agentsById: AGENTS });
  assert.equal(r.reply.medianMs, null);
  assert.equal(r.addressedShare, null);
  assert.equal(r.length.maxChars, null);
  assert.equal(r.firstFile.found, false);
  const totals = aggregate([r]);
  assert.equal(totals.agentMessages, 0);
  assert.equal(totals.noise.acksAndStatusShare, null);
});

test("normalizeState tolerates rubbish and still separates chats from hubs", () => {
  for (const bad of [null, undefined, 42, "nope", [], {}]) {
    const s = normalizeState(bad);
    assert.deepEqual(s.chats, []);
    assert.deepEqual(s.hub, []);
  }
  const s = normalizeState({
    agents: [{ id: "a1", handle: "alice" }, null],
    chats: [{ id: "c1", title: "Landing Page Test" }],
    history: [
      msg({ channel: { chatId: "c1" }, createdAt: at(20) }),
      msg({ channel: { chatId: "c1" }, createdAt: at(10) }),
      msg({ channel: { agentId: "a1" }, agentKind: "tool", tool: { name: "Write" } }),
      { no: "channel" },
      null,
    ],
    archives: [{ channel: { chatId: "c2" }, channelLabel: "Old chat", messages: [msg({ channel: { chatId: "c2" } })] }],
  });
  assert.equal(s.chats.length, 2);
  const live = s.chats.find((c) => c.id === "c1");
  assert.equal(live.title, "Landing Page Test");
  assert.equal(live.archived, false);
  assert.ok(live.messages[0].createdAt < live.messages[1].createdAt, "messages are sorted by time");
  assert.equal(s.chats.find((c) => c.id === "c2").archived, true);
  assert.equal(s.hub.length, 1);
});

test("a message with no createdAt does not throw or poison the medians", () => {
  const chat = {
    id: "c1",
    title: "T",
    messages: [
      msg({ authorId: "a1", authorHandle: "alice", mentions: ["bob"], createdAt: undefined, agentKind: "answer" }),
      msg({ authorId: "a2", authorHandle: "bob", text: "ok", createdAt: at(5), agentKind: "answer" }),
    ],
  };
  const r = analyzeChat(chat, { agentsById: AGENTS });
  assert.equal(r.reply.samples, 0);
  assert.equal(r.agentMessages, 2);
});

test("targets: a judgeable target passes or fails, an unjudgeable one is n/a", () => {
  const fine = evaluateTargets(
    aggregate([
      analyzeChat(
        {
          id: "c1",
          title: "T",
          messages: [
            msg({ authorId: "a1", authorHandle: "alice", mentions: ["bob"], text: "@bob do the nav", createdAt: at(0), agentKind: "answer" }),
            msg({ authorId: "a2", authorHandle: "bob", mentions: ["alice"], text: "@alice nav done, header fixed at 375 and 1440", createdAt: at(20), agentKind: "answer" }),
          ],
        },
        { agentsById: AGENTS },
      ),
    ]),
  );
  assert.ok(fine.every((x) => x.pass === true), JSON.stringify(fine));

  const empty = evaluateTargets(aggregate([analyzeChat({ id: "c1", title: "T", messages: [] }, { agentsById: AGENTS })]));
  const byName = Object.fromEntries(empty.map((x) => [x.name, x.pass]));
  assert.equal(byName["p90 reply < 90s"], null);
  assert.equal(byName["addressed >= 70%"], null);
  assert.equal(byName["reply-chain cutoffs = 0"], true, "zero cutoffs in an empty chat is genuinely zero");
});

test("baseline comparison knows which direction is better", () => {
  const now = { reply: { p90Ms: 60_000, medianMs: 10, over120s: 0, unanswered: 0 }, addressedShare: 80, counts: {}, noise: {}, live: {}, length: {}, firstFile: {} };
  const was = { reply: { p90Ms: 120_000, medianMs: 10, over120s: 0, unanswered: 0 }, addressedShare: 90, counts: {}, noise: {}, live: {}, length: {}, firstFile: {} };
  const rows = compareBaseline(now, was);
  const p90 = rows.find((r) => r.metric === "reply.p90Ms");
  assert.deepEqual([p90.delta, p90.better, p90.regression], [-60_000, true, false]);
  const addr = rows.find((r) => r.metric === "addressedShare");
  assert.deepEqual([addr.delta, addr.regression], [-10, true], "less addressed is a regression");
  const same = rows.find((r) => r.metric === "reply.medianMs");
  assert.equal(same.regression, false);
  const missing = rows.find((r) => r.metric === "counts.cutoffs");
  assert.deepEqual([missing.delta, missing.regression], [null, false]);
});

test("buildReport on a whole state, and on an empty one", () => {
  const report = buildReport({
    agents: [{ id: "a1", handle: "alice", provider: "claude-code" }],
    chats: [{ id: "c1", title: "Landing Page Test" }],
    history: [msg({ channel: { chatId: "c1" }, authorId: "a1", authorHandle: "alice", text: "hi", createdAt: at(0), agentKind: "answer" })],
    archives: [],
  });
  assert.equal(report.totals.chats, 1);
  assert.equal(report.totals.agentMessages, 1);
  assert.ok(Array.isArray(report.targets));
  assert.ok(!("latencyMs" in report.chats[0]), "raw sample arrays never reach the output");

  const blank = buildReport({});
  assert.equal(blank.totals.chats, 0);
  assert.equal(blank.totals.messages, 0);
  assert.equal(blank.totals.reply.p90Ms, null);
});

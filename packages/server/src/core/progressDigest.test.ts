import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SettingsStore } from "./settingsStore";
import {
  MILESTONE_MIN_GAP_MS,
  ProgressDigest,
  digestLine,
  emptyTally,
  factsFor,
  isTestCommand,
  recordInto,
  serverStartPorts,
} from "./progressDigest";

/**
 * The digest, and the one rule it exists to keep.
 *
 * The incident these tests are written from is in ROADMAP.md as root cause B, measured across
 * 28 chats and 670 messages: an agent's turn produces nothing visible until it ends, so a turn
 * that thinks and builds for twelve minutes is twelve minutes of silence followed by a
 * 1,300-character dump (p90 message length: 1,359 characters). Two agents doing that in
 * parallel cannot coordinate - which is how the same landing page got built twice, twice.
 *
 * The obvious fix is to have a model write a progress line. That is the one thing this codebase
 * will not do, because the whole app's credibility rests on the difference between a fact it
 * observed and a sentence it produced - 22 "it's live" claims, 4 of them contradicted within
 * fifteen messages, are what that difference costs when it is lost.
 *
 * So the line is COUNTED, from the same real tool-use events the hub already renders. Every test
 * below is about some way that could quietly stop being true.
 */

const SRC = readFileSync(join(import.meta.dirname, "progressDigest.ts"), "utf8");

function harness(settings: Partial<{ progressDigestMinutes: number }> = {}) {
  const store = new SettingsStore({ progressDigestMinutes: 3, ...settings });
  const posted: { chatId: string; text: string }[] = [];
  let clock = 0;
  const digest = new ProgressDigest(store, (chatId, text) => posted.push({ chatId, text }), () => clock);
  return {
    digest,
    posted,
    store,
    at(ms: number) {
      clock = ms;
    },
  };
}

/** One real Claude Code write event, exactly as the adapter emits it. */
const write = (path: string) => ["Write", { file_path: path, content: "x" }] as const;
/** One real shell event. */
const bash = (command: string) => ["Bash", { command }] as const;

// --- the rule ------------------------------------------------------------------------------

test("every clause of an emitted line is a count and a noun, with nothing else in it", () => {
  // The property that makes "derived, never generated" checkable rather than a promise: the
  // renderer has no branch that can produce a word which did not come from counting something.
  // If somebody later adds "looking good" or "nearly done" to factsFor, this fails.
  const tally = emptyTally();
  recordInto(tally, ...write("C:/p/a.ts"));
  recordInto(tally, ...write("C:/p/b.ts"));
  recordInto(tally, ...bash("npm test"));
  recordInto(tally, ...bash("npm run dev -- --port 4321"));
  recordInto(tally, ...bash("git status"));
  recordInto(tally, "Read", { file_path: "C:/p/c.ts" });

  const allowed = [
    /^\d+ files? written$/,
    /^\d+ files? read$/,
    /^\d+ test runs?$/,
    /^\d+ commands? run$/,
    /^servers? started on (:\d+)(, :\d+)*$/,
  ];
  for (const fact of factsFor(tally)) {
    assert.ok(
      allowed.some((re) => re.test(fact)),
      `"${fact}" is not a count and a noun - the digest may only report what it counted`,
    );
  }

  const line = digestLine("claude", tally);
  assert.equal(line, "@claude · 2 files written · 1 test run · server started on :4321 · 1 command run");
});

test("nothing countable happened means nothing is posted, not \"still working\"", () => {
  // Silence is more honest. A turn that has only read files and run `git status` has produced
  // nothing anybody else can act on, and a line saying so would be the unasked status report
  // that is already 19 of the 530 messages measured.
  const h = harness();
  h.digest.beginTurn("a1", "claude", "chat1");
  h.digest.recordTool("a1", "Read", { file_path: "C:/p/a.ts" });
  h.digest.recordTool("a1", "Grep", { pattern: "todo" });
  h.digest.recordTool("a1", "Bash", { command: "git status" });
  h.at(60 * 60_000); // an hour later, long past any cadence
  h.digest.tick();
  assert.deepEqual(h.posted, []);
});

test("the line names the real port from the real command, and refuses to guess one", () => {
  // "server started on :3000", guessed from a framework's default, sends somebody to the wrong
  // URL with full confidence. A server-start command with no port written in it is counted as
  // an ordinary command run instead.
  assert.deepEqual(serverStartPorts("npm run dev -- --port 4321"), [4321]);
  assert.deepEqual(serverStartPorts("python -m http.server 8080"), []); // positional, not named
  assert.deepEqual(serverStartPorts("npm run dev"), [], "no port in the command means no port in the line");
  // The false positive this test caught before the code shipped: a bare `serve` anywhere in the
  // string matched, so a COMMIT MESSAGE was about to be reported to the group as a running
  // server. See atCommandHead.
  assert.deepEqual(serverStartPorts("git commit -m 'serve the page on :4321'"), [], "not a server start at all");
  assert.deepEqual(serverStartPorts("echo 'npm run dev --port 4321'"), [], "text about a command is not a command");
  assert.deepEqual(serverStartPorts("vite --port 5199"), [5199]);

  const tally = emptyTally();
  recordInto(tally, ...bash("npm run dev"));
  assert.equal(tally.serverPorts.size, 0);
  assert.equal(tally.commandRuns, 1, "it still happened - it is just not a port claim");
});

test("a test run is only counted when the command really is one", () => {
  assert.ok(isTestCommand("npm test"));
  assert.ok(isTestCommand("npm run test:unit"));
  assert.ok(isTestCommand("node --test packages/server"));
  assert.ok(isTestCommand("pytest -q"));
  assert.ok(isTestCommand("cargo test"));
  assert.ok(isTestCommand("cd x && npm test"));
  // The failures that would matter: counting a build or a file whose NAME contains "test".
  assert.ok(!isTestCommand("npm run build"));
  assert.ok(!isTestCommand("cat src/core/commands.test.ts"));
  assert.ok(!isTestCommand("git commit -m 'add tests'"));
});

test("a write whose arguments name no file is not counted as a file", () => {
  // Counting it by name would put "1 file written" in the group for a call that may have
  // written nothing. Undercounting is the only acceptable direction of error here.
  const tally = emptyTally();
  recordInto(tally, "Write", {});
  assert.equal(tally.filesWritten.size, 0);
  assert.equal(digestLine("claude", tally), undefined);
});

test("the same file written three times is one file", () => {
  const tally = emptyTally();
  for (let i = 0; i < 3; i++) recordInto(tally, ...write("C:/p/a.ts"));
  assert.equal(digestLine("claude", tally), "@claude · 1 file written");
});

// --- when it speaks ------------------------------------------------------------------------

test("a milestone speaks early, but never twice inside the minimum gap", () => {
  const h = harness({ progressDigestMinutes: 3 });
  h.digest.beginTurn("a1", "claude", "chat1");
  h.at(1_000);
  h.digest.recordTool("a1", ...write("C:/p/a.ts"));
  h.digest.tick();
  assert.deepEqual(h.posted, [], "a milestone does not get to post within a second of the turn starting");

  h.at(MILESTONE_MIN_GAP_MS + 1);
  h.digest.tick();
  assert.equal(h.posted.length, 1);
  assert.equal(h.posted[0].text, "@claude · 1 file written");

  // A second milestone immediately afterwards waits for the gap rather than posting on its heels.
  h.at(MILESTONE_MIN_GAP_MS + 2_000);
  h.digest.recordTool("a1", ...bash("npm test"));
  h.digest.tick();
  assert.equal(h.posted.length, 1, "two lines two seconds apart is chatter, not progress");
});

test("counts are cumulative, and an unchanged line is never re-posted", () => {
  // A status message reporting no change is exactly the noise this is supposed to reduce.
  const h = harness({ progressDigestMinutes: 3 });
  h.digest.beginTurn("a1", "claude", "chat1");
  h.digest.recordTool("a1", ...write("C:/p/a.ts"));
  h.at(MILESTONE_MIN_GAP_MS + 1);
  h.digest.tick();
  assert.equal(h.posted.length, 1);

  h.at(MILESTONE_MIN_GAP_MS + 1 + 10 * 60_000); // several cadences later, nothing has happened
  h.digest.tick();
  h.digest.tick();
  assert.equal(h.posted.length, 1);

  h.digest.recordTool("a1", ...write("C:/p/b.ts"));
  h.digest.tick();
  assert.equal(h.posted.length, 2);
  assert.equal(h.posted[1].text, "@claude · 2 files written", "cumulative, so the second line supersedes the first");
});

test("the cadence is read live, and 0 turns the digest off completely", () => {
  // Same rule as every limit in settings.ts: read at the moment it is enforced, never captured
  // at boot, so a change made in a browser tab applies to the turn already running.
  const h = harness({ progressDigestMinutes: 0 });
  h.digest.beginTurn("a1", "claude", "chat1");
  h.digest.recordTool("a1", ...write("C:/p/a.ts"));
  h.at(60 * 60_000);
  h.digest.tick();
  assert.deepEqual(h.posted, [], "0 means off");

  h.store.update({ progressDigestMinutes: 3 });
  h.digest.tick();
  assert.equal(h.posted.length, 1, "and turning it back on applies to the turn already in flight");
});

test("a hub turn is never digested", () => {
  // The hub shows every tool call as it happens, so a digest there would summarise a transcript
  // the reader is already looking at.
  const h = harness();
  h.digest.beginTurn("a1", "claude", undefined);
  h.digest.recordTool("a1", ...write("C:/p/a.ts"));
  h.at(60 * 60_000);
  h.digest.tick();
  assert.deepEqual(h.posted, []);
});

test("the end of a turn posts nothing", () => {
  // The agent's own answer lands in the same chat moments later; a digest in front of it is the
  // near-duplicate post chatNoise.test.ts already covers (7 of them in one session).
  const h = harness();
  h.digest.beginTurn("a1", "claude", "chat1");
  h.digest.recordTool("a1", ...write("C:/p/a.ts"));
  h.at(60 * 60_000);
  h.digest.endTurn("a1");
  h.digest.tick();
  assert.deepEqual(h.posted, []);
});

// --- what /summary reads -------------------------------------------------------------------

test("the chat tally and the turn tally are fed from one call, so they cannot disagree", () => {
  const h = harness();
  h.digest.beginTurn("a1", "claude", "chat1");
  h.digest.recordTool("a1", ...write("C:/p/src/app.ts"));
  h.digest.endTurn("a1");
  h.digest.beginTurn("a2", "codex", "chat1");
  h.digest.recordTool("a2", ...bash("npm test"));
  h.digest.endTurn("a2");

  const facts = h.digest.factsForChat("chat1");
  assert.equal(facts.tally.filesWritten.size, 1);
  assert.equal(facts.tally.testRuns, 1);
  assert.deepEqual(h.digest.filesWrittenIn("chat1"), ["app.ts"]);
  assert.deepEqual(factsFor(facts.byHandle.get("claude")!), ["1 file written"]);
  assert.deepEqual(factsFor(facts.byHandle.get("codex")!), ["1 test run"]);
});

// --- the rule, asserted against the source ---------------------------------------------------

test("the digest cannot reach a model even by accident", () => {
  // Structural, not stylistic: this module has no import of an adapter, of AgentManager, or of
  // anything that could run a turn. The only things it is given are a settings store, a post
  // callback and (toolName, input) pairs. There is no seam a summary could enter through.
  for (const forbidden of ["adapters", "agentManager", "spawnCli", "runTurn", "prompt"]) {
    assert.ok(!SRC.includes(`from "./${forbidden}`), `progressDigest must not import ${forbidden}`);
    assert.ok(!SRC.includes(`from "../${forbidden}`), `progressDigest must not import ${forbidden}`);
  }
  assert.ok(!/\bimport\b[^\n]*adapters/.test(SRC));
});

test("the tally holds only numbers, paths and ports - there is nowhere to put a sentence", () => {
  // If a free-text field is ever added to DigestTally, a generated line becomes representable,
  // and from there it is one careless commit away from being posted.
  const shape = SRC.slice(SRC.indexOf("export interface DigestTally"), SRC.indexOf("export function emptyTally"));
  const fields = [...shape.matchAll(/^\s{2}(\w+):\s*([^;]+);/gm)].map(([, key, type]) => [key, type.trim()]);
  assert.deepEqual(fields, [
    ["filesWritten", "Set<string>"],
    ["filesRead", "Set<string>"],
    ["testRuns", "number"],
    ["commandRuns", "number"],
    ["searches", "number"],
    ["serverPorts", "Set<number>"],
  ]);
});

test("agentManager hands the digest the provider's own tool name and own arguments", () => {
  // Pre-formatting them would be the quiet way this stops working: classifyToolCall reads the
  // argument VALUES, so a flattened string counts nothing at all and the digest goes silent
  // while still looking wired up.
  const manager = readFileSync(join(import.meta.dirname, "agentManager.ts"), "utf8");
  assert.match(manager, /this\.progress\?\.recordTool\(agentId, event\.toolName \?\? event\.description, event\.input\)/);
  assert.match(manager, /this\.progress\?\.beginTurn\(agentId, runtime\.config\.handle, chatTurnId\)/);
  assert.match(manager, /this\.progress\?\.endTurn\(agentId\)/);
});

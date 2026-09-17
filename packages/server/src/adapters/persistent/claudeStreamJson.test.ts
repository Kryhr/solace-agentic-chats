import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { spawnCli } from "../../core/spawnCli";
import type { AdapterEvent, RunTurnOptions } from "../types";
import { createClaudeStreamJsonTransport } from "./claudeStreamJson";
import type { OpenSessionOptions, PersistentSession } from "./types";

/**
 * The persistent Claude transport, driven against a scripted CLI over REAL pipes.
 *
 * Every test here answers a question that "it compiles" cannot: does a SECOND message reach the
 * same process, does an interrupt land as a protocol call instead of a kill, what happens when
 * the process dies mid-turn, and does the stream reader survive a frame split across chunk
 * boundaries. The fixture is a stand-in, not evidence about the real binary - the real binary was
 * driven separately and that run is recorded in PERSISTENT-SESSIONS.md.
 */

const FAKE = join(__dirname, "fixtures", "fakeClaudeStreamJson.mjs");

function openSession(overrides: Partial<OpenSessionOptions> = {}) {
  const sessionEvents: AdapterEvent[] = [];
  const transport = createClaudeStreamJsonTransport(true, undefined, (options) =>
    // process.execPath and a .mjs entry, never an npm .cmd shim - see core/spawnCli.ts.
    spawnCli(process.execPath, [FAKE], {
      cwd: __dirname,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FAKE_SESSION_ID: options.sessionId ?? "fake-session" },
    }),
  );
  return {
    sessionEvents,
    open: () =>
      transport.open({
        cwd: __dirname,
        agentId: "agent-1",
        agentHandle: "tester",
        trustLevel: "acceptEdits",
        onSessionEvent: (event) => sessionEvents.push(event),
        ...overrides,
      }),
  };
}

function turn(prompt: string, signal?: AbortSignal): { options: RunTurnOptions; events: AdapterEvent[] } {
  const events: AdapterEvent[] = [];
  return {
    events,
    options: {
      cwd: __dirname,
      prompt,
      trustLevel: "acceptEdits",
      agentId: "agent-1",
      agentHandle: "tester",
      onEvent: (event) => events.push(event),
      signal,
    },
  };
}

const textOf = (events: AdapterEvent[]) =>
  events.filter((e): e is Extract<AdapterEvent, { type: "text" }> => e.type === "text").map((e) => e.text);

async function shut(session: PersistentSession) {
  await session.close("agent-removed");
}

/* -------------------------------------------------------------------------- */
/* The claim this whole change exists to make                                  */
/* -------------------------------------------------------------------------- */

test("a second message reaches the SAME process - one pid, no respawn", async () => {
  const { open } = openSession();
  const session = await open();
  const pidAtOpen = session.pid;
  assert.ok(pidAtOpen, "the session should hold a live process");

  const first = turn("first message");
  await session.send(first.options);
  const second = turn("second message");
  await session.send(second.options);

  // Two independent proofs that nothing was respawned between the turns: the OS pid did not
  // change, and the process itself reported its own pid inside both answers.
  assert.equal(session.pid, pidAtOpen, "the pid must not change between turns");
  assert.match(textOf(first.events)[0], new RegExp(`^pid=${pidAtOpen} heard: first message$`));
  assert.match(textOf(second.events)[0], new RegExp(`^pid=${pidAtOpen} heard: second message$`));
  assert.ok(session.alive(), "the process is still running after both turns");
  await shut(session);
});

test("each turn ends on the result frame, not on the process exiting", async () => {
  const { open } = openSession();
  const session = await open();
  const first = turn("one");
  await session.send(first.options);
  // send() resolved, so the turn is over - and yet the process is still there. That is the
  // entire difference from spawn-per-turn, stated as an assertion.
  assert.ok(session.alive());
  assert.equal(first.events.at(-1)?.type, "done");
  assert.ok(first.events.some((e) => e.type === "usage"));
  await shut(session);
});

test("a turn is not reported as busy once it has finished", async () => {
  const { open } = openSession();
  const session = await open();
  assert.equal(session.busy(), false);
  const first = turn("one");
  const pending = session.send(first.options);
  await pending;
  assert.equal(session.busy(), false);
  await shut(session);
});

/* -------------------------------------------------------------------------- */
/* Interrupt as a protocol call                                                */
/* -------------------------------------------------------------------------- */

test("an interrupt lands mid-turn and is acknowledged, without killing the process", async () => {
  const { open } = openSession();
  const session = await open();
  const controller = new AbortController();
  const slow = turn("SLOW", controller.signal);
  const running = session.send(slow.options);

  // Wait until the turn has actually started (the tool_use frame proves the fixture is working)
  // rather than racing the interrupt against the prompt write.
  await waitFor(() => slow.events.some((e) => e.type === "tool-use"));
  const acknowledged = await session.interrupt();
  assert.equal(acknowledged, true, "the CLI must answer the control_request");
  await running;

  assert.ok(session.alive(), "an interrupt is a protocol call - the process survives it");
  await shut(session);
});

test("aborting a turn interrupts it by protocol and the session stays usable", async () => {
  const { open } = openSession();
  const session = await open();
  const controller = new AbortController();
  const slow = turn("SLOW", controller.signal);
  const running = session.send(slow.options);
  await waitFor(() => slow.events.some((e) => e.type === "tool-use"));
  const pidBefore = session.pid;
  controller.abort();
  await running;

  assert.ok(slow.events.some((e) => e.type === "cancelled"), "an aborted turn reports itself cancelled, not failed");
  assert.ok(!slow.events.some((e) => e.type === "error"), "an interrupt is not an error");
  // The payoff: the next message goes into the same process, with its context intact, instead of
  // paying for a cold start the way a killed CLI would.
  assert.equal(session.pid, pidBefore);
  const next = turn("after the interrupt");
  await session.send(next.options);
  assert.match(textOf(next.events)[0], /heard: after the interrupt/);
  await shut(session);
});

test("interrupt on a session with no turn in flight reports false rather than claiming success", async () => {
  const { open } = openSession();
  const session = await open();
  // The fixture answers the control_request either way; what matters is that a caller can never
  // read "true" as "the turn you were worried about has stopped" when there was no turn.
  const first = turn("one");
  await session.send(first.options);
  await shut(session);
  assert.equal(await session.interrupt(), false, "a closed session cannot acknowledge anything");
});

/* -------------------------------------------------------------------------- */
/* The stream reader, over real pipes                                          */
/* -------------------------------------------------------------------------- */

test("a reply split one character at a time across many writes is reassembled", async () => {
  const { open } = openSession();
  const session = await open();
  const t = turn("SPLIT");
  await session.send(t.options);
  assert.deepEqual(textOf(t.events), ['a "quoted" \\ reply']);
  await shut(session);
});

test("a thinking block is reported as reasoning, never as the agent's answer", async () => {
  const { open } = openSession();
  const session = await open();
  const t = turn("THINK");
  await session.send(t.options);
  assert.deepEqual(
    t.events.filter((e) => e.type === "reasoning").map((e) => (e as { text: string }).text),
    ["weighing it up"],
  );
  assert.deepEqual(textOf(t.events), ["considered answer"]);
  await shut(session);
});

test("a non-JSON line is surfaced rather than dropped, and the turn still completes", async () => {
  const { open } = openSession();
  const session = await open();
  const t = turn("NOISE");
  await session.send(t.options);
  assert.ok(textOf(t.events).includes("this line is not JSON at all"));
  assert.ok(textOf(t.events).includes("answer after noise"));
  assert.equal(t.events.at(-1)?.type, "done");
  await shut(session);
});

test("a frame that carries nothing reportable still counts as liveness", async () => {
  // The system/init frame the real CLI opens with. An adapter that drops it silently is telling
  // the stuck-turn watchdog the process is dead - see AdapterEvent.heartbeat.
  const { open } = openSession();
  const session = await open();
  const t = turn("one");
  await session.send(t.options);
  assert.ok(t.events.some((e) => e.type === "heartbeat"));
  await shut(session);
});

test("a session fork reported by the stream is believed over the id we asked for", async () => {
  const { open } = openSession({ sessionId: "fake-session" });
  const session = await open();
  const t = turn("FORK");
  await session.send(t.options);
  const ids = t.events.filter((e) => e.type === "session").map((e) => (e as { sessionId: string }).sessionId);
  assert.ok(ids.includes("fake-session-forked"), "the stream is the authority on what session we are in");
  assert.equal(session.providerSessionId, "fake-session-forked");
  await shut(session);
});

/* -------------------------------------------------------------------------- */
/* Death, and what it costs                                                    */
/* -------------------------------------------------------------------------- */

test("a process that dies mid-turn fails THAT turn and marks the session dead", async () => {
  const { open } = openSession();
  const session = await open();
  const t = turn("DIE");
  await session.send(t.options);
  assert.ok(
    t.events.some((e) => e.type === "error" && /exited with code 3/.test((e as { message: string }).message)),
    "the turn is told what actually happened, not left to time out",
  );
  assert.equal(t.events.at(-1)?.type, "done");
  assert.equal(session.alive(), false, "a corpse is never reused");
});

test("a second send on a dead session is refused rather than hanging", async () => {
  const { open } = openSession();
  const session = await open();
  await session.send(turn("DIE").options);
  await assert.rejects(() => session.send(turn("anything").options), /not running/);
});

test("two concurrent turns on one session are refused - agentManager owns the queue", async () => {
  const { open } = openSession();
  const session = await open();
  const slow = turn("SLOW");
  const running = session.send(slow.options);
  await waitFor(() => session.busy());
  await assert.rejects(() => session.send(turn("second").options), /already in flight/);
  await session.interrupt();
  await running;
  await shut(session);
});

/* -------------------------------------------------------------------------- */
/* Closing                                                                     */
/* -------------------------------------------------------------------------- */

test("close ends stdin, the documented graceful shutdown, and the process goes away", async () => {
  const { open } = openSession();
  const session = await open();
  await session.send(turn("one").options);
  await session.close("idle");
  assert.equal(session.alive(), false);
});

test("close is idempotent and safe on an already-dead session", async () => {
  const { open } = openSession();
  const session = await open();
  await session.send(turn("DIE").options);
  await session.close("process-died");
  await session.close("process-died");
  assert.equal(session.alive(), false);
});

test("a disabled transport is unreachable, and says why", async () => {
  const transport = createClaudeStreamJsonTransport(false, "not driven against the real binary yet");
  assert.equal(transport.enabled, false);
  assert.equal(transport.disabledReason, "not driven against the real binary yet");
});

/* -------------------------------------------------------------------------- */

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for a condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

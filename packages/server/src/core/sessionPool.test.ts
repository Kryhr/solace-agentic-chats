import assert from "node:assert/strict";
import { test } from "node:test";

import type { ProviderAdapter, RunTurnOptions } from "../adapters/types";
import type {
  OpenSessionOptions,
  PersistentCapableAdapter,
  PersistentSession,
  SessionCloseReason,
} from "../adapters/persistent/types";
import { PersistentSessionPool } from "./sessionPool";

/**
 * The lifecycle answers, as assertions.
 *
 * Every test here corresponds to one question a long-lived process per agent per conversation
 * raises. They are checked with a recording stand-in rather than a real CLI because what is
 * being tested is the POOL's decisions - when to reuse, when to close, what reason to close
 * with - and a real process would make those decisions slower without making them any more real.
 * The transport itself is tested against a real child process in
 * adapters/persistent/claudeStreamJson.test.ts.
 */

interface Recorded extends PersistentSession {
  closes: SessionCloseReason[];
  opened: OpenSessionOptions;
  setBusy(value: boolean): void;
  kill(): void;
}

function recordingAdapter(): { adapter: ProviderAdapter; opens: OpenSessionOptions[]; sessions: Recorded[] } {
  const opens: OpenSessionOptions[] = [];
  const sessions: Recorded[] = [];
  let pid = 1000;
  const adapter: PersistentCapableAdapter = {
    id: "claude-code",
    async runTurn() {
      throw new Error("the spawn-per-turn path must not be reached in these tests");
    },
    persistent: {
      enabled: true,
      async open(options) {
        opens.push(options);
        let busy = false;
        let dead = false;
        const session: Recorded = {
          provider: "claude-code",
          pid: pid++,
          providerSessionId: options.sessionId,
          sessionToken: options.sessionToken,
          closes: [],
          opened: options,
          alive: () => !dead,
          busy: () => busy,
          setBusy: (v) => {
            busy = v;
          },
          kill: () => {
            dead = true;
          },
          async send(turn: RunTurnOptions) {
            turn.onEvent({ type: "text", text: `served by ${session.pid}` });
            turn.onEvent({ type: "done" });
          },
          async interrupt() {
            return true;
          },
          async close(reason) {
            session.closes.push(reason);
            dead = true;
          },
        };
        sessions.push(session);
        return session;
      },
    },
  };
  return { adapter, opens, sessions };
}

const base = (overrides: Partial<OpenSessionOptions & { key: string }> = {}) => ({
  key: "agent-1\u0000c:\\proj\u0000chat-1",
  cwd: "c:\\proj",
  agentId: "agent-1",
  agentHandle: "tester",
  trustLevel: "acceptEdits" as const,
  ...overrides,
});

const turn = (): RunTurnOptions & { events: string[] } => {
  const events: string[] = [];
  return {
    events,
    cwd: "c:\\proj",
    prompt: "hi",
    trustLevel: "acceptEdits",
    agentId: "agent-1",
    agentHandle: "tester",
    onEvent: (e) => events.push(e.type),
  };
};

/* -------------------------------------------------------------------------- */
/* Both paths work - the property that makes this safe to land                 */
/* -------------------------------------------------------------------------- */

test("an adapter with no persistent transport gets no runner, so it spawns per turn", async () => {
  const pool = new PersistentSessionPool();
  const plain: ProviderAdapter = { id: "codex-cli", async runTurn() {} };
  assert.equal(await pool.runnerFor(plain, base()), undefined);
  assert.equal(pool.size(), 0);
});

test("a transport that is switched OFF is unreachable, however complete its code is", async () => {
  const pool = new PersistentSessionPool();
  const { adapter } = recordingAdapter();
  (adapter as PersistentCapableAdapter & { persistent: { enabled: boolean } }).persistent.enabled = false;
  assert.equal(await pool.runnerFor(adapter, base()), undefined);
  assert.equal(pool.size(), 0, "a disabled transport must not even open a process");
});

test("a transport that fails to open falls back to spawn-per-turn instead of failing the turn", async () => {
  const pool = new PersistentSessionPool();
  const adapter: PersistentCapableAdapter = {
    id: "claude-code",
    async runTurn() {},
    persistent: {
      enabled: true,
      async open() {
        throw new Error("claude is not installed");
      },
    },
  };
  assert.equal(await pool.runnerFor(adapter, base()), undefined);
  assert.equal(pool.size(), 0);
});

/* -------------------------------------------------------------------------- */
/* Reuse, and what breaks it                                                   */
/* -------------------------------------------------------------------------- */

test("two turns in one conversation reuse one process", async () => {
  const pool = new PersistentSessionPool();
  const { adapter, opens } = recordingAdapter();
  const first = await pool.runnerFor(adapter, base());
  const second = await pool.runnerFor(adapter, base());
  assert.equal(opens.length, 1, "the second turn must not open a second process");
  assert.equal(first?.session.pid, second?.session.pid);
  await pool.closeAll("server-shutdown");
});

test("a different conversation in the same folder gets its own process", async () => {
  // sessionKey() already makes a new chat a new conversation; a live session's lifetime must be
  // exactly a conversation's, or a new chat would be answered out of the old chat's memory -
  // which is the complaint that made sessionKey per-conversation in the first place.
  const pool = new PersistentSessionPool();
  const { adapter, opens } = recordingAdapter();
  await pool.runnerFor(adapter, base({ key: "agent-1\u0000c:\\proj\u0000chat-1" }));
  await pool.runnerFor(adapter, base({ key: "agent-1\u0000c:\\proj\u0000chat-2" }));
  assert.equal(opens.length, 2);
  await pool.closeAll("server-shutdown");
});

test("changing the model closes the process instead of running the turn under the old one", async () => {
  const pool = new PersistentSessionPool();
  const { adapter, opens, sessions } = recordingAdapter();
  await pool.runnerFor(adapter, base({ model: "sonnet" }));
  await pool.runnerFor(adapter, base({ model: "opus" }));
  assert.equal(opens.length, 2);
  assert.deepEqual(sessions[0].closes, ["config-changed"]);
});

test("changing trust level, effort or account closes the process too", async () => {
  for (const change of [{ trustLevel: "plan" as const }, { effort: "high" }, { account: "work" }]) {
    const pool = new PersistentSessionPool();
    const { adapter, opens, sessions } = recordingAdapter();
    await pool.runnerFor(adapter, base());
    await pool.runnerFor(adapter, base(change));
    assert.equal(opens.length, 2, `${JSON.stringify(change)} must not be adopted by a running process`);
    assert.deepEqual(sessions[0].closes, ["config-changed"]);
  }
});

test("a process that died between turns is forgotten and replaced, not reused", async () => {
  const pool = new PersistentSessionPool();
  const { adapter, opens, sessions } = recordingAdapter();
  await pool.runnerFor(adapter, base());
  sessions[0].kill();
  const again = await pool.runnerFor(adapter, base());
  assert.equal(opens.length, 2);
  assert.ok(again);
  assert.deepEqual(sessions[0].closes, ["process-died"]);
});

test("a session already running a turn is not handed to a second turn", async () => {
  const pool = new PersistentSessionPool();
  const { adapter, sessions } = recordingAdapter();
  await pool.runnerFor(adapter, base());
  sessions[0].setBusy(true);
  // Undefined means "spawn this one per turn", which is strictly better than queueing behind a
  // turn the caller does not know about - its own queue position display would otherwise lie.
  assert.equal(await pool.runnerFor(adapter, base()), undefined);
  await pool.closeAll("server-shutdown");
});

/* -------------------------------------------------------------------------- */
/* The runner really is runTurn-shaped                                         */
/* -------------------------------------------------------------------------- */

test("the runner has runTurn's signature and emits ordinary AdapterEvents", async () => {
  const pool = new PersistentSessionPool();
  const { adapter } = recordingAdapter();
  const live = await pool.runnerFor(adapter, base());
  assert.ok(live);
  const t = turn();
  await live.run(t);
  assert.deepEqual(t.events, ["text", "done"]);
  await pool.closeAll("server-shutdown");
});

test("each session is given its own token, and it is the one the session was opened with", async () => {
  const pool = new PersistentSessionPool();
  const { adapter } = recordingAdapter();
  const a = await pool.runnerFor(adapter, base({ key: "a" }));
  const b = await pool.runnerFor(adapter, base({ key: "b" }));
  assert.ok(a?.session.sessionToken);
  assert.ok(b?.session.sessionToken);
  assert.notEqual(a.session.sessionToken, b.session.sessionToken);
  await pool.closeAll("server-shutdown");
});

/* -------------------------------------------------------------------------- */
/* Closing: every reason, actually reachable                                   */
/* -------------------------------------------------------------------------- */

test("an idle session is closed by the reaper, not left holding a process", async () => {
  let now = 0;
  const pool = new PersistentSessionPool(() => now, 1000);
  const { adapter, sessions } = recordingAdapter();
  await pool.runnerFor(adapter, base());
  now = 999;
  await pool.reap();
  assert.equal(pool.size(), 1, "not idle yet");
  now = 1001;
  await pool.reap();
  assert.equal(pool.size(), 0);
  assert.deepEqual(sessions[0].closes, ["idle"]);
});

test("the reaper never takes a process away from a turn that is running", async () => {
  let now = 0;
  const pool = new PersistentSessionPool(() => now, 1000);
  const { adapter, sessions } = recordingAdapter();
  await pool.runnerFor(adapter, base());
  sessions[0].setBusy(true);
  now = 100_000;
  await pool.reap();
  assert.equal(pool.size(), 1, "a running turn must not be reported as a failure by a cache policy");
  assert.deepEqual(sessions[0].closes, []);
});

test("removing an agent closes every session it had, in every conversation", async () => {
  const pool = new PersistentSessionPool();
  const { adapter, sessions } = recordingAdapter();
  await pool.runnerFor(adapter, base({ key: "agent-1\u0000a", agentId: "agent-1" }));
  await pool.runnerFor(adapter, base({ key: "agent-1\u0000b", agentId: "agent-1" }));
  await pool.runnerFor(adapter, base({ key: "agent-2\u0000a", agentId: "agent-2" }));
  await pool.closeAgent("agent-1", "agent-removed");
  assert.equal(pool.size(), 1);
  assert.deepEqual(sessions[0].closes, ["agent-removed"]);
  assert.deepEqual(sessions[1].closes, ["agent-removed"]);
  assert.deepEqual(sessions[2].closes, []);
  await pool.closeAll("server-shutdown");
});

test("the ceiling evicts the least recently used idle session rather than growing forever", async () => {
  const pool = new PersistentSessionPool(() => Date.now(), 60_000, 2);
  const { adapter, sessions } = recordingAdapter();
  await pool.runnerFor(adapter, base({ key: "one" }));
  await new Promise((r) => setTimeout(r, 2));
  await pool.runnerFor(adapter, base({ key: "two" }));
  await new Promise((r) => setTimeout(r, 2));
  await pool.runnerFor(adapter, base({ key: "three" }));
  assert.equal(pool.size(), 2);
  assert.deepEqual(sessions[0].closes, ["evicted"], "the oldest idle one goes");
  assert.deepEqual(sessions[1].closes, []);
  await pool.closeAll("server-shutdown");
});

test("when everything is busy the ceiling declines the live path instead of evicting a live turn", async () => {
  const pool = new PersistentSessionPool(() => Date.now(), 60_000, 1);
  const { adapter, sessions } = recordingAdapter();
  await pool.runnerFor(adapter, base({ key: "one" }));
  sessions[0].setBusy(true);
  await assert.rejects(() => pool.runnerFor(adapter, base({ key: "two" })), /no idle session to evict/);
  assert.deepEqual(sessions[0].closes, [], "a running turn is never sacrificed to a cache limit");
  sessions[0].setBusy(false);
  await pool.closeAll("server-shutdown");
});

test("shutdown closes everything and refuses to open anything new", async () => {
  const pool = new PersistentSessionPool();
  const { adapter, sessions } = recordingAdapter();
  await pool.runnerFor(adapter, base({ key: "one" }));
  await pool.runnerFor(adapter, base({ key: "two" }));
  await pool.closeAll("server-shutdown");
  assert.equal(pool.size(), 0);
  assert.deepEqual(sessions.map((s) => s.closes), [["server-shutdown"], ["server-shutdown"]]);
  // A turn that arrives while the server is going down must not start a process that would
  // outlive it - that is precisely the leak this is here to prevent.
  assert.equal(await pool.runnerFor(adapter, base({ key: "three" })), undefined);
});

test("an interrupt is routed to the live session, and reports false when there is none", async () => {
  const pool = new PersistentSessionPool();
  const { adapter } = recordingAdapter();
  assert.equal(await pool.interrupt("nothing-here"), false);
  await pool.runnerFor(adapter, base({ key: "one" }));
  assert.equal(await pool.interrupt("one"), true);
  await pool.closeAll("server-shutdown");
});

test("nothing survives a restart: a fresh pool holds no sessions", () => {
  // Stated as a test because the honest answer to "what happens on server restart" is "nothing
  // is carried over", and the thing that DOES carry over - the provider's own session id - is
  // persisted elsewhere and resumed into a new process on the first turn.
  assert.equal(new PersistentSessionPool().size(), 0);
});

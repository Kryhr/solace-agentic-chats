import { randomUUID } from "node:crypto";
import type { ProviderAdapter, RunTurnOptions } from "../adapters/types";
import {
  persistentTransportOf,
  sessionIdentity,
  type OpenSessionOptions,
  type PersistentSession,
  type SessionCloseReason,
} from "../adapters/persistent/types";
import type { AdapterEvent } from "../adapters/types";

/**
 * The live processes, and every honest answer about their lifetime.
 *
 * A long-lived process per agent per conversation is a real liability, not a free win: it holds
 * a CLI, its MCP bridge children, an open session against the provider, and a slice of the
 * machine, for as long as nobody decides otherwise. This file is where "nobody decides
 * otherwise" is not allowed to happen. Each question below is answered in code, not in hope:
 *
 *   WHEN DOES IT CLOSE?  Six ways, and they are the SessionCloseReason union, all reachable:
 *     - idle: no turn for IDLE_TTL_MS. The reaper below, not a promise that someone will call.
 *     - agent-removed: the agent was deleted, or its chat was cleared.
 *     - session-reset: `/reset` asked for a cold start and must actually get one.
 *     - config-changed: model / effort / trust level / account / cwd changed. Every one of those
 *       is a process-start flag, so a live process CANNOT adopt it; keeping the process would
 *       run the turn under the old setting while the UI showed the new one.
 *     - evicted: MAX_LIVE_SESSIONS reached; the oldest idle session goes.
 *     - server-shutdown: the exit hooks at the bottom of this file.
 *
 *   WHAT HAPPENS ON SERVER RESTART?  Nothing survives, and nothing pretends to. The CLIs are our
 *     children, so they die with us (and the shutdown hook kills the tree so they die on Windows
 *     too, where that is not automatic). The pool starts EMPTY. What does survive is what
 *     already survived before this change: the provider's own session id, persisted per
 *     conversation, so the first turn after a restart opens a new process and RESUMES that
 *     conversation. A persistent session is an in-memory optimisation and is never a durability
 *     claim - conflating the two would have the app promise to remember something it cannot.
 *
 *   WHAT IF THE CLI DIES?  The session marks itself dead, the pool evicts it on the next lookup,
 *     and the next turn opens a fresh one. A death DURING a turn fails that turn (the agent may
 *     already have posted half an answer; silently re-running it would duplicate work in the
 *     chat), and a death BETWEEN turns costs nothing at all.
 *
 *   HOW IS A LEAKED PROCESS NOT LEFT RUNNING?  Three independent nets, because one is not enough
 *     on Windows: every close goes through killCliTree (kills the whole tree, not just the
 *     handle we hold); the idle reaper closes sessions nobody remembered to; and process-level
 *     exit/SIGINT/SIGTERM hooks close everything still open. The hooks are installed once, lazily,
 *     the first time a session is actually opened, so importing this module in a test does not
 *     attach listeners to the test runner's process.
 */

/**
 * How long a session may sit with no turn before it is closed.
 *
 * Deliberately on the short side of "an agent is idle between messages in a conversation".
 * Fifteen minutes covers the observed gaps within an active chat (median reply latency was
 * 41-58 s, p90 5-20 min) while making sure a chat nobody returns to after lunch is not still
 * holding a CLI process at the end of the day.
 */
export const IDLE_TTL_MS = 15 * 60 * 1000;

/** How often the reaper looks. A quarter of the TTL, so the worst-case overshoot is small and
 * the timer is cheap. */
export const REAP_INTERVAL_MS = IDLE_TTL_MS / 4;

/**
 * The ceiling on live processes across the whole server.
 *
 * Each one is a real CLI plus its MCP bridge children. With four agents in each of a few chats
 * this is comfortably above normal use, and it exists so that a pathological case (many agents,
 * many chats, all touched once) degrades into spawn-per-turn - which still works - instead of
 * into a machine with forty coding agents resident on it.
 */
export const MAX_LIVE_SESSIONS = 12;

/**
 * Every pool that has ever opened a session, and the ONE set of process hooks that closes them.
 *
 * Module-level rather than per-pool because process listeners are a finite, shared resource: a
 * pool that installed its own would add three listeners each, and node starts warning at ten -
 * which is not merely noise, it is the runtime telling you something is being leaked. In
 * production there is exactly one pool; in the test suite there are dozens, and they must not
 * between them install sixty handlers on the test runner's process.
 */
const livePools = new Set<PersistentSessionPool>();
let exitHooksInstalled = false;

function installExitHooksOnce(): void {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;
  const closeEverything = () => Promise.all([...livePools].map((pool) => pool.closeAll("server-shutdown")));
  // `exit` is synchronous-only: close() cannot be awaited here, but the kill it issues is a
  // spawn the OS completes regardless of whether this process sticks around to see it.
  process.once("exit", () => void closeEverything());
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void closeEverything().finally(() => {
        // Re-raise rather than swallow, so ctrl-c still exits. Without the removeAllListeners
        // this would re-enter the handler we are standing in.
        process.removeAllListeners(signal);
        process.kill(process.pid, signal);
      });
    });
  }
}

interface Entry {
  session: PersistentSession;
  /** agentId + sessionKey(cwd, conversationId). */
  key: string;
  agentId: string;
  /** The process-start flags this session was opened with - see sessionIdentity. */
  identity: string;
  lastUsedAt: number;
}

export interface AcquireOptions extends OpenSessionOptions {
  /** agentId + sessionKey(cwd, conversationId): the unit of a conversation this repo already
   * has. Reused rather than invented so a live session's lifetime is exactly a conversation's. */
  key: string;
}

/** A function with runTurn's exact shape. The whole point of the seam: agentManager calls one of
 * these and does not care which transport produced it. */
export type TurnRunner = (options: RunTurnOptions) => Promise<void>;

export class PersistentSessionPool {
  private readonly entries = new Map<string, Entry>();
  private reaper: NodeJS.Timeout | undefined;
  private hooksInstalled = false;
  /** Set once closeAll has run, so a session opened during shutdown is not left behind. */
  private shuttingDown = false;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly idleTtlMs: number = IDLE_TTL_MS,
    private readonly maxLiveSessions: number = MAX_LIVE_SESSIONS,
  ) {}

  /** How many live processes the pool is holding. Exposed for status reporting and for tests
   * that need to assert nothing was left behind. */
  size(): number {
    return this.entries.size;
  }

  /** The live session for a key, if there is one. Never returns a dead or mismatched session:
   * both are closed and forgotten here rather than handed out. */
  private reuse(key: string, identity: string): PersistentSession | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (!entry.session.alive()) {
      this.entries.delete(key);
      void entry.session.close("process-died");
      return undefined;
    }
    if (entry.identity !== identity) {
      this.entries.delete(key);
      void entry.session.close("config-changed");
      return undefined;
    }
    return entry.session;
  }

  /**
   * The runner for a turn: a live-session one when the provider has a transport that is switched
   * ON and a session can actually be opened, and `undefined` - meaning "use adapter.runTurn" -
   * in every other case.
   *
   * FAILING TO OPEN IS NOT AN ERROR HERE. It returns undefined and the caller spawns per turn,
   * exactly as it did before this change existed. That is the property that makes this safe to
   * land: the worst case of the new path is the old path.
   */
  async runnerFor(
    adapter: ProviderAdapter,
    options: AcquireOptions,
  ): Promise<{ run: TurnRunner; session: PersistentSession } | undefined> {
    if (this.shuttingDown) return undefined;
    const transport = persistentTransportOf(adapter);
    if (!transport) return undefined;

    const identity = sessionIdentity(options);
    const existing = this.reuse(options.key, identity);
    if (existing) {
      if (existing.busy()) {
        // agentManager owns the queue and runs one turn per agent, so this should not happen.
        // If it ever does, falling back to a spawned turn is strictly better than serialising
        // behind a turn the caller does not know about - the caller's own "queued (#2)" would
        // otherwise be a lie.
        return undefined;
      }
      this.touch(options.key);
      return { run: (turn) => existing.send(turn), session: existing };
    }

    this.installExitHooks();
    await this.makeRoom();
    let session: PersistentSession;
    try {
      session = await transport.open({
        ...options,
        // Minted per SESSION, not per turn - see OpenSessionOptions.sessionToken for exactly
        // what that changes and what it does not.
        sessionToken: options.sessionToken ?? randomUUID(),
        onSessionEvent: (event) => this.onSessionEvent(options.key, event),
      });
    } catch {
      // Could not start a live process (binary missing, flag rejected, anything). The old path
      // still works and will report its own failure properly if the CLI is genuinely broken.
      return undefined;
    }
    this.entries.set(options.key, {
      session,
      key: options.key,
      agentId: options.agentId,
      identity,
      lastUsedAt: this.now(),
    });
    this.startReaper();
    return { run: (turn) => session.send(turn), session };
  }

  private onSessionEvent(key: string, event: AdapterEvent): void {
    // The only thing the pool itself does with out-of-turn output is notice death. Everything
    // else is the caller's to show or ignore; the pool must not invent a channel for it.
    if (event.type !== "error" && event.type !== "done") return;
    const entry = this.entries.get(key);
    if (entry && !entry.session.alive()) this.entries.delete(key);
  }

  touch(key: string): void {
    const entry = this.entries.get(key);
    if (entry) entry.lastUsedAt = this.now();
  }

  /** Interrupt the turn in flight on a key's session by PROTOCOL rather than by killing the
   * process. Returns false when there is no live session or the provider did not acknowledge -
   * in both cases the caller must fall back to aborting the turn the old way. */
  async interrupt(key: string): Promise<boolean> {
    const entry = this.entries.get(key);
    if (!entry || !entry.session.alive()) return false;
    return entry.session.interrupt();
  }

  async close(key: string, reason: SessionCloseReason): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    await entry.session.close(reason);
  }

  /** Close every session belonging to one agent, whatever conversation it was in. Used for agent
   * removal and for `/reset`, both of which mean "this agent's provider-side memory is gone". */
  async closeAgent(agentId: string, reason: SessionCloseReason): Promise<void> {
    const doomed = [...this.entries.values()].filter((e) => e.agentId === agentId);
    for (const entry of doomed) this.entries.delete(entry.key);
    await Promise.all(doomed.map((e) => e.session.close(reason)));
  }

  async closeAll(reason: SessionCloseReason): Promise<void> {
    if (reason === "server-shutdown") this.shuttingDown = true;
    const doomed = [...this.entries.values()];
    this.entries.clear();
    this.stopReaper();
    livePools.delete(this);
    this.hooksInstalled = false;
    await Promise.all(doomed.map((e) => e.session.close(reason)));
  }

  /** Enforce MAX_LIVE_SESSIONS by closing the least recently used IDLE session. A busy session is
   * never evicted: taking a process away mid-turn would present a running turn as a failure, and
   * a ceiling is not worth lying about what happened to a turn. */
  private async makeRoom(): Promise<void> {
    while (this.entries.size >= this.maxLiveSessions) {
      const candidates = [...this.entries.values()]
        .filter((e) => !e.session.busy())
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
      const victim = candidates[0];
      // Everything is busy. Rather than evict a running turn, decline the live path for this one
      // turn; the caller spawns per turn, which is exactly what it did before.
      if (!victim) throw new Error("no idle session to evict");
      this.entries.delete(victim.key);
      await victim.session.close("evicted");
    }
  }

  private startReaper(): void {
    if (this.reaper) return;
    this.reaper = setInterval(() => void this.reap(), REAP_INTERVAL_MS);
    // An interval must never be the reason node stays alive: the pool is a cache, not a service.
    this.reaper.unref?.();
  }

  private stopReaper(): void {
    if (!this.reaper) return;
    clearInterval(this.reaper);
    this.reaper = undefined;
  }

  /** Close sessions that have gone quiet, and forget ones whose process has died. Exposed so a
   * test can run it on demand rather than waiting fifteen real minutes. */
  async reap(): Promise<void> {
    const cutoff = this.now() - this.idleTtlMs;
    const doomed: { entry: Entry; reason: SessionCloseReason }[] = [];
    for (const entry of this.entries.values()) {
      if (!entry.session.alive()) doomed.push({ entry, reason: "process-died" });
      else if (!entry.session.busy() && entry.lastUsedAt <= cutoff) doomed.push({ entry, reason: "idle" });
    }
    for (const { entry } of doomed) this.entries.delete(entry.key);
    await Promise.all(doomed.map(({ entry, reason }) => entry.session.close(reason)));
    if (this.entries.size === 0) this.stopReaper();
  }

  /**
   * The last net. Without it, a `ctrl-c` on the dev server leaves one live CLI per open
   * conversation running on the machine, still holding its MCP bridge children and still able to
   * write files - invisible, because the thing that knew about them is gone.
   *
   * Registration is lazy, on the first real open, so importing this module (as every test that
   * touches agentManager does) attaches nothing to a test runner's process until a session is
   * genuinely opened.
   */
  private installExitHooks(): void {
    if (this.hooksInstalled) return;
    this.hooksInstalled = true;
    livePools.add(this);
    installExitHooksOnce();
  }
}

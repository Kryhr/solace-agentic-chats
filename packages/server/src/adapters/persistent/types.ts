import type { ProviderId } from "@solace/shared";
import type { AdapterEvent, ProviderAdapter, RunTurnOptions } from "../types";

/**
 * The persistent-session seam.
 *
 * WHAT THIS REMOVES. `ProviderAdapter.runTurn` is request/response by shape: it spawns a CLI,
 * feeds it one prompt, reads until the process exits, and resolves. That shape is the reason an
 * agent cannot be spoken to until its process ends - measured across 28 real chats, 45% of
 * replies to an @mention took over two minutes, and every one of those waits is a recipient
 * finishing something else first. No prompt wording changes it; only the transport does.
 *
 * WHAT IT DOES NOT CHANGE. `runTurn` stays exactly as it is, and eleven adapters keep using it.
 * This interface sits ALONGSIDE it. An adapter that offers a persistent transport still
 * implements `runTurn` (it is the fallback when opening a session fails, and the only path when
 * the transport is disabled), so nothing here is a migration that can leave a provider stranded
 * half-way.
 *
 * THE SHAPE IS DELIBERATELY `send(RunTurnOptions)`. A persistent session could have taken a
 * smaller, tidier "just the text" argument - but then agentManager would need two call sites
 * with two sets of event plumbing, and the two would drift. Instead `send` accepts the SAME
 * options object `runTurn` does and emits the SAME AdapterEvents, so the pool can hand
 * agentManager a function that is substitutable for `adapter.runTurn` at one line of the call
 * site. Options that only make sense at session-open time (cwd, trustLevel, model, account) are
 * read from the open call; passing a different value to `send` is a programming error and the
 * pool guards against it by keying the session on exactly those values (see SessionIdentity).
 */

/**
 * Why a live process was shut down. Every one of these is a real, reachable case that had to be
 * decided rather than left to chance - a long-lived process per agent per conversation is a
 * resource leak the moment one of them is unanswered. See core/sessionPool.ts, which is where
 * each is actually triggered.
 */
export type SessionCloseReason =
  /** No turn for the idle TTL. The overwhelming majority of closes. */
  | "idle"
  /** The agent was deleted, or the whole chat was cleared/archived. */
  | "agent-removed"
  /** `/reset` - the operator explicitly asked for a cold start. */
  | "session-reset"
  /** Server is going down. Synchronous best-effort kill, see the exit hooks in the pool. */
  | "server-shutdown"
  /**
   * Something the session was OPENED with changed - model, effort, trust level, account, cwd.
   * These are process-start flags for every CLI here, so a live process cannot adopt a new one;
   * keeping it would silently run the turn under the old setting while the UI showed the new.
   */
  | "config-changed"
  /** The CLI exited on its own, or failed to start. The pool evicts rather than reusing a corpse. */
  | "process-died"
  /** The pool's ceiling on concurrent live processes was reached and this was the oldest idle one. */
  | "evicted";

/** Everything a session is opened with. Each field here is part of the session's identity: change
 * one and the pool must close the old process and open a new one, because every CLI in this
 * repo takes these as process-start flags. */
export interface OpenSessionOptions {
  cwd: string;
  agentId: string;
  agentHandle: string;
  trustLevel: RunTurnOptions["trustLevel"];
  model?: string;
  effort?: string;
  account?: string;
  /** The provider's own conversation id to resume into, if one was stored from an earlier
   * (possibly spawn-per-turn) turn. Undefined starts a new provider-side conversation. */
  sessionId?: string;
  /**
   * The secret handed to helper processes this session spawns (the approval bridge, the solace
   * MCP bridge), so an internal HTTP route can tell a real agent's process from anything else
   * that can reach the port.
   *
   * THIS IS A DELIBERATE, DOCUMENTED CHANGE IN SCOPE, and it is the one security property the
   * persistent transport moves. In spawn-per-turn it is minted per TURN and cleared when the
   * turn ends, so a child that outlived its turn could not keep acting as the agent. A live
   * session spawns its MCP bridge ONCE, at process start, with this value in its environment -
   * there is no second chance to hand it a new one - so the secret is now per SESSION.
   *
   * What does NOT change is the check that matters: agentManager still only accepts the token
   * while a turn is actually in flight (it installs this as the agent's active token for the
   * duration of each turn and clears it in between). So a bridge process that outlives its
   * session still cannot act as the agent; what it gains is the ability to act during a LATER
   * turn of the SAME session, which is exactly the window the session is alive for anyway.
   */
  sessionToken?: string;
  /**
   * Events that arrive while NO turn is in flight.
   *
   * This has no equivalent in the spawn-per-turn world and is the honest cost of a live process:
   * a CLI can say something after its turn's terminal frame (a late rate-limit notice, a
   * background MCP warning, its own exit). Dropping those silently would mean the transport
   * quietly lost information; attributing them to the NEXT turn would be worse, because it would
   * present one turn's failure as another turn's output. So they are delivered here, labelled,
   * and the pool's only use for them today is to notice death and eviction.
   */
  onSessionEvent?: (event: AdapterEvent) => void;
}

export interface PersistentSession {
  readonly provider: ProviderId;
  /**
   * The OS pid of the live process.
   *
   * Exposed for exactly one reason: it is the only way to PROVE a second message reached a
   * session without a respawn. A test that sends twice and asserts one pid across both turns is
   * a claim that can be checked; "it felt faster" is not.
   */
  readonly pid: number | undefined;
  /** The provider's own conversation id, once the provider has stated one. */
  readonly providerSessionId: string | undefined;
  /** The secret this session's helper processes were started with - see
   * OpenSessionOptions.sessionToken. agentManager installs it as the agent's active turn token
   * for the duration of every turn that runs on this session. */
  readonly sessionToken: string | undefined;
  /** False as soon as the process is gone, for any reason. Checked before every reuse. */
  alive(): boolean;
  /** True while a turn is in flight. A second concurrent `send` on one session is rejected
   * rather than queued here: agentManager already owns the queue, and having two queues would
   * make "queued (#2)" in the UI a lie. */
  busy(): boolean;
  /**
   * Push one message into the live process and stream this turn's AdapterEvents to
   * `options.onEvent`. Resolves when the provider signals the turn is over - NOT when the
   * process exits, because it does not exit.
   */
  send(options: RunTurnOptions): Promise<void>;
  /**
   * Stop the turn in flight with a PROTOCOL call rather than a kill.
   *
   * This is the second reason the transport matters. Today an interrupt is `killCliTree`: the
   * CLI dies, its context dies with it, and the next turn pays a cold start and re-reads
   * everything. Here the agent is told to stop, keeps its context, and is ready for the next
   * message immediately.
   *
   * Resolves true if the provider ACKNOWLEDGED the interrupt, false if it did not (no ack frame,
   * or the provider has no interrupt). False is not "it failed" - it is "we cannot say it
   * landed", and the caller must fall back to aborting the turn the old way rather than assume.
   */
  interrupt(): Promise<boolean>;
  /** Shut the process down. Idempotent; safe to call on an already-dead session. */
  close(reason: SessionCloseReason): Promise<void>;
}

/**
 * A provider's persistent transport, and - just as importantly - whether it is switched on.
 *
 * `enabled` is a hard gate that exists because of this repo's standing rule: nothing is claimed
 * unless it was checked. A transport whose protocol has been written but never driven against
 * the real CLI ships with `enabled: false` and a `disabledReason` saying exactly what is
 * missing. It is then unreachable - `persistentTransportOf` returns undefined for it - so no
 * turn can accidentally take an unproven path, and the honest state is a string a human can
 * read rather than a silent absence.
 */
export interface PersistentTransport {
  readonly enabled: boolean;
  /** Required whenever `enabled` is false. One sentence, written for a human, saying what has
   * not been verified and what would verify it. */
  readonly disabledReason?: string;
  open(options: OpenSessionOptions): Promise<PersistentSession>;
}

export interface PersistentCapableAdapter extends ProviderAdapter {
  readonly persistent: PersistentTransport;
}

/**
 * The transport an adapter offers, or undefined - which means "run this turn the old way".
 *
 * A DISABLED transport reads as undefined here on purpose. Callers then have exactly one branch
 * ("is there a live path for this provider?") instead of two, and it is impossible to write a
 * call site that checks for the transport's presence but forgets to check `enabled`.
 */
export function persistentTransportOf(adapter: ProviderAdapter): PersistentTransport | undefined {
  const candidate = (adapter as Partial<PersistentCapableAdapter>).persistent;
  if (!candidate || typeof candidate.open !== "function") return undefined;
  return candidate.enabled ? candidate : undefined;
}

/** The transport an adapter offers even when it is switched off, for status reporting only.
 * Never use this to decide how to run a turn. */
export function declaredTransportOf(adapter: ProviderAdapter): PersistentTransport | undefined {
  const candidate = (adapter as Partial<PersistentCapableAdapter>).persistent;
  return candidate && typeof candidate.open === "function" ? candidate : undefined;
}

/**
 * The fields that make two turns the SAME live session.
 *
 * Anything not in here (the prompt, the reply channel, the abort signal, the per-turn token)
 * legitimately differs turn to turn. Everything IN here is a process-start flag for every CLI in
 * this repo, so a change to one cannot be adopted by a running process and must close it -
 * otherwise a turn would run under the old model while the UI showed the new one, which is
 * exactly the kind of quiet disagreement this codebase treats as a bug rather than a nuance.
 *
 * The separator is NUL for the same reason sessionKey() uses one: it is the byte that cannot
 * appear in any of the parts, so two different tuples can never collide into one string. (It is
 * built at runtime and never written to a source file - see the note in CLAUDE.md.)
 */
export function sessionIdentity(
  options: Pick<OpenSessionOptions, "trustLevel" | "model" | "effort" | "account">,
): string {
  return [options.trustLevel, options.model ?? "", options.effort ?? "", options.account ?? ""].join("\0");
}

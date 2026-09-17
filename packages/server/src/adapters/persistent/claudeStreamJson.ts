import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type { ProviderId } from "@solace/shared";
import { killCliTree, spawnCli } from "../../core/spawnCli";
import { SERVER_PORT } from "../../core/serverPort";
import { accountEnv } from "../../core/providerAccounts";
import { mcpServersForAgent } from "../../core/mcpServers";
import { flagsForTrustLevel, handleClaudeStreamLine, type ClaudeStreamState } from "../claude-code";
import type { AdapterEvent, RunTurnOptions } from "../types";
import type { OpenSessionOptions, PersistentSession, PersistentTransport, SessionCloseReason } from "./types";

/**
 * Claude Code as a LIVE process: `--input-format stream-json`, stdin held open for the lifetime
 * of the session, one JSON object per message pushed in, events read out continuously.
 *
 * WHY THIS ONE FIRST. It is what the operator actually uses, and it is the provider where the
 * measured pain lives: an agent mid-turn cannot be spoken to until its process exits, and the
 * only way to say something to it is to wait. Here a second message is a line on a pipe.
 *
 * WHAT WAS READ OFF THE REAL BINARY rather than from prose (claude.exe 2.1.238, this machine):
 *
 *   --input-format <text|stream-json>  "(only works with --print) ... realtime streaming input"
 *   --replay-user-messages             "(only works with --input-format=stream-json and
 *                                       --output-format=stream-json)"
 *   The CLI's own description of its input stream, verbatim:
 *     "exactly one StdinMessage per line, as a single JSON object - user messages that start
 *      turns, control requests the client originates, control responses answering the CLI's
 *      requests, cancellations and keep-alives. initialize is optional and normally the first
 *      line; the first user message initializes with defaults. ... Closing the stream tells the
 *      CLI to finish the current turn and exit."
 *   {type:"control_request", request_id, request:{subtype:"interrupt"}} and its
 *   {type:"control_response", response:{subtype:"success"|"error", request_id, ...}} answer,
 *   both present verbatim in the binary alongside the CLI's own client implementation.
 *
 * THE LAST SENTENCE OF THAT PARAGRAPH IS THE WHOLE LIFECYCLE ANSWER for closing: ending stdin is
 * a GRACEFUL shutdown that lets the current turn finish, which is why close() does that first
 * and only reaches for killCliTree if the process is still there after a grace period.
 *
 * `--replay-user-messages` is deliberately NOT passed. It would be a convenient acknowledgement
 * that a message landed, but the echoed frame is shaped like an assistant frame
 * (message.content[] with a text block), so the shared stream reader would post the agent's own
 * incoming prompt back into the chat as if the agent had said it. A transport that makes an
 * agent quote its own instructions to the room is worse than no acknowledgement.
 */

/** How long close() waits for a graceful exit after ending stdin before killing the tree.
 * Generous, because the CLI's documented behaviour on stdin close is to FINISH THE CURRENT TURN
 * first - killing during that would throw away work the agent had already done. */
export const CLOSE_GRACE_MS = 10_000;

/** How long interrupt() waits for the CLI's control_response before reporting that it cannot say
 * the interrupt landed. Short: this is a local pipe round-trip, not model work. */
export const INTERRUPT_ACK_MS = 5_000;

interface PendingTurn {
  finish: () => void;
  onEvent: (event: AdapterEvent) => void;
}

class ClaudeStreamJsonSession implements PersistentSession {
  readonly provider: ProviderId = "claude-code";
  readonly sessionToken: string | undefined;

  private child: ChildProcess | undefined;
  private buffer = "";
  private stderrBuffer = "";
  private state: ClaudeStreamState;
  private turn: PendingTurn | undefined;
  private dead = false;
  private closing = false;
  /** Resolvers for control_requests WE sent, keyed by request_id. */
  private readonly controls = new Map<string, (response: unknown) => void>();

  constructor(
    private readonly options: OpenSessionOptions,
    /** Injected so tests can drive a scripted stand-in over real pipes instead of spending a
     * real Claude turn. Defaults to the real CLI. */
    private readonly spawn: (args: string[], env: NodeJS.ProcessEnv) => ChildProcess = (args, env) =>
      spawnCli("claude", args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"], env }),
  ) {
    this.sessionToken = options.sessionToken;
    // The id is chosen HERE, before the process starts, for the same reason the spawn-per-turn
    // adapter chooses it: we then know the conversation's id even if the process dies before
    // emitting a single line, so the next attempt can resume rather than silently starting cold.
    this.state = { sessionId: options.sessionId ?? randomUUID() };
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get providerSessionId(): string | undefined {
    return this.state.sessionId;
  }

  alive(): boolean {
    return !this.dead && !this.closing && this.child !== undefined;
  }

  busy(): boolean {
    return this.turn !== undefined;
  }

  /** The flags this session's process is started with. Exported shape kept identical to the
   * spawn-per-turn adapter's, minus the one-shot bits, so the two cannot diverge on trust level,
   * MCP wiring or model selection - the things that decide what the agent may actually DO. */
  args(): string[] {
    const resuming = this.options.sessionId !== undefined;
    return [
      "-p",
      ...(resuming ? ["--resume", this.state.sessionId] : ["--session-id", this.state.sessionId]),
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      ...flagsForTrustLevel(this.options.trustLevel, mcpServersForAgent(this.options.agentId)),
      ...(this.options.model ? ["--model", this.options.model] : []),
      ...(this.options.effort ? ["--effort", this.options.effort] : []),
    ];
  }

  start(): void {
    const child = this.spawn(this.args(), {
      ...process.env,
      SOLACE_AGENT_ID: this.options.agentId,
      SOLACE_SERVER_PORT: String(SERVER_PORT),
      ...(this.options.sessionToken ? { SOLACE_TURN_TOKEN: this.options.sessionToken } : {}),
      ...accountEnv("claude-code", this.options.account),
    });
    this.child = child;
    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderrBuffer += chunk;
    });
    // A write to a stdin whose peer is gone throws EPIPE asynchronously and would take the whole
    // server down. The death is already reported through the in-flight turn, below.
    child.stdin?.on("error", () => {});
    child.on("error", (err) => this.died(`failed to start claude CLI: ${err.message}`));
    child.on("close", (code, signal) => {
      // Flush a final line that arrived without a trailing newline: a process that answers and
      // exits in the same breath would otherwise have its last frame dropped, and the turn would
      // hang until the watchdog killed it rather than simply ending.
      const rest = this.buffer;
      this.buffer = "";
      if (rest.trim()) this.line(rest);
      if (this.closing) {
        this.died(undefined);
        return;
      }
      this.died(
        signal
          ? `the Claude Code session was terminated by ${signal}`
          : `the Claude Code session exited with code ${code}` +
            (this.stderrBuffer.trim() ? `: ${this.stderrBuffer.trim()}` : ""),
      );
    });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const raw = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      this.line(raw);
    }
  }

  private line(raw: string): void {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) return;

    // Control frames are handled BEFORE the shared stream reader, and never reach it. Order
    // matters for the same reason it does in the ACP transport: a control_response routed into
    // the content interpreter would be reported as a heartbeat, the interrupt would never be
    // acknowledged, and we would fall back to killing a process that had in fact stopped
    // politely - which is precisely the behaviour this transport exists to remove.
    let parsed: { type?: string; request_id?: string; response?: { request_id?: string } } | undefined;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = undefined;
    }
    if (parsed?.type === "control_response") {
      const id = parsed.response?.request_id ?? parsed.request_id;
      const waiting = id ? this.controls.get(id) : undefined;
      if (id) this.controls.delete(id);
      waiting?.(parsed.response);
      // Still a sign of life, and nothing else will say so while the model is thinking.
      this.emit({ type: "heartbeat" });
      return;
    }
    if (parsed?.type === "control_request") {
      // A request the CLI made of US. We do not opt into the SDK's permission callbacks (this
      // app's approval gate is the MCP approval bridge), so nothing should arrive here - but an
      // unanswered control request blocks the CLI's turn forever with no diagnostic anywhere, so
      // it is answered with an error rather than left hanging. Same reasoning as the ACP
      // connection's -32601 default.
      const id = parsed.request_id;
      if (id) {
        this.write({
          type: "control_response",
          response: { subtype: "error", request_id: id, error: "Solace does not handle client control requests" },
        });
      }
      return;
    }

    const ended = handleClaudeStreamLine(line, this.state, (event) => this.emit(event));
    if (ended === "turn-ended") this.endTurn();
  }

  /** Route an event to the turn in flight, or - when there is none - to the session listener.
   * Never silently dropped: see OpenSessionOptions.onSessionEvent for why out-of-turn output is
   * a real thing a live process produces and why attributing it to the next turn would lie. */
  private emit(event: AdapterEvent): void {
    if (this.turn) this.turn.onEvent(event);
    else this.options.onSessionEvent?.(event);
  }

  private endTurn(): void {
    const turn = this.turn;
    if (!turn) return;
    this.turn = undefined;
    turn.onEvent({ type: "done" });
    turn.finish();
  }

  private died(reason: string | undefined): void {
    if (this.dead) return;
    this.dead = true;
    const turn = this.turn;
    this.turn = undefined;
    this.child = undefined;
    for (const resolve of this.controls.values()) resolve(undefined);
    this.controls.clear();
    if (turn) {
      // A turn was in flight when the process went away. That is a real failure of THIS turn and
      // is reported as one - the pool's fallback covers the next turn, not this one, because by
      // now the agent may already have posted half an answer and re-running it would duplicate
      // the work in the chat.
      if (reason) turn.onEvent({ type: "error", message: reason });
      turn.onEvent({ type: "done" });
      turn.finish();
    } else if (reason) {
      this.options.onSessionEvent?.({ type: "error", message: reason });
    }
  }

  private write(message: unknown): void {
    this.child?.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  async send(options: RunTurnOptions): Promise<void> {
    if (!this.alive()) throw new Error("the Claude Code session is not running");
    if (this.turn) throw new Error("a turn is already in flight on this session");

    // The session id the provider is actually in may have changed since it was opened (a resume
    // can fork). Report whatever we currently believe BEFORE the turn runs, so a crash mid-turn
    // still leaves the right id stored.
    options.onEvent({ type: "session", sessionId: this.state.sessionId });

    const finished = new Promise<void>((resolve) => {
      this.turn = { finish: resolve, onEvent: options.onEvent };
    });

    let aborted = false;
    const onAbort = () => {
      aborted = true;
      // An interrupt here is a PROTOCOL call, not a kill. This is the second thing the transport
      // buys: the agent stops, keeps its context, and is ready for the next message immediately -
      // where killCliTree would throw the conversation away and make the next turn pay a cold
      // start. If the CLI does not acknowledge, we fall back to the kill rather than pretend.
      void this.interrupt().then((acknowledged) => {
        if (!acknowledged && !this.dead) this.hardStop();
      });
    };
    options.signal?.addEventListener("abort", onAbort);

    // One line, one message. This is where the ~32KB Windows command-line ceiling stops
    // mattering at all: the prompt travels inside JSON on a pipe, which has no such limit, and
    // (unlike an argv element through a .cmd shim) a newline in it is just a newline.
    this.write({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: options.prompt }] },
      parent_tool_use_id: null,
      session_id: this.state.sessionId,
    });

    await finished;
    options.signal?.removeEventListener("abort", onAbort);
    if (aborted) options.onEvent({ type: "cancelled" });
  }

  async interrupt(): Promise<boolean> {
    if (!this.child || this.dead) return false;
    const requestId = randomUUID();
    const answered = new Promise<unknown>((resolve) => {
      this.controls.set(requestId, resolve);
      setTimeout(() => {
        if (this.controls.delete(requestId)) resolve(undefined);
      }, INTERRUPT_ACK_MS).unref?.();
    });
    this.write({ type: "control_request", request_id: requestId, request: { subtype: "interrupt" } });
    const response = (await answered) as { subtype?: string } | undefined;
    // Only a positive acknowledgement counts. Silence is reported as "we cannot say it landed",
    // never as success - the caller's fallback is a kill, and choosing it wrongly in the
    // optimistic direction would leave a turn running that the operator had stopped.
    return response?.subtype === "success";
  }

  /** Last resort, used when a graceful close or a protocol interrupt did not land. killCliTree
   * rather than child.kill(): the CLI spawns the solace MCP bridge (and, at trust level
   * "manual", the approval bridge) as its own children, and on Windows killing only the handle
   * we hold leaves those running - real writes continuing against a session that is over. */
  private hardStop(): void {
    const child = this.child;
    if (child) killCliTree(child);
  }

  async close(reason: SessionCloseReason): Promise<void> {
    if (this.dead || this.closing) return;
    this.closing = true;
    const child = this.child;
    if (!child) return;
    // The documented graceful shutdown: ending stdin tells the CLI to finish the current turn
    // and exit. A "server-shutdown" close cannot wait for that - the process hosting us is going
    // away and an unreaped child would outlive it, which is the leaked-process case - so it goes
    // straight to the tree kill.
    if (reason === "server-shutdown") {
      this.hardStop();
      this.died(undefined);
      return;
    }
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.stdin?.end();
    const timer = setTimeout(() => this.hardStop(), CLOSE_GRACE_MS);
    timer.unref?.();
    await exited;
    clearTimeout(timer);
    this.died(undefined);
  }
}

/**
 * The transport, and whether it is switched on.
 *
 * `enabled` is set from ONE thing only: whether the protocol has been driven against the real
 * `claude` binary and observed to (a) accept a second message on a live process, and (b)
 * acknowledge an interrupt. See PERSISTENT-SESSIONS.md for what was actually run and when. If
 * you are reading this because you changed the flag, the rule is the repo's: nothing is claimed
 * unless it was checked, and a transport that has not been driven ships off.
 */
export function createClaudeStreamJsonTransport(
  enabled: boolean,
  disabledReason?: string,
  spawnOverride?: (options: OpenSessionOptions, args: string[], env: NodeJS.ProcessEnv) => ChildProcess,
): PersistentTransport {
  return {
    enabled,
    disabledReason: enabled ? undefined : disabledReason,
    async open(options: OpenSessionOptions): Promise<PersistentSession> {
      const session = new ClaudeStreamJsonSession(
        options,
        spawnOverride ? (args, env) => spawnOverride(options, args, env) : undefined,
      );
      session.start();
      return session;
    },
  };
}

export { ClaudeStreamJsonSession };

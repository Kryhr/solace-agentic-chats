import type { ChildProcess } from "node:child_process";
import { killCliTree, spawnCli } from "../../core/spawnCli";
import type { JsonRpcError, JsonRpcId, JsonRpcMessage } from "./protocol";

/**
 * A reusable Agent Client Protocol (ACP) client over a child process's stdio.
 *
 * DELIBERATELY NOT KIMI-SPECIFIC. `kimi acp` is the first user, but `gemini --acp` and
 * `qwen --acp` speak the same protocol and are meant to move onto this file - so nothing here
 * knows a method name, a session shape, or which trust level maps to which mode. This owns
 * exactly five things and no policy: process lifetime, newline-delimited JSON-RPC framing,
 * request/response correlation, notification dispatch, and answering the requests the agent
 * makes of US.
 *
 * THE DIRECTION OF CALLS IS THE POINT. Every other CLI in this directory is a one-way pipe: we
 * hand it a prompt and read its stdout. ACP is bidirectional - the agent calls the client back
 * for tool-call permission and file access - which is what makes a real approval gate possible
 * for a provider whose headless flag has none. `onRequest` is that inbound half.
 */

export interface AcpConnectionOptions {
  /** Executable to spawn. Callers on Windows should pass `process.execPath` and a .mjs entry
   * rather than an npm .cmd shim - see core/spawnCli.ts for why a shim is hazardous. */
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** A `session/update`-style notification, or any other method the agent sends with no id. */
  onNotification?: (method: string, params: unknown) => void;
  /**
   * A request the AGENT made of us. Resolve with the result; throw to answer with an error.
   * Anything this connection has no handler for is answered -32601 rather than left hanging:
   * an unanswered request blocks the agent's turn forever with no diagnostic anywhere.
   */
  onRequest?: (method: string, params: unknown) => Promise<unknown>;
  /** Raw stderr text. ACP agents write real warnings here on successful runs, so a caller must
   * decide for itself whether any of it counts as failure. */
  onStderr?: (text: string) => void;
  /** Lines that arrived on stdout but were not JSON. A well-behaved ACP agent emits none; a
   * tool that writes a subprocess's output straight to the shared stdout produces them, and
   * dropping them silently loses real output. */
  onMalformedLine?: (line: string) => void;
}

/** Thrown for a JSON-RPC `error` response, carrying the machine-readable code so a caller can
 * branch on it (Kimi answers an unauthenticated or out-of-quota `session/new` with -32000)
 * instead of regex-matching the human-readable message. */
export class AcpRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(error: JsonRpcError) {
    super(error.message);
    this.name = "AcpRpcError";
    this.code = error.code;
    this.data = error.data;
  }
}

/** Thrown to every in-flight request when the child exits or fails to start. Distinct from
 * AcpRpcError because the agent never answered at all - there is no code to branch on, and a
 * caller that reported it as a protocol error would be blaming the wrong thing. */
export class AcpTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpTransportError";
  }
}

/**
 * The framing half, split out from the process half so it can be tested against recorded bytes
 * with no child process involved - which is the only way to test the cases that actually break
 * parsers: a JSON object split mid-token across two chunk boundaries, several objects arriving
 * in one chunk, and a 60KB line spread over many reads.
 *
 * Explicitly NOT `readline`. readline is fine for framing but hides exactly these cases behind
 * its own buffering, so a bug in our handling of them could not be written as a test.
 */
export class NdJsonFramer {
  private buffer = "";

  constructor(
    private readonly onMessage: (message: JsonRpcMessage) => void,
    private readonly onMalformedLine?: (line: string) => void,
  ) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      this.handleLine(line);
    }
  }

  /** Called when the stream ends: a final line with no trailing newline is still a message.
   * Without this, an agent that exits immediately after its last response would have that
   * response dropped and the request would time out instead of resolving. */
  flush(): void {
    const rest = this.buffer;
    this.buffer = "";
    if (rest.trim()) this.handleLine(rest);
  }

  private handleLine(raw: string): void {
    // \r is stripped because a Windows child that writes with "\r\n" line endings otherwise
    // leaves a trailing carriage return inside the JSON text.
    const line = raw.replace(/\r$/, "").trim();
    if (!line) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.onMalformedLine?.(line);
      return;
    }
    if (!message || typeof message !== "object") {
      this.onMalformedLine?.(line);
      return;
    }
    this.onMessage(message);
  }
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

export class AcpConnection {
  private readonly child: ChildProcess;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly framer: NdJsonFramer;
  private nextId = 1;
  private closed = false;
  /** Why the connection ended, if it ended. Kept so a request issued after the child died
   * fails with the real reason rather than a generic "closed". */
  private exitReason: string | undefined;

  constructor(private readonly options: AcpConnectionOptions) {
    this.child = spawnCli(options.command, options.args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env,
    });

    this.framer = new NdJsonFramer(
      (message) => this.dispatch(message),
      (line) => options.onMalformedLine?.(line),
    );

    this.child.stdout?.setEncoding("utf-8");
    this.child.stdout?.on("data", (chunk: string) => this.framer.push(chunk));
    this.child.stdout?.on("end", () => this.framer.flush());
    this.child.stderr?.setEncoding("utf-8");
    this.child.stderr?.on("data", (chunk: string) => options.onStderr?.(chunk));

    // A write to a stdin whose peer is gone throws EPIPE asynchronously and would take the
    // server process down. The failure is already reported through the pending requests.
    this.child.stdin?.on("error", () => {});

    this.child.on("error", (err) => this.fail(`failed to start ACP agent: ${err.message}`));
    this.child.on("close", (code, signal) => {
      this.framer.flush();
      this.fail(
        signal
          ? `ACP agent was terminated by ${signal} before the request completed.`
          : `ACP agent exited with code ${code} before the request completed.`,
      );
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Send a request and wait for its response. Rejects with AcpRpcError for a protocol error
   * and AcpTransportError if the child dies first - never hangs on a dead process. */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new AcpTransportError(this.exitReason ?? "ACP connection is closed."));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        this.pending.delete(id);
        reject(new AcpTransportError(`failed to send ${method}: ${(err as Error).message}`));
      }
    });
  }

  /** Fire-and-forget. `session/cancel` is a notification in ACP, so a cancel must NOT wait for
   * a response that is never coming. */
  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    try {
      this.write({ jsonrpc: "2.0", method, params });
    } catch {
      // A failed notification on a dying process is not worth surfacing: whatever killed the
      // process is already being reported through the in-flight request.
    }
  }

  /**
   * Kill the agent and everything it spawned.
   *
   * killCliTree rather than child.kill(): an ACP agent spawns its own MCP server children (the
   * solace bridge among them) and background shell tasks, and on Windows killing only the
   * handle we hold leaves those running - real writes continuing against a turn that is over.
   */
  close(): void {
    if (this.closed) {
      killCliTree(this.child);
      return;
    }
    this.exitReason = "ACP connection was closed by the client.";
    killCliTree(this.child);
    this.child.stdin?.end();
  }

  private write(message: JsonRpcMessage): void {
    // One object, one line. The prompt travels inside this JSON, which is the whole reason ACP
    // escapes the ~32KB Windows command-line ceiling that argv-based headless modes hit: a pipe
    // write has no such limit. Verified live against `kimi acp` with a 60,000-character prompt.
    this.child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  private dispatch(message: JsonRpcMessage): void {
    // Order matters. An incoming REQUEST carries both `id` and `method`; a response carries
    // `id` and no `method`. Testing for `id` first would route every inbound permission request
    // into the response table, where it would match no pending entry and be dropped - and the
    // agent would wait on an answer that never comes.
    if (typeof message.method === "string") {
      if (message.id !== undefined) this.handleIncomingRequest(message.id, message.method, message.params);
      else this.options.onNotification?.(message.method, message.params);
      return;
    }
    if (message.id === undefined) return;
    const entry = this.pending.get(message.id);
    // An unknown id is ignored rather than thrown on: it means a response to a request we
    // already abandoned, and taking the process down for it would be worse than dropping it.
    if (!entry) return;
    this.pending.delete(message.id);
    if (message.error) entry.reject(new AcpRpcError(message.error));
    else entry.resolve(message.result);
  }

  private handleIncomingRequest(id: JsonRpcId, method: string, params: unknown): void {
    const handler = this.options.onRequest;
    if (!handler) {
      this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
      return;
    }
    // Always answered, on both paths. An ACP agent blocks its turn on these; a handler that
    // throws must still produce an error response or the turn deadlocks with no diagnostic.
    handler(method, params).then(
      (result) => {
        if (!this.closed) this.write({ jsonrpc: "2.0", id, result: result ?? {} });
      },
      (err: unknown) => {
        if (this.closed) return;
        const message = err instanceof Error ? err.message : String(err);
        this.write({ jsonrpc: "2.0", id, error: { code: -32603, message } });
      },
    );
  }

  /** Terminal: every in-flight request is rejected and no further request is accepted. */
  private fail(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.exitReason = reason;
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) entry.reject(new AcpTransportError(reason));
  }
}

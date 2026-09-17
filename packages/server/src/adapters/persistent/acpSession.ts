import { join } from "node:path";
import type { ProviderId } from "@solace/shared";
import { SERVER_PORT } from "../../core/serverPort";
import { mcpServersForAgent } from "../../core/mcpServers";
import { AcpConnection, AcpRpcError, AcpTransportError } from "../acp/connection";
import {
  ACP_AGENT_METHOD,
  ACP_CLIENT_METHOD,
  acpContentText,
  type AcpInitializeResult,
  type AcpNewSessionResult,
  type AcpPromptResult,
  type AcpRequestPermissionParams,
  type AcpRequestPermissionResult,
  type AcpSessionConfigOption,
  type AcpStdioMcpServer,
  type AcpSessionNotification,
  type AcpSessionUpdate,
} from "../acp/protocol";
import type { AdapterEvent, RunTurnOptions } from "../types";
import type { OpenSessionOptions, PersistentSession, PersistentTransport, SessionCloseReason } from "./types";

/**
 * ONE persistent-session implementation for every ACP provider.
 *
 * The transport underneath (adapters/acp/) was built for Kimi and was written provider-agnostic
 * on purpose - it knows framing, correlation and process lifetime, and no method names or
 * session semantics. This file is the layer above it: it speaks ACP's session methods, and it
 * still knows nothing about WHICH agent is on the other end. Kimi, Gemini and Qwen differ here
 * in exactly one value each - the argv that starts them - which is why they are a table at the
 * bottom of this file rather than three files.
 *
 * WHAT IS VERIFIED AND WHAT IS NOT, because this repo does not claim what it has not checked:
 *
 *   OpenCode - DRIVEN END TO END on 2026-09-17 against `opencode acp` 1.18.31 with the free model
 *            `opencode/mimo-v2.5-free`: one process (pid 24208) and one session id across four
 *            prompts; the SECOND prompt answered out of the FIRST prompt's context without any
 *            resume; agent_thought_chunk and agent_message_chunk read back as reasoning and text;
 *            `session/cancel` accepted mid-turn, the turn ending "cancelled", the process
 *            surviving and the next prompt answering normally on it; and the solace MCP bridge
 *            connected over the same session, with the agent listing solace_post_to_group and the
 *            coordination tools among its own tools. This is why the code above is known to WORK
 *            rather than merely to typecheck - and it is still switched off, for a reason that
 *            has nothing to do with the transport: see its entry in the table.
 *   Kimi   - `kimi acp` handshake, session/new, the stdio MCP bridge and two session/prompt
 *            calls against ONE live process were observed on 2026-09-16 and are recorded in
 *            acp/fixtures/kimi-acp-session.jsonl. The account is out of quota, so the model
 *            never ran: every prompt in that capture came back -32000 or from a slash command.
 *            A prompt that actually reaches the model has NOT been observed.
 *   Gemini - `gemini --acp` initialize captured verbatim (protocolVersion 1, loadSession,
 *            mcpCapabilities http+sse). session/new is REJECTED: -32000 "Gemini API key is
 *            missing or not configured." Not signed in on this machine.
 *   Qwen   - `qwen --acp` initialize captured verbatim (protocolVersion 1, loadSession,
 *            sessionCapabilities list+resume). session/new is REJECTED: -32000 "Authentication
 *            required: Use Qwen Code CLI to authenticate first."
 *
 * The handshake is a FACT for all four and identical across all four - and for OpenCode so is
 * everything after it. For the other three a working prompt stream is an INFERENCE: the same code
 * that was watched working against OpenCode, pointed at an agent nobody could sign in to.
 *
 * So EVERY entry ships `enabled: false`, for two different kinds of reason, and the difference is
 * written out on each: three of them because nobody can sign in, and OpenCode because its ACP
 * surface cannot carry a trust level. None of them because the code is unfinished.
 */

/** Protocol version 1 - the version BOTH captured agents answered with, and the version in the
 * SDK Kimi bundles. Not a guess and not a range: a client that offers a version it has not seen
 * an agent accept is inventing compatibility. */
export const ACP_PROTOCOL_VERSION = 1;

/** The group-chat bridge, resolved the same way every adapter resolves it: from the package root,
 * to the SOURCE copy, which is plain JS with no compile step and so works identically under tsx
 * and in a production build. */
const SOLACE_BRIDGE_SCRIPT = join(__dirname, "..", "..", "..", "src", "mcp", "solaceBridge.mjs");

export interface AcpProviderSpec {
  provider: ProviderId;
  /** The binary and the argv that puts it in ACP mode. Read from each CLI's own --help on this
   * machine: `opencode acp`, `kimi acp`, `gemini --acp`, `qwen --acp`. */
  command: string;
  args: string[];
  /**
   * Has this provider's ACP path been driven end to end - a prompt reaching a real model, a real
   * session/update stream read back, a cancel landing - against the real CLI on a real account?
   *
   * This is the ONLY thing that decides whether the transport is switched on, and it is a fact
   * about what someone watched happen, not about how complete the code looks. The code is
   * identical for all four entries; the accounts are not.
   */
  verified?: boolean;
  /** Why this provider's live transport is switched off. REQUIRED whenever `verified` is not
   * true: "off" without a reason is an absence, and an absence is not information. */
  disabledReason?: string;
}

export const ACP_PROVIDERS: AcpProviderSpec[] = [
  {
    /*
     * The one that was fully DRIVEN, and is still OFF - which is the most useful entry in this
     * table, because it separates two things that are easy to confuse.
     *
     * `opencode acp` is the only ACP agent on this machine with a working account and genuinely
     * free models, so it is where the whole path could be proven at no cost, and it was: one
     * process across four prompts, context carried between them, a cancel landing mid-turn, the
     * solace MCP bridge connected and its tools listed by the agent itself. The TRANSPORT is not
     * in doubt.
     *
     * It is off because of what else was observed: asked to write a file, `opencode acp` wrote it
     * and never sent `session/request_permission` at all, and its `session/new` advertises no
     * `modes` and exactly one config option (`model`). So its ACP surface has NO WAY TO EXPRESS A
     * TRUST LEVEL. Switching this on would silently promote every OpenCode agent - including ones
     * the operator set to "plan" or "manual" - to unrestricted writes, while the UI went on
     * showing the trust level they chose. A faster transport is not worth a permission mode that
     * quietly stops meaning anything.
     */
    provider: "opencode",
    command: "opencode",
    args: ["acp"],
    disabledReason:
      "the protocol is verified end to end against opencode acp 1.18.31 (one process across four " +
      "prompts, context carried between turns, session/cancel landing mid-turn, the solace MCP " +
      "bridge connected) - but its ACP session exposes no modes and no permission option, and it " +
      "wrote a file without ever asking, so trust level cannot be expressed over this path. " +
      "Enable once a trust level can be carried, not before.",
  },
  {
    provider: "kimi",
    command: "kimi",
    args: ["acp"],
    disabledReason:
      "kimi acp's handshake, session/new and two prompts on one live process were observed, but the " +
      "account is out of quota so a prompt has never reached the model and no session/update stream " +
      "from a real turn has been seen. Enable once a turn has been driven end to end.",
  },
  {
    provider: "gemini-cli",
    command: "gemini",
    args: ["--acp"],
    disabledReason:
      "gemini --acp answers initialize (captured verbatim) but rejects session/new with -32000 " +
      '"Gemini API key is missing or not configured" - this machine is not signed in. Nothing past ' +
      "the handshake has been driven.",
  },
  {
    provider: "qwen-code",
    command: "qwen",
    args: ["--acp"],
    disabledReason:
      "qwen --acp answers initialize (captured verbatim) but rejects session/new with -32000 " +
      '"Authentication required: Use Qwen Code CLI to authenticate first" - this machine is not ' +
      "signed in. Nothing past the handshake has been driven.",
  },
];

/**
 * How a tool-call permission request is answered.
 *
 * ACP is bidirectional: the agent asks US before it acts, which is the whole reason a real
 * approval gate is possible for a provider whose headless flag has none. Wiring that to this
 * app's approval registry belongs with the adapter, not the transport, so it is injected. The
 * DEFAULT refuses, because an unwired gate that allowed everything would be a permission system
 * that silently did nothing - fail closed, as everywhere else here.
 */
export type AcpPermissionDecider = (
  params: AcpRequestPermissionParams,
  options: OpenSessionOptions,
) => Promise<AcpRequestPermissionResult>;

export const refuseByDefault: AcpPermissionDecider = async (params) => {
  const reject =
    params.options.find((o) => o.kind === "reject_once") ?? params.options.find((o) => o.kind === "reject_always");
  return reject ? { outcome: { outcome: "selected", optionId: reject.optionId } } : { outcome: { outcome: "cancelled" } };
};

interface PendingTurn {
  onEvent: (event: AdapterEvent) => void;
}

class AcpPersistentSession implements PersistentSession {
  readonly provider: ProviderId;
  readonly sessionToken: string | undefined;

  private connection: AcpConnection | undefined;
  private acpSessionId: string | undefined;
  private turn: PendingTurn | undefined;
  private dead = false;
  private closed = false;
  private capabilities: AcpInitializeResult["agentCapabilities"];
  /** Set when WE asked for a cancel, so the "cancelled" stop reason can be told apart from a
   * refusal the model decided on by itself. */
  private cancelRequested = false;
  /** The model this session was actually switched to, if the agent offered it. Reported on the
   * first turn so the UI names the model that is really answering, not the one that was asked
   * for - those are different facts and only one of them is observable. */
  private modelApplied: string | undefined;

  constructor(
    private readonly spec: AcpProviderSpec,
    private readonly options: OpenSessionOptions,
    private readonly decidePermission: AcpPermissionDecider,
    /** Injected so tests drive a scripted agent over real pipes. Defaults to the real CLI. */
    private readonly connect: (handlers: {
      onNotification: (method: string, params: unknown) => void;
      onRequest: (method: string, params: unknown) => Promise<unknown>;
    }) => AcpConnection = (handlers) =>
      new AcpConnection({
        command: spec.command,
        args: spec.args,
        cwd: options.cwd,
        env: { ...process.env, SOLACE_AGENT_ID: options.agentId, ...(options.sessionToken ? { SOLACE_TURN_TOKEN: options.sessionToken } : {}) },
        onNotification: handlers.onNotification,
        onRequest: handlers.onRequest,
      }),
  ) {
    this.provider = spec.provider;
    this.sessionToken = options.sessionToken;
  }

  get pid(): number | undefined {
    return this.connection?.pid;
  }

  get providerSessionId(): string | undefined {
    return this.acpSessionId;
  }

  alive(): boolean {
    return !this.dead && !this.closed && this.connection !== undefined;
  }

  busy(): boolean {
    return this.turn !== undefined;
  }

  /**
   * initialize, then either resume an existing conversation or start one.
   *
   * `session/resume` is attempted ONLY when the agent said it can. Both captured agents report
   * `loadSession: true` and Qwen additionally reports `sessionCapabilities.resume` - but an agent
   * that says neither is asked for a new session instead of being sent a method it would answer
   * -32601 to, which would strand the turn behind an error about the wrong thing entirely.
   */
  async start(): Promise<void> {
    const connection = this.connect({
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (method, params) => this.onRequest(method, params),
    });
    this.connection = connection;
    try {
      await this.handshake(connection);
    } catch (err) {
      // A failed handshake must not leave the process behind. This is the commonest real failure
      // on this machine - Gemini and Qwen both answer `initialize` happily and then refuse
      // `session/new` because nobody is signed in - so "open failed" has to mean the CLI is gone,
      // not that a rejected promise quietly left one running for the rest of the day.
      connection.close();
      this.connection = undefined;
      this.dead = true;
      throw err;
    }
  }

  private async handshake(connection: AcpConnection): Promise<void> {
    const init = await connection.request<AcpInitializeResult>(ACP_AGENT_METHOD.initialize, {
      protocolVersion: ACP_PROTOCOL_VERSION,
      // Declared false because this app does not serve the agent's file reads and writes - the
      // CLI uses its own tools. Declaring a capability we do not implement would have the agent
      // call us and hang on an answer that never comes.
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "solace", version: "1.0.0" },
    });
    this.capabilities = init.agentCapabilities;

    const canResume = init.agentCapabilities?.loadSession === true || init.agentCapabilities?.sessionCapabilities?.resume !== undefined;
    if (this.options.sessionId && canResume) {
      try {
        await connection.request(ACP_AGENT_METHOD.sessionResume, {
          sessionId: this.options.sessionId,
          cwd: this.options.cwd,
          mcpServers: this.mcpServers(),
        });
        this.acpSessionId = this.options.sessionId;
        return;
      } catch (err) {
        // A stored id the agent no longer knows (its own store was cleared, or it belongs to a
        // different account) must not take the turn down - it means "start cold", and saying so
        // by starting a new session is the honest reading.
        if (!(err instanceof AcpRpcError)) throw err;
      }
    }
    const created = await connection.request<AcpNewSessionResult>(ACP_AGENT_METHOD.sessionNew, {
      cwd: this.options.cwd,
      mcpServers: this.mcpServers(),
    });
    this.acpSessionId = created.sessionId;
    await this.applyModel(connection, created.configOptions ?? undefined);
  }

  /**
   * Ask for the configured model the way ACP actually offers it: a `session/set_config_option`
   * against the `model` select the agent itself advertised.
   *
   * There is no `--model` flag to pass an ACP agent - it is a session setting, not a process
   * flag, which is exactly why `session/new` returns `configOptions`. Both agents that have been
   * observed do this identically: Kimi 0.43.1 advertises `{id:"model",type:"select",options:[...]}`
   * and so does `opencode acp` 1.18.31.
   *
   * THE VALUE IS CHECKED AGAINST THE AGENT'S OWN LIST and silently skipped when it is not there,
   * never sent blind. A model id this agent does not offer is not a model it can be switched to,
   * and the alternative - sending it anyway - would either error the whole session or, worse,
   * be accepted and ignored, leaving the agent answering on a model the UI says it is not using.
   * The configured model staying unapplied is visible in what the agent reports; a silently
   * wrong one is not.
   */
  private async applyModel(connection: AcpConnection, configOptions: AcpSessionConfigOption[] | undefined): Promise<void> {
    const wanted = this.options.model;
    if (!wanted || !configOptions) return;
    const option = configOptions.find((o) => o.id === "model");
    if (!option || option.currentValue === wanted) return;
    if (!option.options?.some((choice) => choice.value === wanted)) return;
    try {
      await connection.request(ACP_AGENT_METHOD.sessionSetConfigOption, {
        sessionId: this.acpSessionId,
        optionId: "model",
        value: wanted,
      });
      this.modelApplied = wanted;
    } catch {
      // A refused config change is not a reason to fail the session: the agent still works, on
      // the model it was already on, and that is what it will report.
    }
  }

  /**
   * The MCP servers this session's agent gets: the solace group-chat bridge, plus whatever the
   * user registered.
   *
   * WITHOUT THIS, MOVING A PROVIDER ONTO THE LIVE TRANSPORT WOULD BE A TRADE, NOT A WIN. The
   * spawn-per-turn adapters all hand their CLI the solace bridge, which is what gives an agent
   * `post_to_group` and the coordination tools - the ability to say something mid-turn. Opening
   * an ACP session with `mcpServers: []` would buy zero-latency delivery INTO an agent at the
   * cost of the agent's only channel OUT of a turn, which is not an improvement.
   *
   * The stdio variant carries NO `type` discriminator, deliberately: in the ACP SDK's `zMcpServer`
   * union the stdio member is the bare untagged object, and an agent that branches on `"type" in
   * server` DROPS a server tagged `type:"stdio"` with nothing but a log warning. `env` is an
   * ARRAY of {name,value}, not a Record, for the same class of reason - a plain object serialises
   * fine and the server simply starts with none of the variables set. Both were established
   * against the real SDK; see the notes on AcpStdioMcpServer.
   *
   * The token here is the SESSION's, not a turn's: an ACP agent starts its MCP servers when the
   * session is created and there is no later opportunity to hand them a new one. See
   * OpenSessionOptions.sessionToken for exactly what that does and does not change.
   */
  private mcpServers(): AcpStdioMcpServer[] {
    const env = [
      { name: "SOLACE_AGENT_ID", value: this.options.agentId },
      { name: "SOLACE_SERVER_PORT", value: String(SERVER_PORT) },
      ...(this.options.sessionToken ? [{ name: "SOLACE_TURN_TOKEN", value: this.options.sessionToken }] : []),
    ];
    const servers: AcpStdioMcpServer[] = [
      // process.execPath, not "node": the server's own interpreter is guaranteed to exist and to
      // be the right version, where a bare "node" depends on the agent's PATH.
      { name: "solace", command: process.execPath, args: [SOLACE_BRIDGE_SCRIPT], env },
    ];
    for (const server of mcpServersForAgent(this.options.agentId)) {
      // "solace" is reserved. validateMcpServer already refuses the name at the write boundary,
      // which is where a collision should be explained to a human rather than silently resolved.
      if (server.name === "solace") continue;
      servers.push({
        name: server.name,
        command: server.command,
        args: server.args,
        env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value: String(value) })),
      });
    }
    return servers;
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== ACP_CLIENT_METHOD.sessionUpdate) return;
    const notification = params as AcpSessionNotification | undefined;
    const update = notification?.update as AcpSessionUpdate | undefined;
    if (!update) return;
    // A notification for a session that is not ours is not ours to report. One process can hold
    // several sessions in ACP, and attributing another one's output to this agent would put
    // words in its mouth.
    if (notification?.sessionId && this.acpSessionId && notification.sessionId !== this.acpSessionId) return;
    this.emit(this.translate(update));
  }

  /** One session/update -> the AdapterEvents this app understands. Anything unrecognised becomes
   * a heartbeat rather than nothing: the stuck-turn watchdog only hears about events, so a frame
   * dropped silently is the transport telling it a healthy process is dead. */
  private translate(update: AcpSessionUpdate): AdapterEvent[] {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = acpContentText((update as { content?: unknown }).content);
        return text ? [{ type: "text", text }] : [{ type: "heartbeat" }];
      }
      case "agent_thought_chunk": {
        const text = acpContentText((update as { content?: unknown }).content);
        return text ? [{ type: "reasoning", text }] : [{ type: "heartbeat" }];
      }
      case "tool_call": {
        const call = update as { toolCallId?: string; title?: string; name?: string; rawInput?: unknown };
        const name = call.name ?? call.title ?? "tool";
        return [
          {
            type: "tool-use",
            description: `${name}(${JSON.stringify(call.rawInput ?? {})})`,
            toolName: name,
            input: call.rawInput,
          },
        ];
      }
      // usage_update carries CONTEXT OCCUPANCY (used/size of the context window), NOT this
      // turn's token spend - see the note on the type. Reporting it as TurnUsage would put a
      // number in the usage column that is not the thing that column means, which is exactly
      // the sort of invented figure this repo refuses. It is a liveness signal and nothing more.
      default:
        return [{ type: "heartbeat" }];
    }
  }

  private async onRequest(method: string, params: unknown): Promise<unknown> {
    if (method === ACP_CLIENT_METHOD.sessionRequestPermission) {
      return this.decidePermission(params as AcpRequestPermissionParams, this.options);
    }
    // fs/read_text_file and fs/write_text_file are declared unsupported in initialize, so a
    // well-behaved agent never sends them. AcpConnection answers anything we throw on with a
    // JSON-RPC error, which is what an agent needs in order to carry on rather than block.
    throw new Error(`Solace does not implement ${method}`);
  }

  private emit(events: AdapterEvent[]): void {
    for (const event of events) {
      if (this.turn) this.turn.onEvent(event);
      else this.options.onSessionEvent?.(event);
    }
  }

  async send(options: RunTurnOptions): Promise<void> {
    if (!this.alive() || !this.connection || !this.acpSessionId) throw new Error(`the ${this.spec.provider} session is not running`);
    if (this.turn) throw new Error("a turn is already in flight on this session");
    this.turn = { onEvent: options.onEvent };
    this.cancelRequested = false;
    options.onEvent({ type: "session", sessionId: this.acpSessionId });
    if (this.modelApplied) options.onEvent({ type: "model", model: this.modelApplied });

    const onAbort = () => void this.interrupt();
    options.signal?.addEventListener("abort", onAbort);
    try {
      // The prompt travels inside this JSON-RPC request. That is what escapes the ~32KB Windows
      // command-line ceiling that every argv-based headless mode hits - a pipe write has no such
      // limit - and it is why an ACP agent can be handed a full group-chat context block.
      const result = await this.connection.request<AcpPromptResult>(ACP_AGENT_METHOD.sessionPrompt, {
        sessionId: this.acpSessionId,
        prompt: [{ type: "text", text: options.prompt }],
      });
      if (result?.stopReason === "cancelled" || this.cancelRequested) options.onEvent({ type: "cancelled" });
    } catch (err) {
      if (err instanceof AcpTransportError) {
        this.dead = true;
        options.onEvent({ type: "error", message: err.message });
      } else if (err instanceof AcpRpcError) {
        // The agent's own words, with its machine-readable code kept out of the chat: -32000 is
        // how all three of these CLIs report "not signed in" and "out of quota", and the message
        // is the only part a human can act on.
        options.onEvent({ type: "error", message: err.message });
      } else {
        options.onEvent({ type: "error", message: (err as Error).message });
      }
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      this.turn = undefined;
      options.onEvent({ type: "done" });
    }
  }

  /**
   * ACP's `session/cancel` is a NOTIFICATION - there is no response to wait for. The real
   * acknowledgement is the in-flight `session/prompt` coming back with stopReason "cancelled",
   * which is what send() above watches for.
   *
   * So this returns true only when there was actually a turn to cancel and a live connection to
   * tell. It is deliberately NOT a claim that the agent has stopped yet; the caller's fallback
   * (aborting the turn the old way) still exists, and send() reports what really happened.
   */
  async interrupt(): Promise<boolean> {
    if (!this.connection || !this.alive() || !this.turn) return false;
    this.cancelRequested = true;
    this.connection.notify(ACP_AGENT_METHOD.sessionCancel, { sessionId: this.acpSessionId });
    return true;
  }

  async close(reason: SessionCloseReason): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const connection = this.connection;
    if (!connection) return;
    // Tell the agent the session is over when it says it can be told. Kimi advertises
    // sessionCapabilities.close; neither Gemini nor Qwen did in their captures, so they are not
    // sent a method they never claimed. Either way the process is then killed as a tree.
    const canClose = this.capabilities?.sessionCapabilities?.close !== undefined;
    if (canClose && this.acpSessionId && reason !== "server-shutdown") {
      try {
        await connection.request(ACP_AGENT_METHOD.sessionClose, { sessionId: this.acpSessionId });
      } catch {
        // A refused or unanswered close changes nothing: the kill below is the thing that
        // actually guarantees no process is left behind.
      }
    }
    connection.close();
    this.connection = undefined;
    this.dead = true;
  }
}

/**
 * One provider's ACP transport.
 *
 * Every entry in ACP_PROVIDERS is constructed with `enabled: false` and its own reason, so this
 * whole path is unreachable from a real turn today. It is here, built and tested, so that
 * switching one on is a one-line change made by whoever has actually driven it - not a rewrite
 * done under pressure by whoever needs it first.
 */
export function createAcpTransport(
  spec: AcpProviderSpec,
  enabled = spec.verified === true,
  decidePermission: AcpPermissionDecider = refuseByDefault,
  connectOverride?: (
    spec: AcpProviderSpec,
    options: OpenSessionOptions,
    handlers: { onNotification: (m: string, p: unknown) => void; onRequest: (m: string, p: unknown) => Promise<unknown> },
  ) => AcpConnection,
): PersistentTransport {
  return {
    enabled,
    disabledReason: enabled ? undefined : spec.disabledReason,
    async open(options: OpenSessionOptions): Promise<PersistentSession> {
      const session = new AcpPersistentSession(
        spec,
        options,
        decidePermission,
        connectOverride ? (handlers) => connectOverride(spec, options, handlers) : undefined,
      );
      await session.start();
      return session;
    },
  };
}

export { AcpPersistentSession };

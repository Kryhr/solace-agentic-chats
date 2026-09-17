/**
 * Agent Client Protocol (ACP) wire types.
 *
 * PROVENANCE, because the standing rule here is that nothing is claimed unless it was checked:
 * every shape in this file was read out of the `@agentclientprotocol/sdk@1.3.0` zod schema that
 * `@moonshot-ai/kimi-code@0.43.1` bundles (its `dist/main.mjs`, the `AGENT_METHODS` /
 * `CLIENT_METHODS` tables and the `z*` schema definitions beside them), and the ones marked
 * "observed" below were additionally seen on the wire against a live `kimi acp` process on
 * 2026-09-16. Nothing here came from prose documentation.
 *
 * Two places where the published prose on agentclientprotocol.com is WRONG for this SDK version,
 * both of which would have produced a parser that silently matched nothing:
 *
 *   - The `session/update` variant discriminator is `sessionUpdate`, NOT `type`.
 *   - `RequestPermissionResponse.outcome` is an OBJECT - `{outcome:"selected",optionId}` or
 *     `{outcome:"cancelled"}` - not the bare string `"approved"`/`"denied"`.
 *
 * Deliberately NOT exhaustive. Only the methods and variants this app actually sends, receives
 * or dispatches on are typed; the NES (next-edit-suggestion), elicitation, provider and document
 * families exist in the SDK and are left out because nothing here uses them, and typing an
 * unused shape is a claim about it that no test would ever check.
 */

/* -------------------------------------------------------------------------- */
/* JSON-RPC envelope                                                           */
/* -------------------------------------------------------------------------- */

export type JsonRpcId = number | string;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** One parsed line off the agent's stdout. Which of the three it is has to be decided by shape,
 * not by a tag: a response carries `id` and one of result/error, an incoming REQUEST carries
 * both `id` and `method`, and a notification carries `method` with no `id`. */
export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}

/* -------------------------------------------------------------------------- */
/* Content blocks                                                              */
/* -------------------------------------------------------------------------- */

/** The subset of ContentBlock this app produces and reads. The SDK also defines image, audio,
 * resource_link and embedded resource variants; only `text` is narrowed here because that is
 * the only one whose payload anything downstream inspects. */
export interface AcpTextContent {
  type: "text";
  text: string;
}

export type AcpContentBlock = AcpTextContent | { type: string; [key: string]: unknown };

export function acpContentText(block: unknown): string | undefined {
  if (!block || typeof block !== "object") return undefined;
  const b = block as { type?: unknown; text?: unknown };
  return b.type === "text" && typeof b.text === "string" ? b.text : undefined;
}

/* -------------------------------------------------------------------------- */
/* initialize                                                                  */
/* -------------------------------------------------------------------------- */

export interface AcpClientCapabilities {
  fs: { readTextFile: boolean; writeTextFile: boolean };
  terminal: boolean;
  auth?: { terminal: boolean };
}

export interface AcpInitializeParams {
  protocolVersion: number;
  clientCapabilities: AcpClientCapabilities;
  clientInfo?: { name: string; version: string };
}

/** Observed verbatim from `kimi acp` 0.43.1 on 2026-09-16 - see acp/fixtures/. */
export interface AcpInitializeResult {
  protocolVersion: number;
  agentInfo?: { name?: string; version?: string };
  agentCapabilities?: {
    loadSession?: boolean;
    promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
    mcpCapabilities?: { http?: boolean; sse?: boolean; acp?: boolean };
    sessionCapabilities?: Record<string, unknown>;
    auth?: Record<string, unknown>;
  };
  authMethods?: { id: string; name?: string; description?: string }[];
}

/* -------------------------------------------------------------------------- */
/* MCP servers                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * `env` is an ARRAY of {name,value} pairs, not a Record. That is the SDK's `zEnvVariable`, and
 * getting it wrong is silent: a plain object passes JSON serialisation and the agent simply
 * starts the server with none of the variables set.
 *
 * The stdio variant carries NO `type` discriminator. That is not an omission - in the SDK's
 * `zMcpServer` union the stdio member is the bare untagged object, and Kimi's own
 * `acpMcpServersToConfigRecord` branches on `!("type" in server)` to recognise it. Sending
 * `type:"stdio"` makes Kimi fall into its tagged branch, match neither http/sse nor acp, and
 * DROP the server with only a log warning. See the note in kimi.ts.
 */
export interface AcpStdioMcpServer {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
}

export interface AcpHttpMcpServer {
  type: "http" | "sse";
  name: string;
  url: string;
  headers: { name: string; value: string }[];
}

export type AcpMcpServer = AcpStdioMcpServer | AcpHttpMcpServer;

/* -------------------------------------------------------------------------- */
/* Sessions                                                                    */
/* -------------------------------------------------------------------------- */

export interface AcpSessionConfigOption {
  type?: string;
  id: string;
  name?: string;
  category?: string;
  currentValue?: string;
  options?: { value: string; name?: string; description?: string }[];
}

export interface AcpNewSessionParams {
  cwd: string;
  mcpServers: AcpMcpServer[];
  additionalDirectories?: string[];
}

export interface AcpNewSessionResult {
  sessionId: string;
  configOptions?: AcpSessionConfigOption[] | null;
  modes?: { currentModeId: string; availableModes: { id: string; name?: string }[] } | null;
}

export interface AcpResumeSessionParams {
  sessionId: string;
  cwd: string;
  mcpServers?: AcpMcpServer[];
  additionalDirectories?: string[];
}

export interface AcpPromptParams {
  sessionId: string;
  prompt: AcpContentBlock[];
}

/**
 * The FIVE real stop reasons, from `zStopReason`. Note that none of them is "completed",
 * "maxStepsReached" or "timeout" - those appear in the published prose and do not exist in this
 * SDK. A parser branching on them would treat every successful turn as unrecognised.
 */
export type AcpStopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

/** `usage` is defined on the response by the SDK but Kimi 0.43.1 never populates it - its
 * prompt driver resolves with `{stopReason}` alone. Typed as optional so a provider that DOES
 * fill it in can be read without a shape change, and read defensively at the call site. */
export interface AcpPromptResult {
  stopReason: AcpStopReason;
  usage?: {
    totalTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    thoughtTokens?: number;
    cachedReadTokens?: number;
    cachedWriteTokens?: number;
  } | null;
}

/* -------------------------------------------------------------------------- */
/* session/update notifications                                                */
/* -------------------------------------------------------------------------- */

export type AcpToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

export type AcpToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export interface AcpToolCall {
  toolCallId: string;
  title?: string;
  name?: string;
  kind?: AcpToolKind;
  status?: AcpToolCallStatus;
  content?: unknown[];
  locations?: { path: string; line?: number }[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

export type AcpSessionUpdate =
  | { sessionUpdate: "user_message_chunk"; content: AcpContentBlock }
  | { sessionUpdate: "agent_message_chunk"; content: AcpContentBlock }
  | { sessionUpdate: "agent_thought_chunk"; content: AcpContentBlock }
  | ({ sessionUpdate: "tool_call" } & AcpToolCall)
  | ({ sessionUpdate: "tool_call_update" } & AcpToolCall)
  | { sessionUpdate: "plan"; entries: { content: string; priority?: string; status?: string }[] }
  | { sessionUpdate: "available_commands_update"; availableCommands: unknown[] }
  | { sessionUpdate: "current_mode_update"; currentModeId: string }
  | { sessionUpdate: "config_option_update"; configOptions: AcpSessionConfigOption[] }
  | { sessionUpdate: "session_info_update"; title?: string | null; updatedAt?: string | null }
  /** `used`/`size` are CONTEXT OCCUPANCY, not turn tokens - see the usage note in kimi.ts. */
  | { sessionUpdate: "usage_update"; used: number; size: number; cost?: { amount: number; currency: string } | null }
  | { sessionUpdate: string; [key: string]: unknown };

export interface AcpSessionNotification {
  sessionId: string;
  update: AcpSessionUpdate;
}

/* -------------------------------------------------------------------------- */
/* session/request_permission                                                  */
/* -------------------------------------------------------------------------- */

export type AcpPermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: AcpPermissionOptionKind;
}

export interface AcpRequestPermissionParams {
  sessionId: string;
  toolCall: AcpToolCall;
  options: AcpPermissionOption[];
}

export type AcpRequestPermissionOutcome = { outcome: "cancelled" } | { outcome: "selected"; optionId: string };

export interface AcpRequestPermissionResult {
  outcome: AcpRequestPermissionOutcome;
}

/* -------------------------------------------------------------------------- */
/* Method names                                                                */
/* -------------------------------------------------------------------------- */

/** Verbatim from the SDK's own AGENT_METHODS / CLIENT_METHODS tables. Spelled out as constants
 * so a typo is a compile error rather than a request that silently returns -32601. */
export const ACP_AGENT_METHOD = {
  initialize: "initialize",
  authenticate: "authenticate",
  sessionNew: "session/new",
  sessionLoad: "session/load",
  sessionResume: "session/resume",
  sessionClose: "session/close",
  sessionPrompt: "session/prompt",
  sessionCancel: "session/cancel",
  sessionSetMode: "session/set_mode",
  sessionSetConfigOption: "session/set_config_option",
} as const;

export const ACP_CLIENT_METHOD = {
  sessionUpdate: "session/update",
  sessionRequestPermission: "session/request_permission",
  fsReadTextFile: "fs/read_text_file",
  fsWriteTextFile: "fs/write_text_file",
} as const;

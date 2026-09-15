// Shared types used by both the server and the web UI.
// Keep this package dependency-free so it can be imported from either side.

export type ProviderId = "claude-code" | "codex-cli" | "gemini-cli" | "qwen-code" | "custom";

/**
 * How much an agent is allowed to do without a human clicking "approve" first.
 * These are Claude Code's own real `--permission-mode` values (verified via `claude --help`:
 * choices are "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan" - we
 * expose all but "dontAsk", which nothing in this app currently uses). Codex CLI has no
 * single equivalent flag; adapters/codex-cli.ts maps these onto its own --sandbox /
 * --ask-for-approval / --approve-for-me / --dangerously-bypass-approvals-and-sandbox flags,
 * approximating where a 1:1 mapping doesn't exist (no native "plan" mode for Codex).
 */
export type TrustLevel = "plan" | "manual" | "acceptEdits" | "bypassPermissions" | "auto";

export type AgentRunState = "idle" | "thinking" | "waiting-approval" | "error" | "offline";

export interface AgentConfig {
  id: string;
  /** Display name shown in the UI and used for @mentions, e.g. "claude-1", "codex". */
  handle: string;
  provider: ProviderId;
  /** Absolute path to the project/worktree this agent operates in. */
  cwd: string;
  trustLevel: TrustLevel;
  /** Free-text description of what this agent currently owns, e.g. "compiler backend". */
  currentTask?: string;
  /** Model alias or full model id, passed straight through to the provider's own --model flag. Empty = provider default. */
  model?: string;
  /** Reasoning/thinking effort, passed straight through to the provider's own flag. Empty = provider default. */
  effort?: string;
  /** "cli" (default, absent) signs in via that provider's own CLI subscription login;
   * "api-key" calls the provider's HTTP API directly using a saved credential. */
  authMode?: "cli" | "api-key";
  /** Only meaningful when authMode is "api-key" - references a CredentialMeta.id, never the
   * raw key itself (that never leaves the server - see core/credentials.ts). */
  credentialId?: string;
}

/** What kind of secret a saved credential holds. An SSH deploy target has no legal
 * ProviderId and no single `key` field, so the two shapes can't share one flat record -
 * hence the discriminator. Records written before SSH credentials existed have no `kind`
 * at all; core/credentials.ts reads those as "api-key". */
export type CredentialKind = "api-key" | "ssh";

/** Everything about an SSH deploy target that is deliberately NOT secret: enough for an
 * agent to build its own `ssh`/`scp`/`rsync` command line, and nothing more. */
export interface SshTargetMeta {
  host: string;
  port: number;
  username: string;
  /** Path to a private key that already exists on this machine, with whatever permissions
   * the user already set on it. Copying key material into an app-owned plaintext JSON file
   * is strictly worse than pointing at the original, so this is the default and preferred
   * shape. Absent only when the user chose to paste key material instead. */
  privateKeyPath?: string;
  /** Optional known_hosts file to verify the server against, so an agent doesn't have to
   * reach for StrictHostKeyChecking=no. */
  knownHostsPath?: string;
  /** True when the user pasted private key material into Solace rather than referencing a
   * key file. This is a flag, never the material: the key itself stays server-side and is
   * not exposed through any route, prompt or chat message. */
  hasStoredKeyMaterial?: boolean;
}

interface CredentialMetaBase {
  id: string;
  /** A short label to tell saved credentials apart, e.g. "personal" - not the secret itself. */
  label: string;
  createdAt: string;
}

/** Metadata only - the raw API key is never sent to the client, before or after saving.
 * See core/credentials.ts for where the actual key lives (a local file outside the repo). */
export interface ApiKeyCredentialMeta extends CredentialMetaBase {
  kind: "api-key";
  provider: ProviderId;
  /** Only meaningful when provider === "custom": the OpenAI-compatible API root this key
   * belongs to, e.g. "https://api.deepseek.com/v1". Chat completions are POSTed to
   * `${baseUrl}/chat/completions` - see adapters/custom-api.ts. */
  baseUrl?: string;
  /** Only meaningful when provider === "custom": which service this actually is, e.g.
   * "DeepSeek" or "Groq". Without it every custom connection reads as just "custom" in the
   * UI, and several of them would be indistinguishable from each other. */
  connectionName?: string;
}

/** Metadata only - a stored passphrase or pasted private key is never part of this shape,
 * so it cannot reach a client, a prompt or a chat message by accident. */
export interface SshCredentialMeta extends CredentialMetaBase {
  kind: "ssh";
  ssh: SshTargetMeta;
}

export type CredentialMeta = ApiKeyCredentialMeta | SshCredentialMeta;

/**
 * Real per-turn usage as reported by the provider's own CLI output (Claude Code's final
 * "result" message, Codex's "turn.completed" event) - never estimated or fabricated. Absent
 * fields just mean that provider didn't report them.
 */
export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
}

export interface AgentStatus {
  agentId: string;
  state: AgentRunState;
  currentTask?: string;
  lastActivityAt: string;
  /** Usage from the most recently completed turn. */
  lastUsage?: TurnUsage;
  /** Running total across every turn this agent has completed since the server started. */
  totalUsage?: TurnUsage;
  /** The literal last error/rate-limit message the provider CLI reported, if any - shown
   * verbatim rather than parsed/interpreted, since providers don't expose a queryable quota API. */
  lastError?: string;
  /** Set when a failed turn's error text yielded a real, parseable future reset time and a
   * retry has genuinely been scheduled for it (an ISO timestamp) - lets the UI show "retrying
   * at ..." instead of a dead-looking error. Absent doesn't mean nothing failed, just that
   * nothing was auto-scheduled - see canRetry. */
  retryAt?: string;
  /** True when there's a failed turn that can be manually retried (the "Retry" button),
   * whether or not an automatic retry is also scheduled. */
  canRetry?: boolean;
}

/** What each provider's CLI actually supports for model/effort selection - kept honest:
 * no hardcoded model catalog for providers whose available models change over time or
 * depend on the user's plan, just the real, verified effort levels each CLI accepts. */
export interface ProviderModelInfo {
  provider: ProviderId;
  /** A few example model values to hint at in the UI - not an exhaustive or guaranteed-valid list. */
  modelExamples: string[];
  /** Empty means this provider's adapter doesn't support effort selection (yet). */
  effortLevels: string[];
  /** The model this provider's CLI is actually configured to use by default, read live from
   * its own config file on disk - undefined if that file wasn't found/parseable, never guessed. */
  currentDefaultModel?: string;
  currentDefaultEffort?: string;
}

/** Which permission modes a provider's adapter actually supports - honest per-provider list,
 * same pattern as ProviderModelInfo. Empty means the adapter isn't implemented yet. */
export interface ProviderPermissionInfo {
  provider: ProviderId;
  availableModes: TrustLevel[];
}

export type ChatChannel = "group" | { agentId: string };

export interface ChatMessage {
  id: string;
  channel: ChatChannel;
  /** "user" for the human operator, otherwise an AgentConfig.id */
  authorId: string;
  authorHandle: string;
  /** Agent ids/handles this message @mentions. Empty = broadcast to everyone in the channel. */
  mentions: string[];
  text: string;
  createdAt: string;
  /** The model that produced this message, if the author is an agent and a model was set. */
  model?: string;
  /** What kind of system message this is, when authorId is "system". Everything used to render
   * identically as faint centered text, which is right for bookkeeping ("task updated") and
   * wrong for a message that actively contradicts a claim an agent just made - the one system
   * message the user most needs to notice was the least noticeable thing on screen. Absent on
   * older persisted messages, which read as "notice". */
  systemKind?: "notice" | "verification";
}

export interface ProviderStatus {
  provider: ProviderId;
  /** Is the provider's own CLI binary found on PATH at all. */
  installed: boolean;
  detail?: string;
}

export interface PendingApproval {
  id: string;
  agentId: string;
  /** What the agent wants to do, in plain language (tool name + summary of args). */
  description: string;
  createdAt: string;
}

// WebSocket event envelope shared between server and web.
export type ServerEvent =
  | { type: "agent:status"; payload: AgentStatus }
  | { type: "agent:added"; payload: AgentConfig }
  | { type: "agent:updated"; payload: AgentConfig }
  | { type: "agent:removed"; payload: { agentId: string } }
  | { type: "chat:message"; payload: ChatMessage }
  | { type: "chat:cleared"; payload: { channel: ChatChannel } }
  | { type: "approval:requested"; payload: PendingApproval }
  | { type: "approval:resolved"; payload: { id: string; approved: boolean } };

// Shared types used by both the server and the web UI.
// Keep this package dependency-free so it can be imported from either side.

// Re-bound to real consts rather than `export { ... } from "./providerCatalog"`: this package
// compiles to CommonJS, and a re-export becomes a lazy getter that Rollup can't trace when
// Vite bundles the web app - importing searchCatalog through it fails the build with
// "not exported by shared/dist/index.js". A plain const assignment compiles to
// `exports.X = ...`, which it can.
import { PROVIDER_CATALOG as CATALOG, searchCatalog as search } from "./providerCatalog";
export type { CatalogProvider } from "./providerCatalog";
export const PROVIDER_CATALOG = CATALOG;
export const searchCatalog = search;

export type ProviderId = "claude-code" | "codex-cli" | "gemini-cli" | "qwen-code" | "custom" | "local";

/**
 * The providers that are actually a CLI binary on this machine. "custom" (a hosted
 * OpenAI-compatible endpoint) and "local" (an OpenAI-compatible server running on this
 * machine) are both HTTP-only, so every per-CLI lookup table excludes them. Named once here
 * rather than spelled out as Exclude<...> at each of the seven call sites, so adding a
 * non-CLI provider is a one-line change instead of seven.
 */
export type CliProviderId = Exclude<ProviderId, "custom" | "local">;

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
  /** Only meaningful when provider is "custom" or "local": the OpenAI-compatible API root
   * this key belongs to, e.g. "https://api.deepseek.com" or "http://127.0.0.1:11434/v1".
   * Chat completions are POSTed to `${baseUrl}/chat/completions` - see adapters/custom-api.ts. */
  baseUrl?: string;
  /** Only meaningful when provider is "custom" or "local": which service this actually is,
   * e.g. "DeepSeek" or "Ollama". Without it every custom connection reads as just "custom"
   * in the UI, and several of them would be indistinguishable from each other. */
  connectionName?: string;
  /** Whether a key was actually stored. The key itself never leaves the server, but whether
   * one exists at all has to: a local server usually needs none, and a connection that
   * silently has no key is otherwise indistinguishable from one that does, right up until a
   * turn fails with a 401. Absent on entries saved before keyless connections existed - all
   * of which did have a key. */
  hasKey?: boolean;
}

/**
 * The real model list an endpoint reported from its own GET /models, plus when we asked.
 * Never persisted and never merged into a hardcoded list: an endpoint's catalog depends on
 * what the user has pulled or subscribed to and changes without notice, so the only honest
 * source is the endpoint itself and the only honest shelf life is "as of this timestamp".
 */
export interface ModelDiscoveryResult {
  models: string[];
  /** ISO timestamp of the response these ids actually came from. */
  fetchedAt: string;
}

/** One OpenAI-compatible server found running on this machine by a scan the user pressed a
 * button to start. See core/localDiscovery.ts for why "found" means more than "port open". */
export interface LocalServerFinding {
  /** Runtime id from core/localDiscovery.ts's table, e.g. "ollama". */
  runtime: string;
  /** Human name for that runtime, e.g. "Ollama". */
  name: string;
  /** The origin that answered - always literal 127.0.0.1, see localDiscovery.ts. */
  origin: string;
  /** The OpenAI-compatible API root to save as a connection's base URL. */
  baseUrl: string;
  /** "running" = the response body positively identified this runtime. "authenticated" = it
   * answered 401/403, so something is listening and wants a key, but we can't confirm what. */
  state: "running" | "authenticated";
  /** Models the server itself listed, when it answered a keyless GET /models. Absent means
   * we didn't get a list back, never that the server has no models. */
  models?: string[];
  /** When this was verified. Shown rather than cached across sessions: a local server that
   * was up five minutes ago is not evidence that it is up now. */
  verifiedAt: string;
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

/**
 * One rate-limit window exactly as the provider's own CLI reported it. Every field here comes
 * verbatim out of a provider event - nothing is estimated, interpolated, or filled in with a
 * default. If a provider didn't report a window, there is no entry for it at all (rather than
 * an entry reading 0%), because "we don't know" and "0% used" are different facts.
 */
export interface RateLimitWindow {
  /** The provider's own name for the window: Claude's "five_hour"/"seven_day", Codex's "primary"/"secondary". */
  key: string;
  /** Human label. Claude's windows are self-describing; Codex's is derived from its own window_minutes. */
  label: string;
  /** 0..100. Claude reports a 0..1 fraction and Codex a 0..100 percent - both are normalised here
   * to percent, which is the only arithmetic ever applied to a provider's number. */
  usedPercent: number;
  /** Unix seconds, passed straight through. Undefined = the provider didn't say when it resets. */
  resetsAt?: number;
}

/**
 * The most recent rate-limit report from one provider, with when we saw it. Neither Claude Code
 * nor Codex exposes a pollable quota endpoint or an on-disk cache, so this only ever arrives
 * mid-turn - which is why an observation is worthless without its timestamp and why the UI
 * always labels the figure with when it was observed rather than implying it is live.
 */
export interface ProviderRateLimit {
  provider: ProviderId;
  windows: RateLimitWindow[];
  /** ISO time the provider's own event carrying these numbers was received. */
  observedAt: string;
  /** The provider's own plan label, if its event carried one (Codex's plan_type). */
  planType?: string;
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
  /** The last rate-limit report seen on a turn run by this agent, if its provider ever sent one. */
  rateLimit?: ProviderRateLimit;
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
  | { type: "approval:resolved"; payload: { id: string; approved: boolean } }
  | { type: "usage:rate-limit"; payload: ProviderRateLimit };

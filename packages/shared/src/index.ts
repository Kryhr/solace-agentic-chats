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

// Same re-binding rule as above - a plain `export { ... } from` here becomes a lazy getter
// Rollup can't trace, and the web build fails with "not exported by shared/dist/index.js".
import { CONNECTOR_KINDS as KINDS, connectorKind as kindById } from "./connectors";
export type { ConnectorKind, ConnectorKindId } from "./connectors";
export const CONNECTOR_KINDS = KINDS;
export const connectorKind = kindById;

// Same re-binding rule again - see the two comments above.
import {
  DEFAULT_APP_SETTINGS as DEFAULTS,
  SETTING_DEFINITIONS as DEFS,
  sanitizeAppSettings as sanitizeSettings,
} from "./settings";
export type {
  AppSettings,
  SettingDefinition,
  ToggleSettingDefinition,
  NumberSettingDefinition,
  SelectSettingDefinition,
  SettingsTrustLevel,
} from "./settings";
export const DEFAULT_APP_SETTINGS = DEFAULTS;
export const SETTING_DEFINITIONS = DEFS;
export const sanitizeAppSettings = sanitizeSettings;

// Same re-binding rule again - see the comments above.
import { COMMAND_DEFINITIONS as COMMANDS, helpText as help } from "./commands";
export type { CommandDefinition } from "./commands";
export const COMMAND_DEFINITIONS = COMMANDS;
export const helpText = help;

// Same re-binding rule again - see the comments above.
import { emptyCoordination as emptyCoord, normalizePath as normPath, pathCoveredBy as covered } from "./coordination";
export type { Block, Contract, CoordinationState, FileClaim } from "./coordination";
export const emptyCoordination = emptyCoord;
export const normalizePath = normPath;
export const pathCoveredBy = covered;

// Same re-binding rule again - see the comments above.
import {
  MCP_CATALOG as MCP_CAT,
  MCP_SERVER_NAME_PATTERN as MCP_NAME_RE,
  RESERVED_MCP_SERVER_NAMES as RESERVED_MCP,
} from "./mcpServers";
export type {
  CatalogMcpServer,
  McpEnvEntry,
  McpServerConfig,
  McpServerScope,
  McpTransport,
} from "./mcpServers";
export const MCP_CATALOG = MCP_CAT;
export const MCP_SERVER_NAME_PATTERN = MCP_NAME_RE;
export const RESERVED_MCP_SERVER_NAMES = RESERVED_MCP;

export type ProviderId =
  | "claude-code"
  | "codex-cli"
  | "gemini-cli"
  | "qwen-code"
  | "copilot-cli"
  | "custom"
  | "local";

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
 * at all; core/credentials.ts reads those as "api-key".
 *
 * "login" and "secret" exist because the store's real job is "anything an agent needs to
 * sign into something later", and most of that is neither an API key nor an SSH target: a
 * service password, a session token, a recovery code. Forcing those into the api-key shape
 * would mean storing them under a fake ProviderId and showing them in the provider list. */
export type CredentialKind = "api-key" | "ssh" | "login" | "secret";

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
   * only ever returned by the deliberate per-entry reveal, never by a list. */
  hasStoredKeyMaterial?: boolean;
  /** True when Solace is holding the passphrase for this key. It has to be surfaced: a
   * passphrase sitting in the same plaintext file as the path to the key it protects hands
   * both halves to anyone who can read that file, and until this flag existed the UI gave
   * the user no way at all to know Solace had kept it. Never the passphrase itself. */
  hasPassphrase?: boolean;
}

interface CredentialMetaBase {
  id: string;
  /** A short label to tell saved credentials apart, e.g. "personal" - not the secret itself.
   * Also how an agent addresses one entry in the vault, so it has to stay non-secret. */
  label: string;
  createdAt: string;
  /** Free text the user typed about this entry ("the 2FA device is my old phone", "rotate
   * in March"). Deliberately NOT secret and deliberately not redacted: it is shown in the
   * list, so anything that must stay hidden belongs in the entry's secret field instead.
   * The UI says so where it is typed. */
  notes?: string;
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

/** A username/password sign-in for some service - the commonest thing an agent is actually
 * asked to do ("log into the dashboard and pull the numbers") and the one thing the store
 * could not hold at all before. Metadata only: the password and TOTP secret are absent from
 * this shape by construction. */
export interface LoginCredentialMeta extends CredentialMetaBase {
  kind: "login";
  /** What is being signed into, as the user wrote it: a URL or a plain service name. Not a
   * secret - it is the thing that makes one login row distinguishable from another. */
  service: string;
  username: string;
  /** Whether a password was actually stored. A login row with no password is legitimate
   * (some sign-ins are a magic link) but is otherwise indistinguishable from one that has
   * a password the reveal simply failed to return. */
  hasPassword: boolean;
  /** Whether a TOTP seed / backup codes blob was stored alongside it. Flag, never the seed. */
  hasTotp: boolean;
}

/** Anything that doesn't fit the shapes above: a bearer token, a licence key, a recovery
 * code, a bare note the user wants kept under the same protection as the rest. */
export interface SecretCredentialMeta extends CredentialMetaBase {
  kind: "secret";
  /** Whether a value was actually stored, so an empty entry can't masquerade as a full one. */
  hasValue: boolean;
}

export type CredentialMeta =
  | ApiKeyCredentialMeta
  | SshCredentialMeta
  | LoginCredentialMeta
  | SecretCredentialMeta;

/** One secret field of one entry, as returned by the deliberate per-entry reveal. */
export interface RevealedField {
  /** Which secret this is, e.g. "password", "API key". Shown as the row's label. */
  name: string;
  value: string;
  /** Extra context the user needs to judge what they are looking at - e.g. that a passphrase
   * unlocks the key file whose path is listed right above it. */
  note?: string;
}

/**
 * The response of POST /api/credentials/:id/reveal, and the ONLY shape in this file that
 * carries real secret values. It is deliberately not part of CredentialMeta and is never
 * returned by any list route: reveal is a separate, single-id, POST-only action so that no
 * page load, prefetch or background poll can ever produce one.
 */
export interface CredentialReveal {
  id: string;
  kind: CredentialKind;
  label: string;
  fields: RevealedField[];
}

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
  /** ISO time the in-flight turn started, so the UI can show how long it has been working
   * rather than only that it is. Absent when idle. */
  turnStartedAt?: string;
  /** The chat whose turn this agent is currently running, when it is running one in a chat
   * rather than in its own hub. Without this the UI could only ask "is this agent busy?",
   * which is not the same question as "is this agent busy HERE" - so every open chat showed
   * every working agent, including chats that had nothing to do with the turn. */
  activeChatId?: string;
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
  /** The concrete model the provider itself reported for this agent's most recent turn, when
   * its stream carried one. This is the only honest answer to "which Opus did I just get":
   * an alias like "opus" names whatever the CLI currently maps it to, and the mapping is the
   * provider's to change. Absent means no turn has run yet, or that provider's stream never
   * says - it must never be back-filled with the configured value to look complete. */
  resolvedModel?: string;
}

/**
 * Where a list of model ids actually came from. Every model this app offers carries one of
 * these, because "which models exist" and "which models your subscription can run" are two
 * different questions and only the first is answerable from this machine. The UI renders the
 * source verbatim next to the picker rather than letting a list imply an entitlement.
 */
export type ModelCatalogSourceKind =
  /** The CLI asked its own provider and answered just now (Codex's `debug models` refresh). */
  | "cli-live"
  /** Read out of the installed CLI's own shipped files - its real build, not our memory of it. */
  | "cli-artifact"
  /** The CLI's on-disk cache of something its server told it about THIS account. */
  | "account-cache"
  /** A dated, cited documentation reference, used only where nothing above exists. */
  | "docs";

export interface ModelCatalogSource {
  kind: ModelCatalogSourceKind;
  /** Exactly where this came from: a command line, an absolute file path, or a doc URL. */
  origin: string;
  /** Version of the CLI/artifact read, when the artifact stated one. */
  version?: string;
  /** ISO time this app actually read it. A model list without one is a claim without a date. */
  readAt: string;
  /** How many model ids this particular source contributed. */
  count: number;
}

/** One selectable model, as described by whichever source produced it. */
export interface ModelOption {
  /** The exact string passed to the CLI's own --model flag. Never a prettified name. */
  id: string;
  /** Human label the source itself gave (e.g. "Opus 4.8"); the id when it gave none. */
  label: string;
  /** Grouping key, e.g. "opus" / "gpt-5.6" - so six Opus variants read as one family. */
  family: string;
  /** Heading for that group, e.g. "Opus". */
  familyLabel: string;
  /** A detail the source actually stated (knowledge cutoff, Codex's own description). Never
   * editorialised and never invented - absent when the source said nothing. */
  note?: string;
  /** Set only for alias ids ("opus", "sonnet"): what the installed CLI's OWN alias table says
   * this currently resolves to. An alias is not a model, and the app must not pretend it is. */
  aliasFor?: string;
  /** Effort levels this specific model declares, where the source states them per model
   * (Codex does). Absent means fall back to ProviderModelInfo.effortLevels. */
  effortLevels?: string[];
  defaultEffort?: string;
  /** True when the source itself marks this model as one it does not normally list. Shown in a
   * separate group rather than dropped, so nothing the user might legitimately reach is hidden. */
  hiddenBySource?: boolean;
  /** Index of the ModelCatalogSource in ProviderModelInfo.sources that produced this entry. */
  sourceIndex: number;
}

/** What each provider's CLI actually supports for model/effort selection - kept honest:
 * every model id here is traceable to `sources`, the effort levels are the ones each CLI's
 * own --help documents, and nothing here claims the current plan can reach any of it. */
export interface ProviderModelInfo {
  provider: ProviderId;
  /** Every model this app could find for the provider, each tagged with where it came from.
   * Empty is a real answer: it means nothing could be enumerated, see sourceError. */
  models: ModelOption[];
  /** The sources behind `models`, in the order they were consulted. Empty when none answered. */
  sources: ModelCatalogSource[];
  /** Verbatim reason enumeration failed or fell back, when it did. Surfaced to the user rather
   * than swallowed: "we couldn't ask" must never look like "there is nothing to list". */
  sourceError?: string;
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

/**
 * A chat room. There used to be exactly one, addressed by the literal string "group", and the
 * only way to "start a new one" was /clear - which archived and emptied the single room you
 * already had. A chat is now a real entity with an id, so there can be many.
 *
 * LEGACY_CHAT_ID is the id the one pre-existing group chat migrates onto. It is the literal
 * old channel string on purpose: the migration is then `"group"` -> `{ chatId: "group" }`,
 * which is both trivially correct and idempotent - running it twice changes nothing, because
 * a channel that is already an object is left alone.
 */
export interface ChatMeta {
  id: string;
  title: string;
  createdAt: string;
  /** ProjectMeta.id this chat is filed under. Absent = unfiled, which reaches every agent. */
  projectId?: string;
}

export const LEGACY_CHAT_ID = "group";

/**
 * A project is a directory under WORKSPACE_ROOT (see server/core/workspace.ts) that the user
 * has adopted into Solace. `path` is the real folder; nothing in this app ever deletes it.
 *
 * Note there is deliberately no `agentIds` here. An agent already has a `cwd`, which is the
 * directory its CLI genuinely runs in - a second, independently-editable "which project is this
 * agent in" field could disagree with it, and then one of the two would be lying. Membership is
 * derived from cwd instead, so it cannot drift. See server/core/chatStore.ts#agentInProject.
 */
export interface ProjectMeta {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  /**
   * Agents deliberately removed from this project by the user, when agents otherwise follow
   * them between projects (see AppSettings#agentsFollowProjects).
   *
   * An EXCLUDE list rather than an include list, on purpose: the default has to be "every agent
   * is here", including agents added long after this project was created. An include list would
   * silently leave every new agent out of every existing project, which is the empty-roster
   * problem this setting exists to fix.
   */
  excludedAgentIds?: string[];
}

export type ChatChannel = { chatId: string } | { agentId: string };

/** Narrowing helper, because `"chatId" in channel` reads badly at every one of its call sites. */
export function isChatChannel(channel: ChatChannel): channel is { chatId: string } {
  return "chatId" in channel;
}

/**
 * What an agent message actually is.
 *
 * Until now the hub inferred this from the shape of the text - a `_used …_` wrapper meant a
 * tool call, anything else was prose - which meant reasoning output was indistinguishable
 * from an answer, and any client-side attempt to tell them apart would have been a guess that
 * eventually hid something real. The source knows; the source says so.
 *
 * - "tool"      a single tool/command invocation. Carries `tool` with the provider's own name.
 * - "reasoning" the model's thinking, when the provider emits it as a distinct item.
 * - "progress"  prose the agent said mid-turn, before it had finished. Narration, not a result.
 * - "answer"    the agent's final word for the turn. Set by promoting the last "progress"
 *               message once the turn has genuinely completed - never guessed mid-stream.
 * - "error"     a failure reported for this turn. Never collapsed, never demoted.
 *
 * Absent on every message persisted before this existed, and on user/system messages. An agent
 * message with no kind renders as an answer, which is how the old hub already rendered it.
 */
/** "announcement" is an agent telling the group something nobody needs to answer. It is the one
 * kind that deliberately summons NOBODY: an ordinary unaddressed message gives every agent in
 * the chat a real billed turn, so a status update used to cost three of them. */
export type AgentMessageKind = "answer" | "progress" | "tool" | "reasoning" | "error" | "announcement";

/** One tool invocation, as reported by the provider. Nothing here is invented: `name` is the
 * provider's own tool name and `detail` is its own arguments - `label` is derived from those two
 * by a fixed table (see server/core/toolLabel.ts), never by asking a model to describe them. */
export interface ToolCallSummary {
  /** The tool name exactly as the provider reported it, e.g. "Read", "command_execution". */
  name: string;
  /** Short human label derived mechanically from `name` and the call's real arguments. */
  label: string;
  /** The full call - name and arguments - for the disclosure. Secret-scrubbed like all agent text. */
  detail: string;
  /** The process exit code, only when the provider actually reported one. Non-zero is surfaced
   * as a failed step rather than being folded into the quiet "done" pile. */
  exitCode?: number;
}

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
  /** What this agent message is - see AgentMessageKind. Absent on user/system messages and on
   * anything persisted before this field existed. */
  agentKind?: AgentMessageKind;
  /** Only set when agentKind is "tool". */
  tool?: ToolCallSummary;
  /** Which turn produced this message. Lets the client fold a whole turn's activity into one
   * indicator instead of guessing at turn boundaries from adjacency. Absent on user messages
   * and on history written before this existed - the client falls back to adjacency there. */
  turnId?: string;
}

/**
 * The result of one real check against one connection, and the only thing in the UI allowed
 * to turn a dot green.
 *
 * There is no "assumed" or "probably" state here by design. A connection the user has not
 * checked is represented by the ABSENCE of a ConnectionCheck - `null`, rendered as "Not
 * checked" - which is a different thing from `ok: false`. `checkedAt` is mandatory because
 * every one of these can stop being true five minutes later: a CLI gets uninstalled, a token
 * expires, a local server is closed. A green dot with no time on it is a claim about now
 * that we cannot actually make.
 */
export interface ConnectionCheck {
  ok: boolean;
  /**
   * What the underlying tool or endpoint actually said, as close to verbatim as it can be
   * carried - `gh auth status`'s own text, the CLI's own `--version` line, the endpoint's own
   * error body. Never a phrase this app made up about what it assumes happened.
   */
  detail: string;
  /** ISO timestamp of the moment the check ran. */
  checkedAt: string;
}

export interface ProviderStatus {
  provider: ProviderId;
  /** Is the provider's own CLI binary found on PATH at all. */
  installed: boolean;
  detail?: string;
  /**
   * The first line the CLI printed for `--version`, verbatim. Present only when that command
   * actually exited 0, so it doubles as the evidence behind `installed`.
   */
  version?: string;
  /** When `installed` was determined. See ConnectionCheck.checkedAt for why this is required
   * rather than optional in spirit - it is optional here only so older persisted shapes and
   * test fixtures don't become invalid. */
  checkedAt?: string;
  /** The real command that installs this CLI, for a provider that isn't installed. Shown as
   * something to copy, not as prose about "installing the CLI". */
  installCommand?: string;
  /** The real command that signs it in once installed, when that is a separate step. */
  loginCommand?: string;
}

/**
 * What `gh` on this machine actually reports. Deliberately carries `statusText` - the raw
 * output of `gh auth status` - rather than a set of capability flags this app invented: the
 * user asked for what gh says, and a summarised "GitHub: connected" hides the part that
 * matters (which host, which account, which scopes).
 */
export interface GithubConnection {
  /** Is the `gh` binary on PATH at all. False means every other field is meaningless. */
  installed: boolean;
  authenticated: boolean;
  /** The current login, asked of GitHub directly via `gh api user`. See core/github.ts for
   * why this is not taken from `gh auth status`'s own text. */
  account?: string;
  /** The account name `gh auth status` printed. Kept separately from `account` because gh
   * caches it from when the token was stored and it can genuinely disagree after a rename. */
  reportedAccount?: string;
  /** `gh auth status`'s own output, verbatim. gh masks the token itself; nothing is added. */
  statusText?: string;
  /** Token scopes exactly as gh listed them, e.g. "repo", "read:org". Empty array means gh
   * reported a scope line with nothing in it; absent means gh printed no scope line at all. */
  scopes?: string[];
  /** The real command to run next, given the state above - `gh auth login`, or the install
   * command for this OS. Absent only where no single command is true for the platform. */
  fixCommand?: string;
  /** The sentence that goes with fixCommand, or stands alone where there is no one command
   * (Linux, where the install depends on the distribution's package manager). */
  fixHint?: string;
  checkedAt: string;
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
  /** An already-posted message changed in place. Currently only used to promote a turn's last
   * "progress" message to "answer" once the turn has actually finished - the only honest moment
   * at which "this is the final answer" is knowable. Payload is the whole updated message, so a
   * client that keys history by id just replaces its entry. */
  | { type: "chat:message:updated"; payload: ChatMessage }
  | { type: "chat:cleared"; payload: { channel: ChatChannel } }
  | { type: "approval:requested"; payload: PendingApproval }
  | { type: "approval:resolved"; payload: { id: string; approved: boolean } }
  | { type: "usage:rate-limit"; payload: ProviderRateLimit }
  /** A chat was copied into Saved chats without being cleared, so the archives list has
   * changed even though no channel was emptied. */
  | { type: "archive:saved"; payload: { channel: ChatChannel } }
  /** The whole chat + project roster, re-sent as one payload on every change rather than as
   * added/renamed/removed deltas. There are tens of these, not thousands, and a single
   * authoritative list is the one shape a second browser tab cannot apply out of order. */
  | { type: "chats:updated"; payload: { chats: ChatMeta[]; projects: ProjectMeta[] } }
  /** App settings changed. Sent as the whole object for the same reason as chats:updated - it
   * is a handful of fields, and one authoritative payload is the only shape a second tab
   * cannot apply out of order. */
  | { type: "settings:updated"; payload: import("./settings").AppSettings };

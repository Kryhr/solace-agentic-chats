import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizePersistedRateLimits } from "./rateLimits";
import {
  DEFAULT_APP_SETTINGS,
  LEGACY_CHAT_ID,
  sanitizeAppSettings,
  type AgentConfig,
  type AppSettings,
  type ChatMessage,
  type ChatMeta,
  type ProjectMeta,
  type CoordinationState,
  type ProviderRateLimit,
} from "@solace/shared";
import type { McpServerConfig } from "@solace/shared";
import { sanitizeMcpServers } from "./mcpServers";
import type { ChatArchive } from "./archiveStore";
import type { PersistedAgentQueue } from "./agentManager";

/** One agent's provider-side session. Keyed with cwd and provider as well as the id, because a
 * session belongs to a working directory and a CLI - if the agent is repointed or switched, the
 * stored id is meaningless and resuming it would drop the agent into an unrelated conversation. */
export interface PersistedAgentSession {
  agentId: string;
  provider: string;
  cwd: string;
  sessionId: string;
  updatedAt: string;
}

export interface PersistedState {
  agents: AgentConfig[];
  history: ChatMessage[];
  archives: ChatArchive[];
  /** Each agent's outstanding (queued/in-flight) work, so a restart doesn't silently drop it -
   * see AgentManager's constructor/getPersistableQueues(). Optional only because state saved
   * before this field existed won't have it. */
  queues: PersistedAgentQueue[];
  /** Each agent's provider-side conversation id, so agents keep their own memory across a
   * server restart rather than silently starting cold. Optional on load: state files written
   * before this existed simply have no sessions. */
  sessions: PersistedAgentSession[];
  /** Last rate-limit observation per provider. Persisted because providers only report during
   * a turn: without this, a restart would leave the meter blank until the user spent a turn to
   * refill it. Always carries its own observedAt so a stale figure is shown as stale, not fresh. */
  rateLimits: ProviderRateLimit[];
  /** Every chat room. Absent in any state file written before chats existed - see
   * migrateChatChannels, which synthesises the one chat those files implicitly had. */
  chats: ChatMeta[];
  /** Projects the user has adopted. Absent on older state files, and legitimately empty: a
   * project link is optional, and chats/agents work perfectly well unfiled. */
  projects: ProjectMeta[];
  /** App-level settings. These change how the SERVER behaves, so they live here rather than in
   * a browser's localStorage: they must survive a restart and apply whichever tab is open, or
   * none. Absent on any state file written before Settings existed, which reads as the
   * documented defaults - see sanitizeAppSettings. */
  settings: AppSettings;
  /** Per-chat coordination boards: file claims, published contracts, who is waiting on what,
   * and which announcements each agent has already been shown. Absent on any state file written
   * before coordination existed, which restores as empty boards rather than undefined - see
   * CoordinationBoard's constructor. */
  coordination: Record<string, CoordinationState>;
  /** User-registered MCP servers, injected alongside the built-in solace bridge on every CLI
   * turn (see core/mcpServers.ts). Absent on any state file written before this existed, which
   * restores as none - i.e. exactly the behaviour that file already had. */
  mcpServers: McpServerConfig[];
}

const EMPTY_STATE: PersistedState = {
  agents: [],
  history: [],
  archives: [],
  queues: [],
  sessions: [],
  rateLimits: [],
  chats: [],
  projects: [],
  settings: { ...DEFAULT_APP_SETTINGS },
  coordination: {},
  mcpServers: [],
};

function statePath(workspaceRoot: string): string {
  return join(workspaceRoot, ".solace-state.json");
}

/**
 * Everything (agent configs, chat history) lives in memory while the server runs, which
 * means a crash or a dev-mode auto-restart would otherwise silently wipe an in-progress
 * conversation. This is a deliberately dumb JSON snapshot on disk, not a database - fine for
 * a local single-user tool, revisit if this ever needs to survive concurrent writers.
 */
// v0.1 used a hand-rolled three-tier TrustLevel; the real per-provider permission modes
// (see @solace/shared's TrustLevel doc comment) replaced it with the same names Claude
// Code's own --permission-mode flag uses. Map old persisted values so existing agents keep
// working with a valid enum member instead of silently breaking after this upgrade.
const OLD_TRUST_LEVEL_MIGRATION: Record<string, string> = {
  "confirm-all": "manual",
  "confirm-risky": "acceptEdits",
  "auto-approve": "bypassPermissions",
};

function migrateAgent(agent: AgentConfig): AgentConfig {
  const mapped = OLD_TRUST_LEVEL_MIGRATION[agent.trustLevel as unknown as string];
  return mapped ? { ...agent, trustLevel: mapped as AgentConfig["trustLevel"] } : agent;
}

/** The one chat every pre-chats state file implicitly had. Titled honestly: it is not "a new
 * chat", it is the group chat this app had exactly one of, carried forward whole.
 *
 * A factory, not a shared const: ChatStore renames a chat in place, and a module-level object
 * handed to it would have that rename applied to every future load of this process. */
function legacyChat(): ChatMeta {
  return { id: LEGACY_CHAT_ID, title: "Group chat", createdAt: new Date(0).toISOString() };
}

/** Was this channel written before chats existed? Those files store the literal string
 * "group"; everything since stores an object. */
function isLegacyGroupChannel(channel: unknown): boolean {
  return channel === "group";
}

function migrateChannel<T extends { channel?: unknown }>(item: T): T {
  return isLegacyGroupChannel(item?.channel) ? { ...item, channel: { chatId: LEGACY_CHAT_ID } } : item;
}

/**
 * Carry a state file written before chats existed onto the chat model, without losing a message.
 *
 * Everything that was in the single `"group"` channel - live history, archived transcripts, the
 * messages inside those archives, and any still-queued turn whose reply was bound for it - moves
 * into one chat with the fixed id LEGACY_CHAT_ID. Nothing is dropped and nothing is renamed.
 *
 * Idempotent by construction: the only thing it rewrites is the literal string "group", which no
 * longer exists anywhere after the first pass, and it refuses to add a second legacy chat if one
 * is already present. Running it on an already-migrated file is a no-op.
 *
 * Exported because this is the one piece of this change whose failure mode is "the user's entire
 * conversation history silently vanishes on upgrade" - it is tested directly against a fixture
 * of the old shape, not inferred from the server booting.
 */
export function migrateChatChannels(parsed: {
  history?: unknown;
  archives?: unknown;
  queues?: unknown;
  chats?: unknown;
}): { history: ChatMessage[]; archives: ChatArchive[]; queues: PersistedAgentQueue[]; chats: ChatMeta[] } {
  const history = (Array.isArray(parsed.history) ? parsed.history : []).map(migrateChannel) as ChatMessage[];
  const archives = (Array.isArray(parsed.archives) ? parsed.archives : []).map((a: ChatArchive) => {
    const moved = migrateChannel(a) as ChatArchive;
    const messages = Array.isArray(moved.messages) ? moved.messages.map(migrateChannel) : [];
    return { ...moved, messages } as ChatArchive;
  });
  const queues = (Array.isArray(parsed.queues) ? parsed.queues : []).map((q: PersistedAgentQueue) => ({
    ...q,
    inFlight: q.inFlight ? migrateTurn(q.inFlight) : undefined,
    queued: Array.isArray(q.queued) ? q.queued.map(migrateTurn) : [],
    pendingInbound: Array.isArray(q.pendingInbound) ? q.pendingInbound.map(migrateTurn) : undefined,
  })) as PersistedAgentQueue[];

  // A state file with no `chats` key predates chats entirely, so it had exactly one - even when
  // that one was empty, which is still a chat the user will expect to find on restart.
  const chats = Array.isArray(parsed.chats) ? (parsed.chats as ChatMeta[]) : [];
  if (!Array.isArray(parsed.chats) || !chats.some((c) => c.id === LEGACY_CHAT_ID)) {
    const needsLegacy = !Array.isArray(parsed.chats) || history.some((m) => channelChatId(m.channel) === LEGACY_CHAT_ID);
    if (needsLegacy) chats.unshift(legacyChat());
  }
  return { history, archives, queues, chats };
}

function channelChatId(channel: unknown): string | undefined {
  return channel && typeof channel === "object" && "chatId" in channel
    ? (channel as { chatId: string }).chatId
    : undefined;
}

function migrateTurn(turn: PersistedAgentQueue["inFlight"]): NonNullable<PersistedAgentQueue["inFlight"]> {
  const t = turn as NonNullable<PersistedAgentQueue["inFlight"]>;
  return isLegacyGroupChannel(t?.replyChannel) ? { ...t, replyChannel: { chatId: LEGACY_CHAT_ID } } : t;
}

export function loadState(workspaceRoot: string): PersistedState {
  const path = statePath(workspaceRoot);
  // A fresh install starts with one chat rather than an empty sidebar and a "New chat" button
  // the user has to find before they can say anything.
  if (!existsSync(path)) return { ...EMPTY_STATE, chats: [legacyChat()] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    const migrated = migrateChatChannels(parsed);
    return {
      agents: Array.isArray(parsed.agents) ? parsed.agents.map(migrateAgent) : [],
      history: migrated.history,
      archives: migrated.archives,
      queues: migrated.queues,
      chats: migrated.chats,
      projects: Array.isArray(parsed.projects) ? parsed.projects : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      // State files written before the usage meter existed simply have no rateLimits key.
      rateLimits: sanitizePersistedRateLimits(parsed.rateLimits),
      // Likewise for settings: no key means "never configured", which is the defaults.
      settings: sanitizeAppSettings(parsed.settings),
      // And likewise for coordination: no key means no board has ever been used. Guarded on
      // shape rather than presence so a hand-edited array (or null) restores as empty boards
      // instead of throwing on the first Object.entries.
      coordination:
        parsed.coordination && typeof parsed.coordination === "object" && !Array.isArray(parsed.coordination)
          ? (parsed.coordination as Record<string, CoordinationState>)
          : {},
      // Guarded on shape for the same reason, and additionally filtered: a hand-edited entry
      // claiming the reserved "solace" name would shadow the group-chat bridge, so it is
      // dropped on load rather than trusted because it happened to be on disk.
      mcpServers: sanitizeMcpServers(parsed.mcpServers),
    };
  } catch {
    // An unreadable state file already means everything is gone; at least hand back a usable
    // app rather than a sidebar with no chat in it and no obvious way forward.
    return { ...EMPTY_STATE, chats: [legacyChat()] };
  }
}

export function saveState(workspaceRoot: string, state: PersistedState) {
  // Atomic replace. The previous version wrote JSON straight over the live file with a single
  // writeFileSync. A crash, power loss, full disk, or a dev-mode restart landing mid-write left
  // a TRUNCATED file, and loadState's catch-all treats an unparseable file as "everything is
  // gone" and hands back EMPTY_STATE - so one torn write silently wipes every agent, all chat
  // history, archives, projects, coordination and MCP servers, with no backup. Writing a temp
  // file first and renaming it over the target makes the swap atomic: a reader ever only sees
  // the whole old file or the whole new one, never a half-written one.
  atomicWriteFileSync(statePath(workspaceRoot), JSON.stringify(state), { encoding: "utf-8" });
}

/**
 * Write `data` to `path` so that `path` is never observed in a partially-written state: the
 * bytes go to a sibling temp file, which is then renamed over the target. rename is atomic on
 * a single volume on every OS this runs on (on Windows, libuv maps it to MoveFileEx with
 * REPLACE_EXISTING, which overwrites), so a crash can lose the newest save but can never
 * corrupt the existing one into unparseable JSON.
 */
export function atomicWriteFileSync(
  path: string,
  data: string,
  options: { encoding: "utf-8"; mode?: number },
): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, data, options);
  renameSync(tmp, path);
}

export function debounce(fn: () => void, ms: number): () => void {
  let handle: NodeJS.Timeout | null = null;
  return () => {
    if (handle) clearTimeout(handle);
    handle = setTimeout(fn, ms);
  };
}

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig, ChatMessage } from "@solace/shared";
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
}

const EMPTY_STATE: PersistedState = { agents: [], history: [], archives: [], queues: [], sessions: [] };

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

export function loadState(workspaceRoot: string): PersistedState {
  const path = statePath(workspaceRoot);
  if (!existsSync(path)) return EMPTY_STATE;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return {
      agents: Array.isArray(parsed.agents) ? parsed.agents.map(migrateAgent) : [],
      history: Array.isArray(parsed.history) ? parsed.history : [],
      archives: Array.isArray(parsed.archives) ? parsed.archives : [],
      queues: Array.isArray(parsed.queues) ? parsed.queues : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    };
  } catch {
    return EMPTY_STATE;
  }
}

export function saveState(workspaceRoot: string, state: PersistedState) {
  writeFileSync(statePath(workspaceRoot), JSON.stringify(state), "utf-8");
}

export function debounce(fn: () => void, ms: number): () => void {
  let handle: NodeJS.Timeout | null = null;
  return () => {
    if (handle) clearTimeout(handle);
    handle = setTimeout(fn, ms);
  };
}

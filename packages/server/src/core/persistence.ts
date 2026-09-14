import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig, ChatMessage } from "@solace/shared";

export interface PersistedState {
  agents: AgentConfig[];
  history: ChatMessage[];
}

const EMPTY_STATE: PersistedState = { agents: [], history: [] };

function statePath(workspaceRoot: string): string {
  return join(workspaceRoot, ".solace-state.json");
}

/**
 * Everything (agent configs, chat history) lives in memory while the server runs, which
 * means a crash or a dev-mode auto-restart would otherwise silently wipe an in-progress
 * conversation. This is a deliberately dumb JSON snapshot on disk, not a database - fine for
 * a local single-user tool, revisit if this ever needs to survive concurrent writers.
 */
export function loadState(workspaceRoot: string): PersistedState {
  const path = statePath(workspaceRoot);
  if (!existsSync(path)) return EMPTY_STATE;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return {
      agents: Array.isArray(parsed.agents) ? parsed.agents : [],
      history: Array.isArray(parsed.history) ? parsed.history : [],
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

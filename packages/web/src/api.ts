import type {
  AgentConfig,
  AgentStatus,
  ChatMessage,
  CredentialMeta,
  LocalServerFinding,
  ModelDiscoveryResult,
  PendingApproval,
  ProviderId,
  ProviderModelInfo,
  ProviderPermissionInfo,
  ProviderStatus,
  ServerEvent,
} from "@solace/shared";

export interface ProjectInfo {
  name: string;
  path: string;
}

export async function fetchAgents(): Promise<AgentConfig[]> {
  return fetch("/api/agents").then((r) => r.json());
}

export async function fetchProjects(): Promise<{ root: string; projects: ProjectInfo[] }> {
  return fetch("/api/projects").then((r) => r.json());
}

export async function createProject(name: string): Promise<ProjectInfo> {
  const res = await fetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Failed to create project");
  return data;
}

export async function fetchHistory(): Promise<ChatMessage[]> {
  return fetch("/api/chat/history").then((r) => r.json());
}

export async function createAgent(config: Omit<AgentConfig, "id">): Promise<AgentConfig> {
  return fetch("/api/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  }).then((r) => r.json());
}

export async function updateAgent(
  id: string,
  patch: Partial<Pick<AgentConfig, "trustLevel" | "currentTask" | "model" | "effort" | "authMode" | "credentialId">>,
): Promise<void> {
  await fetch(`/api/agents/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export async function fetchProviderStatuses(): Promise<ProviderStatus[]> {
  return fetch("/api/providers/status").then((r) => r.json());
}

export async function fetchProviderModels(): Promise<ProviderModelInfo[]> {
  return fetch("/api/providers/models").then((r) => r.json());
}

export async function fetchPermissionModes(): Promise<ProviderPermissionInfo[]> {
  return fetch("/api/providers/permission-modes").then((r) => r.json());
}

export async function fetchAgentDirectHistory(agentId: string): Promise<ChatMessage[]> {
  return fetch(`/api/agents/${agentId}/chat`).then((r) => r.json());
}

export interface ChatArchive {
  id: string;
  channel: "group" | { agentId: string };
  clearedAt: string;
  messages: ChatMessage[];
  /** Captured server-side at archive time so the label survives the agent later being
   * removed; absent only on archives saved before this field existed. */
  channelLabel?: string;
}

export async function fetchArchives(): Promise<ChatArchive[]> {
  return fetch("/api/archives").then((r) => r.json());
}

export async function sendAgentDirectMessage(agentId: string, text: string): Promise<void> {
  const res = await fetch(`/api/agents/${agentId}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Failed to send (${res.status})`);
}

export async function removeAgent(agentId: string): Promise<void> {
  await fetch(`/api/agents/${agentId}`, { method: "DELETE" });
}

/** Reuses the /clear slash command's own handling (archives, doesn't delete) by posting it
 * as if the user had typed it - one code path, no special "clear via button" logic to drift. */
export async function clearAgentHistory(agentId: string): Promise<void> {
  await sendAgentDirectMessage(agentId, "/clear");
}

/** Cancels an agent's in-flight turn without removing the agent itself. */
export async function stopAgent(agentId: string): Promise<void> {
  await fetch(`/api/agents/${agentId}/stop`, { method: "POST" });
}

/** Re-submits an agent's most recently failed turn exactly as it was. */
export async function retryAgent(agentId: string): Promise<void> {
  await fetch(`/api/agents/${agentId}/retry`, { method: "POST" });
}

export async function testProviderConnection(provider: ProviderId): Promise<{ ok: boolean; message: string }> {
  return fetch(`/api/providers/${provider}/test`, { method: "POST" }).then((r) => r.json());
}

export async function resolveApproval(id: string, approved: boolean): Promise<void> {
  await fetch(`/api/approvals/${id}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approved }),
  });
}

export async function fetchCredentials(): Promise<CredentialMeta[]> {
  return fetch("/api/credentials").then((r) => r.json());
}

/** baseUrl/connectionName are only meaningful for providers "custom" and "local" - an
 * OpenAI-compatible endpoint added under Connections. apiKey may be "" for those two: a
 * local model server normally has no key at all. */
export async function saveCredential(
  provider: ProviderId,
  label: string,
  apiKey: string,
  baseUrl?: string,
  connectionName?: string,
): Promise<CredentialMeta> {
  const res = await fetch("/api/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, label, apiKey, baseUrl, connectionName }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Failed to save connection (${res.status})`);
  return data;
}

export async function deleteCredential(id: string): Promise<void> {
  await fetch(`/api/credentials/${id}`, { method: "DELETE" });
}

/** Asks the endpoint behind a saved connection for its own model list. Takes the credential
 * id, never a base URL + key, so the raw key stays server-side. Throws on any failure -
 * discovery is best-effort and every caller falls back to a free-text model field. */
export async function fetchDiscoveredModels(credentialId: string): Promise<ModelDiscoveryResult> {
  const res = await fetch(`/api/credentials/${credentialId}/models`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Model discovery failed (${res.status})`);
  return data;
}

/** POST because this probes loopback ports on the user's own machine - it must only ever run
 * because they pressed the button, never on mount or in the background. */
export async function scanLocalServers(): Promise<LocalServerFinding[]> {
  const res = await fetch("/api/local/scan", { method: "POST" });
  if (!res.ok) throw new Error(`Scan failed (${res.status})`);
  return res.json();
}

export interface SkillInfo {
  name: string;
  description: string;
  sourcePath: string;
  /** Project paths (matching ProjectInfo.path) that already have this skill on disk. */
  installedIn: string[];
}

export async function fetchSkills(): Promise<{ projects: ProjectInfo[]; skills: SkillInfo[] }> {
  return fetch("/api/skills").then((r) => r.json());
}

export async function installSkill(sourcePath: string, projectPath: string): Promise<{ alreadyInstalled: boolean }> {
  const res = await fetch("/api/skills/install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourcePath, projectPath }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Failed to install skill");
  return data;
}

export async function importSkillsRepo(repoUrl: string): Promise<SkillInfo[]> {
  const res = await fetch("/api/skills/import-repo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoUrl }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Failed to import repo");
  return data.skills;
}

export async function sendChatMessage(text: string): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Failed to send (${res.status})`);
}

type Hello = {
  type: "hello";
  history: ChatMessage[];
  agents: AgentConfig[];
  statuses: AgentStatus[];
  approvals: PendingApproval[];
};

/**
 * A dropped connection (server restart, laptop sleep, network blip) used to just go silent
 * forever - the UI looked "connected" but never received another update again. This reconnects
 * with backoff and re-requests a fresh "hello" snapshot every time, so the client is never
 * stuck showing stale state.
 */
export function connectSocket(
  onEvent: (event: ServerEvent | Hello) => void,
  onConnectionChange?: (connected: boolean) => void,
): () => void {
  let socket: WebSocket | null = null;
  let stopped = false;
  let retryDelay = 1000;
  let retryHandle: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (stopped) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(`${proto}://${location.host}/ws`);

    socket.onopen = () => {
      retryDelay = 1000;
      onConnectionChange?.(true);
    };
    socket.onmessage = (msg) => {
      onEvent(JSON.parse(msg.data));
    };
    socket.onclose = () => {
      onConnectionChange?.(false);
      if (stopped) return;
      retryHandle = setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 15000);
    };
    socket.onerror = () => {
      socket?.close();
    };
  };

  connect();

  return () => {
    stopped = true;
    if (retryHandle) clearTimeout(retryHandle);
    socket?.close();
  };
}

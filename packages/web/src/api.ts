import type {
  AgentConfig,
  AgentStatus,
  ChatMessage,
  ProviderId,
  ProviderModelInfo,
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
  patch: Partial<Pick<AgentConfig, "trustLevel" | "currentTask" | "model" | "effort">>,
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

export async function fetchAgentDirectHistory(agentId: string): Promise<ChatMessage[]> {
  return fetch(`/api/agents/${agentId}/chat`).then((r) => r.json());
}

export async function sendAgentDirectMessage(agentId: string, text: string): Promise<void> {
  await fetch(`/api/agents/${agentId}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

export async function testProviderConnection(provider: ProviderId): Promise<{ ok: boolean; message: string }> {
  return fetch(`/api/providers/${provider}/test`, { method: "POST" }).then((r) => r.json());
}

export async function sendChatMessage(text: string): Promise<void> {
  await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

type Hello = { type: "hello"; history: ChatMessage[]; agents: AgentConfig[]; statuses: AgentStatus[] };

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

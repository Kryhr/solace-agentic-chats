import type { AgentConfig, AgentStatus, ChatMessage, ServerEvent } from "@solace/shared";

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

export async function updateAgent(id: string, patch: Partial<Pick<AgentConfig, "trustLevel" | "currentTask">>): Promise<void> {
  await fetch(`/api/agents/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export async function sendChatMessage(text: string): Promise<void> {
  await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

type Hello = { type: "hello"; history: ChatMessage[]; agents: AgentConfig[]; statuses: AgentStatus[] };

export function connectSocket(onEvent: (event: ServerEvent | Hello) => void): () => void {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${proto}://${location.host}/ws`);
  socket.onmessage = (msg) => {
    onEvent(JSON.parse(msg.data));
  };
  return () => socket.close();
}

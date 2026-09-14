// Shared types used by both the server and the web UI.
// Keep this package dependency-free so it can be imported from either side.

export type ProviderId = "claude-code" | "codex-cli" | "gemini-cli" | "qwen-code" | "custom";

/**
 * How much an agent is allowed to do without a human clicking "approve" first.
 * Maps directly onto each CLI's own permission flags (e.g. Claude Code's
 * --allowedTools / --dangerously-skip-permissions).
 */
export type TrustLevel = "confirm-all" | "confirm-risky" | "auto-approve";

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
}

export interface AgentStatus {
  agentId: string;
  state: AgentRunState;
  currentTask?: string;
  lastActivityAt: string;
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
  | { type: "chat:message"; payload: ChatMessage }
  | { type: "approval:requested"; payload: PendingApproval }
  | { type: "approval:resolved"; payload: { id: string; approved: boolean } };

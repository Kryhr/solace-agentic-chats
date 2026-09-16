import type { AgentConfig, ChatMeta, ProjectMeta } from "@solace/shared";

/**
 * Is this agent working inside this project's directory?
 *
 * The client mirrors the server's rule (server/core/chatStore.ts#agentInProject) rather than
 * asking for a membership list, because the sidebar has to filter on every keystroke of a
 * project switch and the answer is derivable from data it already holds. The two must agree -
 * if this ever diverges, the sidebar would show an agent a message in that chat cannot reach.
 *
 * Windows-first: paths are compared case-insensitively with separators normalised, and with a
 * trailing separator so project "site" does not claim agents working in "site2".
 */
export function agentInProject(cwd: string, projectPath: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase() + "/";
  const a = norm(cwd);
  const b = norm(projectPath);
  return a === b || a.startsWith(b);
}

/**
 * The agents a project scopes to. No project selected means the whole roster.
 *
 * `follow` mirrors the server's agentsFollowProjects setting (server/core/chatStore.ts
 * #agentsForChat): when agents follow the user, every agent is in every project except the ones
 * explicitly removed from this one. This MUST agree with the server - if it diverges, the
 * sidebar shows an agent that a message in that chat cannot actually reach, or hides one it can.
 */
export function agentsInScope(
  agents: AgentConfig[],
  project: ProjectMeta | undefined,
  follow = true,
): AgentConfig[] {
  if (!project) return agents;
  if (follow) {
    const excluded = new Set(project.excludedAgentIds ?? []);
    return agents.filter((a) => !excluded.has(a.id));
  }
  return agents.filter((a) => agentInProject(a.cwd, project.path));
}

/** The chats a project scopes to. No project selected means every chat, filed or not. */
export function chatsInScope(chats: ChatMeta[], project: ProjectMeta | undefined): ChatMeta[] {
  if (!project) return chats;
  return chats.filter((c) => c.projectId === project.id);
}

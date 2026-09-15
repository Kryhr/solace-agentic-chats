import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { nanoid } from "nanoid";
import { LEGACY_CHAT_ID, type AgentConfig, type ChatMeta, type ProjectMeta } from "@solace/shared";
import { createProject, listProjects } from "./workspace";

/**
 * Is `cwd` inside `projectPath`? Compared on resolved, case-folded paths with a trailing
 * separator, because this is Windows-first: the same folder legitimately arrives as
 * "C:\Users\x\Desktop\solace-workspace\site" from one place and "c:/Users/x/.../site" from
 * another, and the "/site2" prefix trap is real - without the separator, project "site" would
 * claim every agent working in "site2".
 */
function normalizeDir(p: string): string {
  return resolve(p).toLowerCase().replace(/[\\/]+$/, "") + sep;
}

export function agentInProject(cwd: string, projectPath: string): boolean {
  const a = normalizeDir(cwd);
  const b = normalizeDir(projectPath);
  return a === b || a.startsWith(b);
}

/**
 * Do two agents run their CLIs in the same directory? The same normalisation agentInProject
 * uses (resolved, case-folded, trailing separator), but equality rather than containment - an
 * agent working in a SUBDIRECTORY of another's cwd is not a substitute for it.
 *
 * This is the one gate on handing one agent's work to another (see AgentManager's handover):
 * an agent's cwd is where its CLI genuinely runs, so passing "fix the build" to an agent
 * pointed somewhere else produces confident work on the wrong codebase.
 */
export function sameWorkingDirectory(a: string, b: string): boolean {
  return normalizeDir(a) === normalizeDir(b);
}

/**
 * The set of chats and the set of projects, and the rules for who belongs to what.
 *
 * Deliberately does NOT own messages - those stay in ChatBus, keyed by channel - so deleting a
 * chat here is a bookkeeping change and the archive/never-delete pattern used by /clear and
 * agent removal stays the only thing that touches transcripts.
 */
export class ChatStore {
  private chats: ChatMeta[];
  private projects: ProjectMeta[];

  /** Set by index.ts, to persist and to broadcast the new roster. */
  onChange: (() => void) | null = null;

  constructor(chats: ChatMeta[] = [], projects: ProjectMeta[] = []) {
    this.chats = chats;
    this.projects = projects;
  }

  listChats(): ChatMeta[] {
    return this.chats;
  }

  listProjects(): ProjectMeta[] {
    return this.projects;
  }

  getChat(id: string): ChatMeta | undefined {
    return this.chats.find((c) => c.id === id);
  }

  /** The name a chat is filed under in Saved chats. Resolved at archive time, never live. */
  chatLabel(id: string): string {
    return this.getChat(id)?.title ?? "a deleted chat";
  }

  createChat(title?: string, projectId?: string): ChatMeta {
    const chat: ChatMeta = {
      id: nanoid(),
      title: (title ?? "").trim() || "New chat",
      createdAt: new Date().toISOString(),
      // An id for a project that no longer exists would render as a chat filed nowhere visible,
      // so an unknown one is dropped rather than stored.
      projectId: projectId && this.projects.some((p) => p.id === projectId) ? projectId : undefined,
    };
    this.chats.push(chat);
    this.onChange?.();
    return chat;
  }

  /** Returns false for an unknown id, so a route can 404 instead of silently reporting success. */
  updateChat(id: string, patch: { title?: string; projectId?: string | null }): boolean {
    const chat = this.getChat(id);
    if (!chat) return false;
    if (patch.title !== undefined) {
      const trimmed = patch.title.trim();
      // An empty title would leave an unclickable blank row in the sidebar; keep the old one.
      if (trimmed) chat.title = trimmed;
    }
    if (patch.projectId !== undefined) {
      chat.projectId =
        patch.projectId && this.projects.some((p) => p.id === patch.projectId) ? patch.projectId : undefined;
    }
    this.onChange?.();
    return true;
  }

  removeChat(id: string): ChatMeta | undefined {
    const chat = this.getChat(id);
    if (!chat) return undefined;
    this.chats = this.chats.filter((c) => c.id !== id);
    this.onChange?.();
    return chat;
  }

  /**
   * Adopt a project. The directory is created through core/workspace.ts's createProject - the
   * same path the Add-agent modal has always used - rather than a second mkdir here, so there
   * is exactly one place that decides what a legal project name is and where projects live.
   * An existing folder is linked as-is: the user pointing Solace at work they already started
   * must not be an error.
   */
  linkProject(name: string): ProjectMeta {
    const trimmed = name.trim();
    const existingLink = this.projects.find((p) => p.name.toLowerCase() === trimmed.toLowerCase());
    if (existingLink) return existingLink;
    const onDisk = listProjects().find((p) => p.name.toLowerCase() === trimmed.toLowerCase());
    const info = onDisk ?? createProject(trimmed);
    const project: ProjectMeta = { id: nanoid(), name: info.name, path: info.path, createdAt: new Date().toISOString() };
    this.projects.push(project);
    this.onChange?.();
    return project;
  }

  /**
   * Unlink a project. Nothing on disk is touched - not the folder, not a file in it - and the
   * chats filed under it become unfiled rather than disappearing with it. Agents are untouched
   * too: an agent's cwd is where its CLI actually runs, and rewriting that because a label was
   * removed would silently move somebody's work.
   */
  unlinkProject(id: string): ProjectMeta | undefined {
    const project = this.projects.find((p) => p.id === id);
    if (!project) return undefined;
    this.projects = this.projects.filter((p) => p.id !== id);
    for (const chat of this.chats) {
      if (chat.projectId === id) chat.projectId = undefined;
    }
    this.onChange?.();
    return project;
  }

  /**
   * Which agents a message in this chat actually reaches.
   *
   * An unfiled chat reaches everyone, which is what the single group chat always did. A chat
   * filed under a project reaches only the agents whose cwd is inside that project's directory,
   * because an agent pointed at project A cannot do project B's work: it would read and edit the
   * wrong files while sounding perfectly confident about it.
   */
  agentsForChat(chatId: string, agents: AgentConfig[]): AgentConfig[] {
    const chat = this.getChat(chatId);
    if (!chat?.projectId) return agents;
    const project = this.projects.find((p) => p.id === chat.projectId);
    // A project whose folder has been moved or unmounted must not silently mean "nobody",
    // which would look exactly like agents ignoring the user.
    if (!project || !existsSync(project.path)) return agents;
    return agents.filter((a) => agentInProject(a.cwd, project.path));
  }

  /**
   * The chat a turn posts into when it has no chat of its own - i.e. a turn that was started
   * from an agent's own hub, where post_to_group still has to reach somewhere real. Prefers a
   * chat in that agent's own project, then the oldest chat overall. Deterministic on purpose:
   * "whichever chat happened to be open" would put an agent's announcement somewhere the user
   * cannot predict.
   */
  defaultChatIdFor(agent: AgentConfig | undefined): string | undefined {
    if (this.chats.length === 0) return undefined;
    if (agent) {
      const project = this.projects.find((p) => agentInProject(agent.cwd, p.path));
      const inProject = project && this.chats.find((c) => c.projectId === project.id);
      if (inProject) return inProject.id;
    }
    return this.chats[0].id;
  }
}

export { LEGACY_CHAT_ID };

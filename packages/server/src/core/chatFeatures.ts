/**
 * The seams between the v1.5 commands and the three subsystems being built alongside them.
 *
 * The task board (ROADMAP 3), the port/server registry (4) and message classes + scope (1) are
 * each landing on their own branch. The commands that drive them are in this one. Rather than
 * wait, each command is written against the smallest interface that expresses what it needs,
 * and `index.ts` passes the real implementation in the day it merges - one line per subsystem.
 *
 * THE RULE, which is the entire point of this file existing rather than the commands quietly
 * doing nothing: a command whose backend is not wired up SAYS SO, by name, when you run it. It
 * does not print an empty list. "No tasks on the board" and "the task board isn't running here"
 * are completely different statements and must never render identically - that is the same
 * mistake /board already carries a comment about, and this is the generalisation of it.
 */

/** One row of the task board. Whatever the implementation stores, these are the fields the
 * commands render, so the sibling module can hold more without changing anything here. */
export interface BoardTask {
  id: string;
  description: string;
  /** The agent handle that owns it, or undefined once /unassign has taken it off someone. */
  owner?: string;
  status: "open" | "done";
  /** Files the task is known to touch, when the board tracks them. */
  files?: string[];
}

/** What /assign, /tasks, /done and /unassign need from ROADMAP step 3. */
export interface TaskBoardApi {
  assign(chatId: string, ownerHandle: string, description: string): BoardTask;
  list(chatId: string): BoardTask[];
  /** False when no task with that id is on this chat's board. */
  finish(chatId: string, taskId: string): boolean;
  unassign(chatId: string, taskId: string): boolean;
}

/** One server an agent started and this app kept alive past the turn. */
export interface RegisteredServer {
  id: string;
  /** The agent handle that started it. */
  handle: string;
  port: number;
  /** The command it was started with, verbatim. */
  command?: string;
  /** Result of a REAL check, or undefined when it has not been checked - never assumed true.
   * See ConnectionCheck in shared for why absence and false are different states. */
  listening?: boolean;
  checkedAt?: string;
}

/** One port reservation. */
export interface ReservedPort {
  port: number;
  handle: string;
  reservedAt: string;
}

/** What /servers and /ports need from ROADMAP step 4. */
export interface ServerRegistryApi {
  listServers(): RegisteredServer[];
  listPorts(): ReservedPort[];
  /** False when nothing is registered under that id. */
  kill(id: string): Promise<boolean>;
}

/** What /only, /all, /quiet and /loud need from ROADMAP step 1. Scope today is INFERRED from
 * the @mentions on the operator's most recent message (agentManager.operatorScope), which works
 * but is invisible: there is no way to see the current scope and no way to set it without
 * addressing somebody. These make it explicit and readable. */
export interface ChatScopeApi {
  /** Handles this chat is currently scoped to, or undefined when it is unscoped. */
  scopeFor(chatId: string): string[] | undefined;
  setScope(chatId: string, handles: string[]): void;
  clearScope(chatId: string): void;
  /** Where "status" class messages go for this chat. */
  statusRouting(chatId: string): "group" | "hub";
  setStatusRouting(chatId: string, where: "group" | "hub"): void;
}

/** Everything the commands may be handed, all optional, all absent until their branch merges. */
export interface ChatFeatures {
  tasks?: TaskBoardApi;
  servers?: ServerRegistryApi;
  scope?: ChatScopeApi;
}

/**
 * The sentence a command prints when its backend is not here yet.
 *
 * Deliberately names the subsystem and says plainly that nothing happened, so it can never be
 * mistaken for a result. `what` is what the user was trying to do, in their words.
 */
export function notWiredYet(subsystem: string, what: string): string {
  return (
    `The ${subsystem} isn't running in this build yet, so ${what} did nothing - nothing was recorded and ` +
    `nothing was sent. This command is wired up and waiting on that module; it will start working the ` +
    `moment it lands, with no change here.`
  );
}

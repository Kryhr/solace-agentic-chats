import type { AgentConfig, Task } from "@solace/shared";
import { canStart, effectiveStatus, openTasks, unknownDependencies, unmetDependencies } from "@solace/shared";

/**
 * The task board, one per chat - the same scoping rule as CoordinationBoard, for the same
 * reason: two chats about one folder are two separate pieces of work, and inheriting one's
 * tasks into the other would be wrong in both directions.
 *
 * Pure bookkeeping. Nothing here spawns a turn, posts a message or touches a file: what to do
 * with a wake-up, a conflict or a finished task is AgentManager's decision, and keeping that
 * out of here is what makes every rule below testable without a provider process.
 *
 * The rules this class actually enforces, each one replacing a paragraph that was previously
 * negotiated in the chat and then not kept:
 *
 *  - a task cannot be claimed twice (the duplicate-landing-page failure, as state)
 *  - a claimed task whose dependencies are unfinished does NOT start; its owner waits
 *  - finishing a task names exactly who was waiting on it, so the wake is not a guess
 */
export class TaskBoard {
  private byChat = new Map<string, Task[]>();

  /** Set by index.ts, to persist. Same contract as CoordinationBoard.onChange. */
  onChange: (() => void) | null = null;

  constructor(initial: Record<string, Task[]> = {}) {
    for (const [chatId, tasks] of Object.entries(initial ?? {})) {
      if (Array.isArray(tasks)) this.byChat.set(chatId, tasks.map(sanitizeTask).filter((t): t is Task => t !== null));
    }
  }

  private list(chatId: string): Task[] {
    let tasks = this.byChat.get(chatId);
    if (!tasks) {
      tasks = [];
      this.byChat.set(chatId, tasks);
    }
    return tasks;
  }

  /** For persistence. Chats with no tasks are omitted rather than stored as empty arrays. */
  snapshot(): Record<string, Task[]> {
    const out: Record<string, Task[]> = {};
    for (const [chatId, tasks] of this.byChat) if (tasks.length > 0) out[chatId] = tasks;
    return out;
  }

  forChat(chatId: string): Task[] {
    return this.list(chatId);
  }

  find(chatId: string, taskId: string): Task | undefined {
    const wanted = taskId.trim().toLowerCase();
    return this.list(chatId).find((t) => t.id.toLowerCase() === wanted);
  }

  /**
   * A deleted agent's claimed tasks go back on the board rather than staying owned by nobody.
   *
   * Finished tasks keep their owner: the board is also a record of what happened, and erasing
   * who did a thing because they were later removed would make it a worse record than the
   * prose it replaced.
   */
  forgetAgent(agentId: string): void {
    let changed = false;
    for (const tasks of this.byChat.values()) {
      for (const task of tasks) {
        if (task.ownerId === agentId && task.status === "claimed") {
          task.status = "open";
          task.ownerId = undefined;
          task.ownerHandle = undefined;
          task.claimedAt = undefined;
          changed = true;
        }
      }
    }
    if (changed) this.onChange?.();
  }

  // -------------------------------------------------------------------------------------
  // Creating
  // -------------------------------------------------------------------------------------

  /**
   * Add a task. Ids are "T1", "T2", ... per chat - short enough that an agent will type one
   * into claim_task and quote one in a sentence, which a nanoid would not be.
   *
   * The next number is taken from the highest id ever issued in this chat, not from the count,
   * so a deleted or finished task never lets a new one reuse its id. An id that has been said
   * out loud in the chat must not later mean something else.
   */
  create(
    chatId: string,
    createdBy: string,
    input: { title: string; dependsOn?: string[]; files?: string[] },
  ): { ok: false; error: string } | { ok: true; task: Task; unknownDeps: string[] } {
    const title = input.title?.trim() ?? "";
    if (!title) return { ok: false, error: "a task needs a title - one line saying what is to be done" };
    const tasks = this.list(chatId);
    const highest = tasks.reduce((max, t) => Math.max(max, Number(t.id.replace(/^T/i, "")) || 0), 0);
    const task: Task = {
      id: `T${highest + 1}`,
      title,
      status: "open",
      // Normalised to the board's own spelling so "t1" and "T1" are one dependency, not two.
      // Normalised BEFORE de-duplicating, not after: dedupe-then-normalise lets "t1" and "T1"
      // through as two entries that then both become "T1", and a task would wait on the same
      // dependency twice.
      dependsOn: [...new Set((input.dependsOn ?? []).map((d) => normalizeTaskId(d)).filter(Boolean))],
      files: [...new Set((input.files ?? []).map((f) => f.trim()).filter(Boolean))],
      createdBy,
      createdAt: new Date().toISOString(),
    };
    tasks.push(task);
    this.onChange?.();
    // Reported, not dropped: a dependency on an id that does not exist is a real statement
    // about what the author believed, and silently discarding it turns a typo into a task that
    // looks ready to start.
    return { ok: true, task, unknownDeps: unknownDependencies(task, tasks) };
  }

  // -------------------------------------------------------------------------------------
  // Claiming
  // -------------------------------------------------------------------------------------

  /**
   * Take ownership of a task.
   *
   * Refused outright if somebody else already holds it. This is the one rule the whole board
   * exists for: "two agents building the same landing page twice" is what "announce what you
   * are taking" being advice rather than state actually costs.
   *
   * A claim on a task with unfinished dependencies SUCCEEDS but does not start: the claimant
   * owns it (so nobody else takes it meanwhile) and is handed the dependency it must wait for.
   * The caller turns that into a block, so the owner is woken the moment it lands. Refusing the
   * claim instead would leave the task unowned and the dependent work unassigned - which is how
   * an agent ends up waiting for something nobody is doing.
   */
  claim(
    chatId: string,
    agent: AgentConfig,
    taskId: string,
  ):
    | { ok: false; error: string; task?: Task }
    | { ok: true; task: Task; waitingOn: Task[] } {
    const tasks = this.list(chatId);
    const task = this.find(chatId, taskId);
    if (!task) {
      const open = openTasks(tasks).map((t) => t.id);
      return {
        ok: false,
        error: open.length
          ? `no task "${taskId}" in this chat. Open tasks: ${open.join(", ")}`
          : `no task "${taskId}" in this chat, and the board is empty - create_task first`,
      };
    }
    if (task.status === "done") {
      return { ok: false, error: `${task.id} is already finished (by @${task.ownerHandle ?? "someone"})`, task };
    }
    if (task.status === "claimed" && task.ownerId !== agent.id) {
      return {
        ok: false,
        error: `${task.id} is already owned by @${task.ownerHandle}. Do not build it a second time - @mention them if you think it should move.`,
        task,
      };
    }

    task.status = "claimed";
    task.ownerId = agent.id;
    task.ownerHandle = agent.handle;
    task.claimedAt = task.claimedAt ?? new Date().toISOString();
    this.onChange?.();
    return { ok: true, task, waitingOn: unmetDependencies(task, tasks) };
  }

  // -------------------------------------------------------------------------------------
  // Finishing
  // -------------------------------------------------------------------------------------

  /**
   * Mark a task done, and say exactly which tasks that unblocks and who owns them.
   *
   * Returning the dependents rather than just a boolean is the point: the live failure this
   * replaces was an agent sitting idle AFTER the thing it waited for had landed, because the
   * agent that landed it did not think to name them. Here nobody has to think of it.
   */
  finish(
    chatId: string,
    agent: AgentConfig,
    taskId: string,
    result?: string,
  ): { ok: false; error: string } | { ok: true; task: Task; unblocked: Task[] } {
    const tasks = this.list(chatId);
    const task = this.find(chatId, taskId);
    if (!task) return { ok: false, error: `no task "${taskId}" in this chat` };
    if (task.status === "done") return { ok: false, error: `${task.id} was already finished` };
    // Deliberately permissive about WHO finishes it - an unclaimed task somebody did anyway is
    // still done, and refusing here would leave the board lying about the work. It records who
    // actually finished it, which is the fact that matters.
    task.status = "done";
    task.doneAt = new Date().toISOString();
    task.ownerId = task.ownerId ?? agent.id;
    task.ownerHandle = task.ownerHandle ?? agent.handle;
    if (result?.trim()) task.result = result.trim();

    // Only tasks somebody is actually waiting on. An unclaimed dependent has no owner to wake,
    // and waking nobody is not an event.
    const unblocked = tasks.filter(
      (t) => t.status === "claimed" && t.dependsOn.includes(task.id) && canStart(t, tasks),
    );
    this.onChange?.();
    return { ok: true, task, unblocked };
  }

  // -------------------------------------------------------------------------------------
  // Context
  // -------------------------------------------------------------------------------------

  /** One line per open task, for the group-context block. See buildTaskContextBlock. */
  contextBlock(chatId: string, self: AgentConfig): string {
    return buildTaskContextBlock(this.list(chatId), self.id);
  }
}

/** Ids are compared and stored in one spelling, so "t1" and "T1" are one dependency. */
function normalizeTaskId(id: string): string {
  const n = Number(id.trim().replace(/^[tT]/, ""));
  return Number.isFinite(n) && n > 0 ? `T${n}` : id.trim();
}

/** A hand-edited or older state file must not crash the board on load. Anything without the two
 * fields that make a task addressable is dropped; everything else is filled in. */
function sanitizeTask(raw: unknown): Task | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Partial<Task>;
  if (typeof t.id !== "string" || !t.id.trim() || typeof t.title !== "string") return null;
  return {
    id: t.id,
    title: t.title,
    ownerId: typeof t.ownerId === "string" ? t.ownerId : undefined,
    ownerHandle: typeof t.ownerHandle === "string" ? t.ownerHandle : undefined,
    status: t.status === "claimed" || t.status === "done" ? t.status : "open",
    dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.filter((d): d is string => typeof d === "string") : [],
    files: Array.isArray(t.files) ? t.files.filter((f): f is string => typeof f === "string") : [],
    createdBy: typeof t.createdBy === "string" ? t.createdBy : "unknown",
    createdAt: typeof t.createdAt === "string" ? t.createdAt : new Date(0).toISOString(),
    claimedAt: typeof t.claimedAt === "string" ? t.claimedAt : undefined,
    doneAt: typeof t.doneAt === "string" ? t.doneAt : undefined,
    result: typeof t.result === "string" ? t.result : undefined,
  };
}

/**
 * THE SIZE RULE, and why it is a hard cap rather than a guideline.
 *
 * Codex and Copilot take their whole prompt on argv, and Windows caps a command line at
 * ~32,764 characters. This repo has already had every Codex and Copilot turn die outright with
 * `spawn ENAMETOOLONG` from an over-large context block - the skills catalogue, which is now a
 * pointer to a file for exactly this reason. A task board grows with the work, so it is the
 * next thing that would do it, and "we'll keep it short" is not a mechanism.
 *
 * So: a pointer plus one line per open task, truncated to a fixed budget, never a dump. The
 * lines are a summary that tells an agent what exists and what is taken; list_tasks is where
 * the files, the full titles and the finished tasks live.
 */
export const TASK_BLOCK_MAX_CHARS = 1100;
/** Beyond this many lines the block stops being read anyway - the rest become a count. */
export const TASK_BLOCK_MAX_LINES = 10;
const TITLE_MAX = 56;

export function buildTaskContextBlock(all: Task[], selfAgentId: string): string {
  const open = openTasks(all);
  if (open.length === 0) return "";

  // Yours first, then unowned work, then everybody else's - so the two things that change what
  // this agent does next survive the truncation, and the roster of what other people are busy
  // with is what gets cut.
  const rank = (t: Task) => (t.ownerId === selfAgentId ? 0 : t.status === "open" ? 1 : 2);
  const ordered = [...open].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id, undefined, { numeric: true }));

  const lines: string[] = [];
  let used = 0;
  for (const task of ordered) {
    if (lines.length >= TASK_BLOCK_MAX_LINES) break;
    const line = taskLine(task, all, selfAgentId);
    if (used + line.length + 3 > TASK_BLOCK_MAX_CHARS) break;
    lines.push(line);
    used += line.length + 3;
  }
  const hidden = open.length - lines.length;

  return (
    ` Task board, ${open.length} open: ` +
    lines.join(" | ") +
    (hidden > 0 ? ` | +${hidden} more` : "") +
    `. Claim before you build: claim_task("T1"). If what you are about to do is not on this board, ` +
    `create_task it first - an unclaimed lane is how the same thing gets built twice. list_tasks gives ` +
    `files and dependencies; finish_task wakes whoever is waiting on you.`
  );
}

/** One task, one line, no wrapping and no nesting. */
function taskLine(task: Task, all: Task[], selfAgentId: string): string {
  const status = effectiveStatus(task, all);
  const title = task.title.replace(/\s+/g, " ").slice(0, TITLE_MAX);
  const who = task.ownerId === selfAgentId ? "yours" : task.ownerHandle ? `@${task.ownerHandle}` : "unclaimed";
  const waiting =
    status === "blocked" ? ` waiting on ${unmetDependencies(task, all).map((d) => d.id).join(",")}` : "";
  return `${task.id} ${who}${waiting}: ${title}`;
}

/**
 * The task board: who owns what, what it depends on, and which files it covers - as state,
 * not as paragraphs.
 *
 * Measured across 28 real chats: coordination happened in prose. Two agents built the same
 * landing page twice; two fought over one port; one asked "what products did you come up
 * with?" after the answer had already been posted. The claims/contracts/blocks board existed
 * and was barely used, because nothing made it the path of least resistance.
 *
 * `/task` before this set a free-text string on an agent - a label somebody typed once, that
 * nothing afterwards kept true. Everything here is the opposite: each field is something the
 * system itself checks, updates, or refuses.
 *
 * Three deliberate shapes:
 *
 *  - `status` on disk has three values, not four. "blocked" is DERIVED from whether this
 *    task's dependencies are actually done (see effectiveStatus), because a stored "blocked"
 *    is exactly the kind of label that goes stale the moment the dependency lands - which is
 *    the failure this whole file exists to remove.
 *  - `dependsOn` holds task ids, not prose. A dependency an agent has to read and interpret
 *    is a dependency the system cannot wake anybody for.
 *  - `files` is the bridge to the file-claim board. Claiming a task claims its files, so
 *    "I'll take the landing page" stops being an assertion and starts being a lane.
 */

/** What is stored. "blocked" is never written - see effectiveStatus. */
export type TaskStatus = "open" | "claimed" | "done";

/** What is shown and reasoned about, derived per read. */
export type EffectiveTaskStatus = TaskStatus | "blocked";

export interface Task {
  /** Short and quotable - "T1", "T3" - because agents pass it to each other in sentences and
   * type it into claim_task. A nanoid would be correct and unusable. Unique per chat. */
  id: string;
  title: string;
  /** Unset while the task is open. Set on claim, and kept after it is done so the board still
   * says who did it. */
  ownerId?: string;
  ownerHandle?: string;
  status: TaskStatus;
  /** Task ids in the same chat. An id that does not exist is kept rather than dropped: it is
   * a real statement about what the author believed, and silently discarding it would turn a
   * typo into a task that looks ready to start. It is reported as unknown instead. */
  dependsOn: string[];
  /** Paths this task covers, in the claimant's working directory. */
  files: string[];
  /** Who created it: an agent handle, or "operator". */
  createdBy: string;
  createdAt: string;
  claimedAt?: string;
  doneAt?: string;
  /** One line from whoever finished it, so "done" is not the only thing the board can say. */
  result?: string;
}

/** A task's real status right now, given the rest of the board.
 *
 * Order matters: a done task is done even if something it depended on was later re-opened,
 * and a task nobody has claimed yet is "open" even when its dependencies are unmet - "blocked"
 * is only interesting once somebody is actually waiting to start it. Reading it the other way
 * would fill the context block with tasks that are blocked and unowned, which is just "not
 * started" said in a more alarming way.
 */
export function effectiveStatus(task: Task, all: Task[]): EffectiveTaskStatus {
  if (task.status === "done") return "done";
  if (task.status === "claimed" && unmetDependencies(task, all).length > 0) return "blocked";
  return task.status;
}

/** The dependencies of `task` that are not done yet, as tasks. An id with no matching task is
 * not returned here - it cannot be waited for, so it cannot block. See unknownDependencies. */
export function unmetDependencies(task: Task, all: Task[]): Task[] {
  return task.dependsOn
    .map((id) => all.find((t) => t.id === id))
    .filter((t): t is Task => t !== undefined && t.status !== "done");
}

/** Dependency ids that match no task in this chat - a typo, or a task from another chat. */
export function unknownDependencies(task: Task, all: Task[]): string[] {
  return task.dependsOn.filter((id) => !all.some((t) => t.id === id));
}

/** A task is startable when it is claimed and everything it waits on is done. */
export function canStart(task: Task, all: Task[]): boolean {
  return task.status === "claimed" && unmetDependencies(task, all).length === 0;
}

/** Everything not finished, oldest first - the board's working set. */
export function openTasks(all: Task[]): Task[] {
  return all.filter((t) => t.status !== "done");
}

import { useMemo } from "react";
import type { AgentConfig, Task } from "@solace/shared";
import { effectiveStatus, unmetDependencies } from "@solace/shared";
import { ProviderIcon } from "./ProviderIcon";

/**
 * The task board, above the transcript.
 *
 * Read-only on purpose. A task is claimed and finished by whoever is actually doing it, and a
 * button here that let the operator tick off somebody else's work would put the board straight
 * back to being a label nothing keeps true - which is exactly what `/task` was.
 *
 * So this panel answers three questions the chat used to answer only by being read end to end:
 * who owns what, what is waiting for what, and which files each piece covers.
 *
 * Grouping is carried by spacing, not by boxes or rules: the two live groups (in progress /
 * waiting, then unclaimed) sit closer to their own rows than to each other, and finished work
 * falls away to a single quiet line. Nothing here is a card.
 */
export function TaskBoardPanel({
  tasks,
  agents,
  open,
}: {
  tasks: Task[];
  agents: AgentConfig[];
  /** Collapsed by default: the transcript is the thing being read, and a board that pushes it
   * down on every chat would be worse than no board. */
  open: boolean;
}) {
  const agentByHandle = useMemo(
    () => new Map(agents.map((a) => [a.handle.toLowerCase(), a])),
    [agents],
  );

  const { active, unclaimed, done } = useMemo(() => {
    const live = tasks.filter((t) => t.status !== "done");
    return {
      // Owned work first - it is what is actually happening right now.
      active: live.filter((t) => t.status === "claimed").sort(byId),
      unclaimed: live.filter((t) => t.status === "open").sort(byId),
      done: tasks.filter((t) => t.status === "done").sort(byId),
    };
  }, [tasks]);

  if (!open) return null;

  if (tasks.length === 0) {
    return (
      <div className="task-board">
        <p className="task-board-empty">
          No tasks yet. Agents put work on the board themselves with <code>create_task</code>, and claim it before
          they build — so this fills in as they start, not before.
        </p>
      </div>
    );
  }

  return (
    <div className="task-board">
      {active.length > 0 && (
        <section className="task-group">
          <h3 className="task-group-label">In progress</h3>
          <div className="task-list">
            {active.map((task) => (
              <TaskRow key={task.id} task={task} all={tasks} agentByHandle={agentByHandle} />
            ))}
          </div>
        </section>
      )}

      {unclaimed.length > 0 && (
        <section className="task-group">
          <h3 className="task-group-label">Unclaimed</h3>
          <div className="task-list">
            {unclaimed.map((task) => (
              <TaskRow key={task.id} task={task} all={tasks} agentByHandle={agentByHandle} />
            ))}
          </div>
        </section>
      )}

      {done.length > 0 && (
        <section className="task-group">
          <h3 className="task-group-label">Done</h3>
          <div className="task-list">
            {done.map((task) => (
              <TaskRow key={task.id} task={task} all={tasks} agentByHandle={agentByHandle} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function byId(a: Task, b: Task): number {
  return a.id.localeCompare(b.id, undefined, { numeric: true });
}

function TaskRow({
  task,
  all,
  agentByHandle,
}: {
  task: Task;
  all: Task[];
  agentByHandle: Map<string, AgentConfig>;
}) {
  const status = effectiveStatus(task, all);
  const waiting = status === "blocked" ? unmetDependencies(task, all) : [];
  const owner = task.ownerHandle ? agentByHandle.get(task.ownerHandle.toLowerCase()) : undefined;

  return (
    <div className={`task-row task-row-${status}`}>
      <span className="task-id">{task.id}</span>
      <div className="task-main">
        <div className="task-title-row">
          <span className="task-title">{task.title}</span>
          {task.ownerHandle ? (
            <span className="task-owner">
              {owner && <ProviderIcon provider={owner.provider} />}@{task.ownerHandle}
            </span>
          ) : (
            <span className="task-owner task-owner-none">unclaimed</span>
          )}
        </div>

        {/* One meta line, or none. Every part of it is a fact the chat used to carry in prose:
            what this is waiting for, what it covers, and what came of it. */}
        {(waiting.length > 0 || task.dependsOn.length > 0 || task.files.length > 0 || task.result) && (
          <div className="task-meta">
            {waiting.length > 0 ? (
              <span className="task-waiting">
                waiting on {waiting.map((d) => d.id).join(", ")}
              </span>
            ) : (
              task.dependsOn.length > 0 && <span>after {task.dependsOn.join(", ")}</span>
            )}
            {task.files.length > 0 && (
              <span className="task-files" title={task.files.join("\n")}>
                {task.files.join(" · ")}
              </span>
            )}
            {task.result && <span className="task-result">{task.result}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

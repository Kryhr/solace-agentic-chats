import type { AgentConfig, AgentStatus, ChatMessage } from "@solace/shared";

/**
 * Which agents this chat's current work is scoped to, derived exactly as the server derives it.
 *
 * This MIRRORS AgentManager.operatorScope, deliberately and identically: the most recent HUMAN
 * message in the chat defines the scope, and no mentions on it means no scope. It is re-derived
 * here rather than sent down because it is a pure function of history the tab already holds, and
 * because a chip that disagreed with the routing would be worse than no chip - the whole reason
 * the chip exists is that the scope was invisible while being enforced.
 *
 * If the rule on the server changes, this has to change with it. That is the cost of deriving it
 * twice, and it is written down here so it is not discovered later.
 */
export function operatorScope(history: ChatMessage[], agentIds: Set<string>): string[] {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (agentIds.has(m.authorId) || m.authorId === "system") continue;
    return m.mentions;
  }
  return [];
}

/** "3 min", "45 s" - the coarsest unit that still says something useful. Never "0 min". */
export function formatWait(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${Math.max(1, seconds)} s`;
  return `${Math.round(seconds / 60)} min`;
}

/**
 * What the composer says about an agent that cannot answer immediately.
 *
 * Returns undefined when the agent is free - there is nothing to warn about and a permanent
 * "0 queued" strip would be chrome nobody reads.
 *
 * The estimate is appended ONLY when the server actually sent a median, which it does only once
 * the agent has finished at least three turns (see agentManager.medianOf). Before that the line
 * still says the agent is busy and where the message lands in the queue - both facts - and says
 * nothing at all about how long, rather than quoting a number derived from one sample.
 */
export function queueNoticeFor(agent: AgentConfig, status: AgentStatus | undefined): string | undefined {
  if (!status) return undefined;
  const queued = status.queuedTurns ?? 0;
  const busy = status.state === "thinking";
  if (!busy && queued === 0) return undefined;

  // Position is "everything already waiting, plus this message". An agent that is mid-turn with
  // nothing queued answers this message next, which is #1.
  const position = queued + 1;
  const head = busy
    ? `@${agent.handle} is mid-turn — queued #${position}`
    : `@${agent.handle} has ${queued} turn${queued === 1 ? "" : "s"} waiting — queued #${position}`;

  if (status.medianTurnMs === undefined) return head;
  // position turns have to finish before this one is answered, at that agent's own median.
  return `${head}, ~${formatWait(status.medianTurnMs * position)}`;
}

/**
 * When an agent is rate-limited until, as an ISO time - or undefined.
 *
 * `retryAt` is the only honest source. It is set exclusively when a FAILED turn's error text
 * yielded a real, parseable future reset time and a retry was genuinely scheduled for it, so it
 * means "this provider told us, in its own words, when this account can work again". Nothing
 * here is derived from a usage percentage: an account at 100% of a window is not necessarily
 * refusing work, and one at 60% may still be refused for a different limit entirely.
 */
export function rateLimitedUntil(status: AgentStatus | undefined): string | undefined {
  return status?.retryAt;
}

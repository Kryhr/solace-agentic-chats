/**
 * Two ways to hold an agent back without removing it from the chat.
 *
 * Both exist because the only tool available today is destructive. An agent that is answering
 * every message in a room where you want two others to talk can be deleted, or left to keep
 * spending real turns - there is nothing in between. Same for an agent you want to stop feeding
 * work to for ten minutes while you look at what it already produced.
 *
 *  - **Muted**: no message is ROUTED to it. Nothing is queued, so nothing is owed. Consulted in
 *    agentManager.routeChatMessage, at the point recipients are chosen.
 *  - **Paused**: messages still queue up; the queue simply does not drain. Consulted in
 *    agentManager.drainQueue. Resuming runs the backlog.
 *
 * The difference matters and the two commands must not be confused: unmuting an agent brings it
 * back with nothing waiting for it, while resuming one immediately spends a real turn for every
 * message that arrived while it was held. Both /mute and /pause say which of the two they did.
 *
 * Deliberately in-memory only. A muted or paused agent is a thing you did for the next few
 * minutes, and an agent that came back silently muted after a server restart would look exactly
 * like the app dropping its messages - which is the failure mode this whole area of the codebase
 * is built to avoid.
 */
export class AgentGate {
  private muted = new Set<string>();
  private paused = new Set<string>();

  /** Set by AgentManager so that resuming actually drains the backlog rather than waiting for
   * the next message to arrive - which for an agent nobody is talking to is never. */
  onResumed: ((agentId: string) => void) | null = null;

  isMuted(agentId: string): boolean {
    return this.muted.has(agentId);
  }

  isPaused(agentId: string): boolean {
    return this.paused.has(agentId);
  }

  /** Returns true when this actually changed something, so the command can say "already muted"
   * rather than reporting an action it did not take. */
  setMuted(agentId: string, muted: boolean): boolean {
    if (muted === this.muted.has(agentId)) return false;
    if (muted) this.muted.add(agentId);
    else this.muted.delete(agentId);
    return true;
  }

  setPaused(agentId: string, paused: boolean): boolean {
    if (paused === this.paused.has(agentId)) return false;
    if (paused) this.paused.add(agentId);
    else {
      this.paused.delete(agentId);
      this.onResumed?.(agentId);
    }
    return true;
  }

  /** An agent being deleted must not leave its id held here: ids are reused by nothing, but a
   * gate that outlives its agent is state nothing can ever clear. */
  forget(agentId: string): void {
    this.muted.delete(agentId);
    this.paused.delete(agentId);
  }

  listMuted(): string[] {
    return [...this.muted];
  }

  listPaused(): string[] {
    return [...this.paused];
  }
}

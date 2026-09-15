import { nanoid } from "nanoid";
import type { PendingApproval } from "@solace/shared";

interface Pending {
  record: PendingApproval;
  resolve: (approved: boolean) => void;
}

/**
 * Holds every approval currently waiting on a human decision. The actual blocking happens in
 * index.ts's POST /internal/approvals handler (called by the per-turn approval bridge script,
 * see approval/bridgeScript.mjs, which the `claude` CLI itself spawns as its
 * --permission-prompt-tool's MCP server) - that handler awaits the Promise this registry hands
 * back, so the whole chain (browser click -> resolve() -> HTTP response -> MCP tool result ->
 * unblocked `claude` subprocess) stays synchronous from the CLI's point of view.
 */
export class ApprovalRegistry {
  private pending = new Map<string, Pending>();

  /** Called by the internal bridge endpoint. Resolves once resolve()/expire() is called for this id. */
  create(agentId: string, description: string): { id: string; wait: Promise<boolean> } {
    const id = nanoid();
    const record: PendingApproval = { id, agentId, description, createdAt: new Date().toISOString() };
    const wait = new Promise<boolean>((resolve) => {
      this.pending.set(id, { record, resolve });
    });
    return { id, wait };
  }

  get(id: string): PendingApproval | undefined {
    return this.pending.get(id)?.record;
  }

  /** Used to seed a freshly (re)connected client's state - this registry is in-memory only,
   * so a server restart (e.g. tsx watch reloading on a source change) wipes it, but a browser
   * tab's own pendingApprovals state doesn't know that and would otherwise go on showing a
   * now-nonexistent approval card forever, with Allow/Deny buttons pointing at an id the
   * server has never heard of. */
  listPending(): PendingApproval[] {
    return [...this.pending.values()].map((entry) => entry.record);
  }

  /** Returns true if an entry was actually resolved (false if it was already gone - expired/unknown). */
  resolve(id: string, approved: boolean): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    entry.resolve(approved);
    return true;
  }

  /** Denies and removes every pending approval for one agent - used when a turn is aborted
   * (timeout/kill) so the UI never shows a zombie approval card for a dead turn. */
  expireForAgent(agentId: string) {
    for (const [id, entry] of this.pending) {
      if (entry.record.agentId === agentId) {
        this.pending.delete(id);
        entry.resolve(false);
      }
    }
  }
}

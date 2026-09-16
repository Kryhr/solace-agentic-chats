import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { nanoid } from "nanoid";
import {
  emptyCoordination,
  pathCoveredBy,
  type AgentConfig,
  type Block,
  type Contract,
  type CoordinationState,
} from "@solace/shared";

/**
 * The coordination board, one per chat.
 *
 * Per chat rather than per project because coordination is a property of the conversation the
 * agents are having: two chats about the same folder are two separate pieces of work, and
 * inheriting one's claims and blocks into the other would be wrong in both directions.
 *
 * Pure bookkeeping plus one filesystem check (a "file" block asks whether the path exists yet).
 * Everything that costs a turn is decided by the caller - see AgentManager.
 */
export class CoordinationBoard {
  private byChat = new Map<string, CoordinationState>();

  /** Set by index.ts, to persist. */
  onChange: (() => void) | null = null;

  constructor(initial: Record<string, CoordinationState> = {}) {
    for (const [chatId, state] of Object.entries(initial ?? {})) {
      this.byChat.set(chatId, { ...emptyCoordination(), ...state });
    }
  }

  private state(chatId: string): CoordinationState {
    let s = this.byChat.get(chatId);
    if (!s) {
      s = emptyCoordination();
      this.byChat.set(chatId, s);
    }
    return s;
  }

  /** For persistence. Chats with an untouched board are omitted rather than stored empty. */
  snapshot(): Record<string, CoordinationState> {
    const out: Record<string, CoordinationState> = {};
    for (const [chatId, s] of this.byChat) {
      if (s.claims.length || s.contracts.length || s.blocks.length || Object.keys(s.announcementsSeen).length) {
        out[chatId] = s;
      }
    }
    return out;
  }

  forChat(chatId: string): CoordinationState {
    return this.state(chatId);
  }

  /** Drop everything an agent owned, for when it is deleted - otherwise its claims would block
   * the remaining agents forever with no way to release them. */
  forgetAgent(agentId: string): void {
    for (const s of this.byChat.values()) {
      s.claims = s.claims.filter((c) => c.agentId !== agentId);
      s.blocks = s.blocks.filter((b) => b.agentId !== agentId);
      s.contracts = s.contracts.filter((c) => c.agentId !== agentId);
      delete s.announcementsSeen[agentId];
    }
    this.onChange?.();
  }

  // -------------------------------------------------------------------------------------
  // File claims
  // -------------------------------------------------------------------------------------

  /**
   * Who else already owns any of these paths.
   *
   * IMPORTANT, and the reason this returns conflicts rather than throwing: for a CLI agent this
   * is ADVISORY. Claude Code, Codex and Copilot write files with their own built-in tools, which
   * this app does not intermediate, so a claim cannot physically stop them - it can only be
   * stated in their context and checked afterwards. For an endpoint agent running this app's own
   * tool loop (agentTools.ts) it IS enforced, because every write goes through us. Calling a
   * claim "enforced" everywhere would be a guarantee this app cannot keep.
   */
  conflictsFor(chatId: string, agentId: string, paths: string[]): Array<{ path: string; owner: string }> {
    const out: Array<{ path: string; owner: string }> = [];
    for (const claim of this.state(chatId).claims) {
      if (claim.agentId === agentId) continue;
      for (const wanted of paths) {
        if (claim.paths.some((owned) => pathCoveredBy(wanted, owned) || pathCoveredBy(owned, wanted))) {
          out.push({ path: wanted, owner: claim.handle });
        }
      }
    }
    return out;
  }

  /** Records the claim for the paths that were actually free, and reports the rest. A partial
   * claim is deliberate: refusing the whole thing over one overlap would leave an agent that
   * asked for ten files and collided on one owning nothing at all. */
  claim(
    chatId: string,
    agent: AgentConfig,
    paths: string[],
    note?: string,
  ): { claimed: string[]; conflicts: Array<{ path: string; owner: string }> } {
    const cleaned = [...new Set(paths.map((p) => p.trim()).filter(Boolean))];
    const conflicts = this.conflictsFor(chatId, agent.id, cleaned);
    const blocked = new Set(conflicts.map((c) => c.path));
    const claimed = cleaned.filter((p) => !blocked.has(p));
    if (claimed.length > 0) {
      const s = this.state(chatId);
      const mine = s.claims.find((c) => c.agentId === agent.id);
      if (mine) {
        mine.paths = [...new Set([...mine.paths, ...claimed])];
        mine.note = note ?? mine.note;
        mine.at = new Date().toISOString();
      } else {
        s.claims.push({ agentId: agent.id, handle: agent.handle, paths: claimed, note, at: new Date().toISOString() });
      }
      this.onChange?.();
    }
    return { claimed, conflicts };
  }

  /** Give up ownership, so a finished agent does not hold a lane nobody else can take over. */
  release(chatId: string, agentId: string, paths?: string[]): number {
    const s = this.state(chatId);
    const mine = s.claims.find((c) => c.agentId === agentId);
    if (!mine) return 0;
    const before = mine.paths.length;
    if (!paths || paths.length === 0) {
      s.claims = s.claims.filter((c) => c.agentId !== agentId);
      this.onChange?.();
      return before;
    }
    mine.paths = mine.paths.filter((owned) => !paths.some((p) => pathCoveredBy(owned, p) || pathCoveredBy(p, owned)));
    if (mine.paths.length === 0) s.claims = s.claims.filter((c) => c.agentId !== agentId);
    this.onChange?.();
    return before - (s.claims.find((c) => c.agentId === agentId)?.paths.length ?? 0);
  }

  // -------------------------------------------------------------------------------------
  // Contracts
  // -------------------------------------------------------------------------------------

  /** Posting the same title again REPLACES the previous one: a contract is the current answer,
   * and keeping both would leave agents building against two versions of it. */
  postContract(chatId: string, agent: AgentConfig, title: string, body: string): Contract {
    const s = this.state(chatId);
    const clean = title.trim();
    s.contracts = s.contracts.filter(
      (c) => !(c.agentId === agent.id && c.title.trim().toLowerCase() === clean.toLowerCase()),
    );
    const contract: Contract = {
      id: nanoid(),
      agentId: agent.id,
      handle: agent.handle,
      title: clean,
      body: body.trim(),
      at: new Date().toISOString(),
    };
    s.contracts.push(contract);
    this.onChange?.();
    return contract;
  }

  // -------------------------------------------------------------------------------------
  // Blocks
  // -------------------------------------------------------------------------------------

  /** One block per agent: an agent waiting on two different things is waiting on whichever
   * arrives first, and keeping a list would mean deciding which one the wake-up is about. */
  blockOn(chatId: string, agent: AgentConfig, kind: Block["kind"], value: string, why?: string): Block {
    const s = this.state(chatId);
    s.blocks = s.blocks.filter((b) => b.agentId !== agent.id);
    const block: Block = {
      agentId: agent.id,
      handle: agent.handle,
      kind,
      value: value.trim(),
      why,
      at: new Date().toISOString(),
    };
    s.blocks.push(block);
    this.onChange?.();
    return block;
  }

  clearBlock(chatId: string, agentId: string): void {
    const s = this.state(chatId);
    const before = s.blocks.length;
    s.blocks = s.blocks.filter((b) => b.agentId !== agentId);
    if (s.blocks.length !== before) this.onChange?.();
  }

  /**
   * Which blocked agents this event has just unblocked, and why - the caller turns each into a
   * real turn. The block is cleared here so one event cannot wake the same agent twice.
   *
   * `cwd` resolves a relative "file" block. A file block whose path is still absent is simply
   * not satisfied; it is never guessed at.
   */
  resolve(
    chatId: string,
    event: { kind: "contract"; title: string; by: string } | { kind: "posted"; by: string } | { kind: "files" },
    cwd: string,
  ): Array<{ block: Block; because: string }> {
    const s = this.state(chatId);
    const woken: Array<{ block: Block; because: string }> = [];

    for (const block of [...s.blocks]) {
      // An agent's own action never unblocks itself - it would wake on its own contract.
      if (event.kind !== "files" && event.by === block.handle) continue;

      let because: string | undefined;
      if (block.kind === "contract" && event.kind === "contract") {
        const want = block.value.toLowerCase();
        const got = event.title.toLowerCase();
        if (!want || got.includes(want) || want.includes(got)) {
          because = `@${event.by} posted the contract "${event.title}"`;
        }
      } else if (block.kind === "agent" && event.kind === "posted") {
        if (block.value.replace(/^@/, "").toLowerCase() === event.by.toLowerCase()) {
          because = `@${event.by} posted to the group`;
        }
      } else if (block.kind === "file") {
        const target = isAbsolute(block.value) ? block.value : resolve(cwd, block.value);
        if (existsSync(target)) because = `${block.value} now exists`;
      }

      if (because) {
        woken.push({ block, because });
        s.blocks = s.blocks.filter((b) => b.agentId !== block.agentId);
      }
    }
    if (woken.length > 0) this.onChange?.();
    return woken;
  }

  // -------------------------------------------------------------------------------------
  // Announcements
  // -------------------------------------------------------------------------------------

  /** The announcements this agent has not been shown yet. The watermark is only committed once
   * they have actually been put in front of it - see markAnnouncementsSeen. */
  unseenAnnouncements<T extends { createdAt: string }>(chatId: string, agentId: string, all: T[]): T[] {
    const seen = this.state(chatId).announcementsSeen[agentId];
    if (!seen) return all;
    const at = Date.parse(seen);
    if (!Number.isFinite(at)) return all;
    return all.filter((a) => Date.parse(a.createdAt) > at);
  }

  markAnnouncementsSeen(chatId: string, agentId: string, upTo: string): void {
    this.state(chatId).announcementsSeen[agentId] = upTo;
    this.onChange?.();
  }
}

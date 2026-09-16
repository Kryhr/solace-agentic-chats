/**
 * The coordination board: the shared, structural half of working together.
 *
 * Four things were repeatedly lost to prose in a real three-agent run, and each one is a type
 * here rather than a convention the agents have to remember:
 *
 *  - A blocked agent went idle and stayed idle after the thing it waited for landed, because
 *    nobody thought to name it. (Block)
 *  - Status updates cost three billed turns each, because an unaddressed message summons
 *    everyone. (announcements - see AnnouncementMeta)
 *  - Lanes were agreed in conversation, so nothing actually stopped two agents editing the
 *    same file. (FileClaim)
 *  - One agent answered "what is the contract?" four times in four different wordings.
 *    (Contract)
 */

/** A declared owner for some files. Advisory for CLI agents, enforced for endpoint agents that
 * run this app's own tool loop - see the honest note on CoordinationBoard.conflictsFor. */
export interface FileClaim {
  agentId: string;
  handle: string;
  /** Workspace-relative or absolute paths, as the agent gave them. Compared normalised. */
  paths: string[];
  note?: string;
  at: string;
}

/** A decision other agents build against, posted once instead of re-explained per question. */
export interface Contract {
  id: string;
  agentId: string;
  handle: string;
  title: string;
  body: string;
  at: string;
}

/** What an agent is waiting for, so the system can wake it instead of a human noticing. */
export interface Block {
  agentId: string;
  handle: string;
  /** "contract" waits for a contract whose title contains `value`; "file" for a path to exist;
   * "agent" for that handle to post anything to the group. */
  kind: "contract" | "file" | "agent";
  value: string;
  why?: string;
  at: string;
}

export interface CoordinationState {
  claims: FileClaim[];
  contracts: Contract[];
  blocks: Block[];
  /** Per agent, the ISO time of the last announcement already folded into its context, so an
   * announcement is shown once rather than re-pasted on every subsequent turn. */
  announcementsSeen: Record<string, string>;
}

export function emptyCoordination(): CoordinationState {
  return { claims: [], contracts: [], blocks: [], announcementsSeen: {} };
}

/** Windows-first path comparison, matching server/core/chatStore.ts: resolved separators, case
 * folded, no trailing separator. Two spellings of one file must not read as two files. */
export function normalizePath(p: string): string {
  return p.trim().replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Does `candidate` fall under `claimed`? Directory claims cover their contents, so claiming
 * "src/checker" owns "src/checker/core.py" - otherwise an agent would have to enumerate every
 * file it intends to create, including ones that do not exist yet.
 */
export function pathCoveredBy(candidate: string, claimed: string): boolean {
  const a = normalizePath(candidate);
  const b = normalizePath(claimed);
  return a === b || a.startsWith(b + "/");
}

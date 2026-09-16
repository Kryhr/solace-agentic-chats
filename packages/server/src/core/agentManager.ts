import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { nanoid } from "nanoid";
import {
  isChatChannel,
  type AgentConfig,
  type AgentRunState,
  type AgentStatus,
  type ChatChannel,
  type ChatMessage,
  type ProviderRateLimit,
  type ToolCallSummary,
  type TurnUsage,
} from "@solace/shared";
import { getAdapter } from "../adapters";
import { ChatBus } from "./chatBus";
import { sameWorkingDirectory, type ChatStore } from "./chatStore";
import { parseMentions } from "./mentions";
import { RateLimitStore } from "./rateLimits";
import { clearCopilotQuotaCache, getCopilotQuota } from "./copilotQuota";
import { CoordinationBoard } from "./coordination";
import { buildSkillsPointer } from "./skills";
import type { Block } from "@solace/shared";
import { SettingsStore } from "./settingsStore";
import type { ApprovalRegistry } from "./approvalRegistry";
import { extractLiveClaims, findUnreachableClaims, unreachableClaimNotice } from "./claimCheck";
import { getCredentialSecrets, listSecretValues } from "./credentials";
import type { PersistedAgentSession } from "./persistence";
import { classifyIncoming, type IncomingKind } from "./turnIntent";
import { describeToolCall } from "./toolLabel";
import { WORKSPACE_ROOT } from "./workspace";

export interface QueuedTurn {
  /** Stable identity for this piece of work, assigned once at enqueue and preserved across a
   * restart. Needed because the same turn object is referenced from two places at once
   * (`queue`, for durability and ordering, and `pendingInbound`, for cooperative delivery) and
   * delivering it in one must remove it from the other - matching on prompt text would
   * mis-match two identical messages from the same agent. */
  id: string;
  prompt: string;
  replyChannel: ChatChannel;
  /** How many agent-to-agent @mention hops led to this turn (0 for a human-triggered turn).
   * Two agents can legitimately keep mentioning each other back and forth; this caps that
   * chain instead of letting it run forever - see MAX_MENTION_CHAIN_DEPTH. */
  mentionChainDepth: number;
  /** The *agent* whose message triggered this turn, if it was an agent rather than the human
   * operator. This is what makes a reply land back with whoever actually asked: requiring an
   * agent to re-@mention someone who just addressed it directly is not how a conversation
   * works, and in practice they don't - one agent wrote "Claude, one audit item..." with no
   * "@", so the reply reached nobody and the thread died silently. See routeChatMessage. */
  addressedBy?: { id: string; handle: string };
  /** Set on the single cold retry allowed after a stale-session failure, so that retry can
   * never itself trigger another one. See looksLikeStaleSession. */
  sessionRetryDone?: boolean;
  /** Everything this turn has already said to the group MID-turn via the solace MCP bridge
   * (postFromCurrentTurn). Kept so end-of-turn routing can tell "this final answer is new" from
   * "this final answer just repeats what I already posted", and so the per-turn cap can be
   * enforced - both of which exist purely to stop one question being billed twice. */
  midTurnPosts?: string[];
  /** What this message is asking the agent to do - the only thing that decides whether it may
   * interrupt a turn that is already running. See turnIntent.ts for why the classification is
   * deliberately biased toward "work". */
  kind: IncomingKind;
  /** When this turn was created, ISO. Arrival order is the delivery guarantee, and `queue` gets
   * deliberately reordered on an interrupt (question -> resume -> the rest), so the order has to
   * live on the turn itself rather than in the array - and has to survive a restart. */
  receivedAt: string;
  /** Set only on a turn that is re-running work an interrupt cut short. `ofTurnId` is the
   * ORIGINAL turn (not the previous resume), so repeated interruptions of the same piece of work
   * stay correlated; `count` and `elapsedMs` are cumulative across all of them, and bound both
   * how many times this can happen and how long the work may run in total - without the elapsed
   * carry-over, an agent interrupted every 10 minutes would never hit MAX_TURN_MS at all. */
  resume?: { ofTurnId: string; count: number; elapsedMs: number };
  /** Set only on a turn that another agent could not run because its provider was out of usage,
   * and which has been passed to this one. `ofTurnId` is the ORIGINAL turn so a chain stays
   * correlated; `count` is how many hand-offs this work has already been through (capped by
   * MAX_HANDOVERS); `agentIds` is every agent that has already had it, INCLUDING the original,
   * so it can never be handed back to somebody who already failed at it. */
  handover?: { ofTurnId: string; count: number; agentIds: string[] };
  /**
   * The group message this turn was created for, kept apart from the rendered prompt.
   *
   * Needed so several messages that arrived while the agent was busy can be merged into ONE
   * turn instead of run as several. Merging rendered prompts is not an option: each carries a
   * full copy of the context block (identity, roster, coordination, house style, the skills
   * pointer), so eight of them would send that block eight times to say eight sentences.
   */
  groupMessage?: { from: string; text: string };
  /** Set once this turn has already been stopped for another AGENT's question. The operator is
   * never subject to this; it exists so agent traffic can interrupt real work at most once
   * instead of repeatedly, which is what previously starved an agent into finishing nothing. */
  agentInterruptUsed?: boolean;
}

/** A snapshot of one agent's still-outstanding work, for persistence.ts - see
 * AgentManager.getPersistableQueues()/restoreQueues(). */
export interface PersistedAgentQueue {
  agentId: string;
  /** The turn that was actually running (mid-generation) when the process stopped, if any -
   * there's no way to resume real mid-generation CLI/API state, so this just gets re-run from
   * scratch on restart, with an honest system message explaining why instead of silently
   * forgetting it was asked at all. */
  inFlight?: QueuedTurn;
  /** Turns that were queued but hadn't started yet - these just run normally on restart,
   * nothing was interrupted. A turn that carries `resume` rides here too: a pending resume IS
   * an ordinary queued turn, just one whose prompt re-states work an interrupt cut short. */
  queued: QueuedTurn[];
  /** The subset of `queued` that arrived while a turn was already running and has not yet been
   * handed to that agent mid-turn (AgentRuntime.pendingInbound). Persisted as whole turns rather
   * than ids so an older/partial state file can't resurrect a half-restored reference; on load
   * they're matched back onto the restored `queued` entries by id, because the two must stay the
   * SAME objects. Optional: state written before interrupts existed has no such field. */
  pendingInbound?: QueuedTurn[];
}

interface AgentRuntime {
  config: AgentConfig;
  status: AgentRunState;
  busy: boolean;
  queue: QueuedTurn[];
  lastUsage?: TurnUsage;
  totalUsage: TurnUsage;
  lastError?: string;
  /** The in-flight turn's abort controller, if any - stored here (not just as a local inside
   * drainQueue) so removeAgent/stopAgent can actually reach it. Previously removing an agent
   * only deleted it from the `agents` map; the real `claude`/`codex` child process spawned
   * for its in-flight turn kept running - real filesystem writes, real billed tokens - for
   * as long as that turn happened to take, completely invisible to the UI, with no way for
   * the user to stop it short of killing the whole server. */
  activeController?: AbortController;
  /** Why activeController was aborted, set immediately before .abort(). The adapter only
   * reports THAT it was cancelled; the reason lives here, because only the caller knows it.
   * Read after runTurn resolves to tell a real timeout (an error, worth retrying) from the
   * user pressing Stop (not an error at all) - which the UI used to conflate, telling the user
   * a turn they deliberately stopped had "exceeded the maximum turn duration". */
  abortKind?: "timeout" | "stop" | "interrupt";
  /** Per-turn secret handed to helper processes this turn spawns, so an internal HTTP route can
   * verify a caller really is this agent's currently-running turn. Cleared when the turn ends,
   * which also stops a child that outlived its turn from acting as the agent. */
  activeTurnToken?: string;
  /** The model the provider itself reported for the most recent turn (e.g. "claude-sonnet-5"),
   * which is more specific than the configured alias ("sonnet" names more than one real model).
   * Display only - never written back into config, which is the user's choice, not ours. */
  lastResolvedModel?: string;
  /**
   * The provider CLI's own session ids for this agent's ongoing conversations, keyed by the
   * working directory the conversation happened in (normalised, see sessionKey).
   *
   * A map rather than one id because agents now follow the user between projects: the same
   * agent legitimately has a conversation going in two different folders, and resuming one
   * inside the other would drop the CLI into an unrelated codebase's context while sounding
   * completely sure of itself. An absent entry means the next turn in that folder starts cold.
   */
  sessions: Map<string, string>;
  /** The roster as it was last described to this agent, so the context block is re-sent when it
   * actually changed rather than on every single message. */
  lastRosterSignature?: string;
  /** The turn currently being run, if any - set right after it's popped off `queue` and
   * cleared when it finishes. Distinct from `queue` (which only holds turns waiting to
   * start) so a persistence snapshot taken mid-turn can still capture what was actually
   * running, not just what's still waiting. */
  currentTurn?: QueuedTurn;
  /** What this agent most recently actually worked on, derived from a real turn.
   *
   * Deriving the line only while busy was not enough: the moment a turn ended it fell back to
   * config.currentTask, which is a label someone typed into /task once and which nothing keeps
   * true. An agent sat there advertising "build the checkout flow" for hours after finishing
   * it, which is the state it is in most of the time anyone looks at the sidebar. Real work
   * supersedes the manual label permanently. */
  lastTaskLine?: string;
  /** When the in-flight turn started, so the UI can say how long it has been working rather
   * than just that it is. Cleared when the turn ends. */
  turnStartedAt?: string;
  /** The last rate-limit figure this agent's own turn heard from the provider. */
  rateLimit?: ProviderRateLimit;
  /** The most recently failed turn, kept around so a "Retry" action (automatic or
   * user-triggered) can re-submit the exact same prompt without the caller needing to retype
   * it. Cleared on the next successful turn. */
  lastFailedTurn?: QueuedTurn;
  /** When a failed turn's error text yielded a real, parseable future reset time, this is a
   * scheduled retry already in flight - exposed on AgentStatus so the UI can show "retrying
   * at ..." instead of a dead-looking error. Cleared (and the timeout cancelled) if the agent
   * is removed or a manual retry/new message preempts it. */
  scheduledRetryAt?: string;
  scheduledRetryTimeout?: NodeJS.Timeout;
  /** Messages that arrived for this agent WHILE it was mid-turn and haven't been handed to it
   * yet. Every entry here is the same object as an entry in `queue` - this is a delivery view of
   * the queue, not a second queue. Handing one over (takeInboundNotice) removes it from `queue`
   * so it can never both be answered mid-turn AND run again later as its own billed turn.
   *
   * This is the cheap, cooperative half of the interrupt mechanism: an agent that is actually
   * using its tools sees the note within seconds, at a safe boundary of its own choosing, with
   * nothing killed and no context lost. Only a question nobody picks up escalates to actually
   * aborting the turn - see INTERRUPT_GRACE_MS. */
  pendingInbound: QueuedTurn[];
  /** The armed escalation for the oldest unpicked-up question in pendingInbound. Held here so
   * Stop/Remove can disarm it: auto-resuming work after the user explicitly pressed Stop would
   * be the worst possible behaviour of this whole feature. */
  interruptTimer?: NodeJS.Timeout;
}

/**
 * The absolute ceiling on one turn. Deliberately generous: this is the backstop for a turn
 * that keeps emitting forever, NOT the normal way a turn ends.
 *
 * This used to be 15 minutes of wall-clock time measured from the start of the turn, which
 * killed agents that were working perfectly. Observed live: two agents were building a site
 * together, one of them streaming tool calls and progress the whole time, and it was cut off
 * mid-build with "turn stopped after 15 minutes without finishing" - our own timer, reported
 * as if the provider had failed. "Build this site" is exactly the kind of ask this app exists
 * for, and those take longer than fifteen minutes.
 */
/**
 * The key an agent's provider session is stored under: its working directory, normalised the
 * same way chatStore.ts normalises paths (resolved, case-folded, no trailing separator).
 * Windows hands us the same folder as both "C:\x\y" and "c:/x/y", and two spellings of one
 * directory must not mean two cold conversations.
 */
export function sessionKey(cwd: string): string {
  return resolve(cwd).toLowerCase().replace(/[\/]+$/, "");
}

/**
 * NOTE on the limits in this file: each of the exported MAX_* / *_MS constants below is now the
 * DEFAULT for a user-visible setting (shared/src/settings.ts), not the only value in play. Every
 * place that enforces one reads it through `this.settings.get()` at the moment it is enforced,
 * exactly as handoverOnUsageExhausted is - never cached at boot - so a change made in one tab
 * applies to a turn that starts seconds later. The constants stay here, and stay the defaults,
 * so behaviour is unchanged for anyone who never opens Settings, and so the pure helpers below
 * remain callable (and testable) without a SettingsStore.
 */
export const MAX_TURN_MS = 2 * 60 * 60 * 1000;

/**
 * How long a turn may produce NOTHING before it is treated as hung.
 *
 * This is the check that actually matters. A working CLI emits constantly - text, tool
 * calls, usage - so silence is the real signal of a stuck process, where elapsed time is
 * only a signal that the task was big. Any adapter event resets it.
 */
export const MAX_TURN_IDLE_MS = 5 * 60 * 1000;

/** How many agent-to-agent @mention hops are allowed before a chain is cut off. Two agents
 * mentioning each other back and forth is legitimate collaboration, not a bug - but with no
 * cap at all, it has no natural stopping point either. Now the default for a setting
 * (maxMentionChainDepth), read live in routeChatMessage. */
export const MAX_MENTION_CHAIN_DEPTH = 6;

/**
 * Whether a chain being cut off at `depth` should ANNOUNCE itself in the chat.
 *
 * Only the first over-cap hop says anything; announcing every one of them would replace a
 * runaway chain of turns with a runaway chain of notices.
 *
 * The `+ 2` is the whole point of this being a named, tested function. Depth reaches
 * routeChatMessage in steps of TWO, not one: a hop is route(D) -> enqueueTurn(D+1) -> that
 * turn's answer routes at D+2. So the depths actually seen are 0, 2, 4, ... and the original
 * `depth === cap + 1` test could never match at the default cap of 6 - the first over-cap call
 * arrives at 8, not 7. The cut-off was therefore completely silent: work simply stopped and
 * nobody was told. That is why this cap stayed hardcoded until now; a limit a user can lower
 * without ever seeing it bite is a limit that makes work disappear.
 */
export function announcesChainCutoff(depth: number, maxDepth: number): boolean {
  return depth > maxDepth && depth <= maxDepth + 2;
}

/**
 * One house style for every agent, whatever provider it is.
 *
 * Each CLI has its own default voice: one narrates constantly, another goes silent for minutes
 * and then emits a wall of bullet points. Reading a chat with both in it is jarring, and the
 * quieter one reads as though it is doing nothing when it is working hard.
 *
 * Every line here is about being MORE informative or MORE honest. None of it asks for polish
 * for its own sake, and the verification clauses exist because this project has already caught
 * an agent announcing a site was live at a URL where nothing was listening.
 */
const HOUSE_STYLE = [
  "Write like a careful engineer briefing a colleague who will act on what you say:",
  "- Lead with the outcome. What changed, what you found, or what is blocked - not a restatement of the request.",
  "- Separate what you VERIFIED from what you assume. Say how you verified it (ran it, read the file, curled the URL). If you did not check, say you did not check.",
  "- Be concrete: real file paths, real commands, real numbers. Never describe a result you did not observe.",
  "- Say what you did NOT do, and anything you left broken or unfinished. A gap you name is useful; a gap you omit is a trap.",
  "- Flag uncertainty in one clear sentence rather than hedging through a whole paragraph.",
  "- Prose over bullet soup. Use a list when the content is genuinely a list, not as a default layout.",
  "- No preamble, no filler, no restating instructions back. Start with the substance.",
  "- Keep it proportionate: a one-line change deserves a one-line report.",
  // Observed live: codex reported its own work as "codex removed the superseded prototype
  // files after verifying they were unreferenced". Every message already carries its author's
  // name in the UI, so narrating yourself in the third person reads like a report ABOUT
  // somebody else - and in a room where several agents are doing similar work, it is genuinely
  // ambiguous whether the speaker did it or is describing what a teammate did.
  "- Write about your own work in the first person: \"I removed the dead files\", not \"codex removed the dead files\". Your name is already on the message. Use other agents' handles only when you mean THEM.",
  "If you have post_to_group, send a short update when you start something substantial, when you",
  "commit to a direction, and when you hand work off - so the others are not waiting in the dark.",
].join("\n");

/** How an agent says "I'm done, don't hand this back to me" - see routeChatMessage. Matched
 * anywhere in the reply (agents reliably put it on its own last line, but pinning it to the
 * very end would make a single trailing period silently disable the off-ramp). */
const END_THREAD_MARKER = /\[no-reply\]/i;

/** How many mid-turn group posts one turn may make (see postFromCurrentTurn). Every post can
 * enqueue a real, billed turn for another agent, so an agent that decides to narrate its whole
 * working into the group would spend the user's money doing it. Eight is enough for genuine
 * coordination (announce, ask, hand off, answer) and far short of a transcript. */
export const MAX_MID_TURN_POSTS = 8;

/** How long a QUESTION may sit undelivered in pendingInbound before the running turn is killed
 * to answer it. Tuned to be longer than the gap between two tool calls of a working agent (which
 * is seconds) and shorter than a human's patience waiting on an answer. Anything that expires
 * this has, in practice, not touched a solace tool in a minute - i.e. cooperative delivery was
 * never going to reach it in time. */
/** How long a turn is protected from ANOTHER AGENT's question before it is stopped to answer
 * it. Far longer than the operator's grace: an agent's question is rarely urgent enough to be
 * worth destroying a half-finished piece of work, but leaving it unanswered for the whole of a
 * long build leaves the asker blocked. Four minutes is long enough to finish a file and short
 * enough that nobody waits a whole build for an acknowledgement. */
export const AGENT_QUESTION_GRACE_MS = 4 * 60 * 1000;

export const INTERRUPT_GRACE_MS = 50 * 1000;

/** How many times one piece of work may be interrupted and resumed before we stop and say so.
 * Each resume is a real billed turn that re-reads files and re-establishes context, so an agent
 * getting questions faster than it can work would otherwise spend the user's money making no
 * progress at all. */
export const MAX_RESUMES = 3;

/** How long a turn may run, given what (if anything) it is resuming. A resumed turn inherits the
 * REMAINING budget, never a fresh one: with a fresh 15 minutes each time, an agent interrupted
 * every ten minutes would never time out at all. The floor keeps a near-exhausted resume usable
 * instead of killing it on arrival. Exported for tests - it is the one bound here whose
 * arithmetic being wrong is silently expensive rather than loudly broken.
 *
 * `maxTurnMs` is passed in by the caller from the LIVE setting (maxTurnMinutes) so this stays a
 * pure function; it defaults to the constant so existing callers and tests are unchanged. */
/** A duration in the largest unit that still says something true about it. Only used in the
 * "we stopped this turn" message, where the number is the user's own configured limit being
 * quoted back at them and must therefore match what they typed. */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = minutes / 60;
  // One decimal only when it is not a whole number, so "2h" does not become "2.0h".
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
}

export function resumeBudgetMs(resume: QueuedTurn["resume"], maxTurnMs: number = MAX_TURN_MS): number {
  if (!resume) return maxTurnMs;
  return Math.max(60_000, maxTurnMs - resume.elapsedMs);
}

/** Has this piece of work run out of resumes, or out of total run time across them? Either one
 * ends the resume chain - see scheduleResume, which then reports exactly what was abandoned.
 *
 * Both bounds are passed in from the live settings (maxResumes, maxTurnMinutes) and default to
 * the constants, for the same reason as resumeBudgetMs above. */
export function resumeExhausted(
  count: number,
  elapsedMs: number,
  maxResumes: number = MAX_RESUMES,
  maxTurnMs: number = MAX_TURN_MS,
): boolean {
  return count > maxResumes || elapsedMs >= maxTurnMs;
}

/**
 * Where a resume turn goes: the oldest queued QUESTION moves to the front, the resume turn sits
 * immediately behind it, and everything else keeps its arrival order behind that - question ->
 * resume -> the rest. That is the whole point of having killed the turn: answer the thing that
 * could not wait, then go straight back to the work.
 *
 * Arrival order is read off each turn's receivedAt rather than from the array, because an
 * earlier interrupt may already have reordered this queue. Returns a new array; mutates nothing.
 */
export function insertResumeTurn(queue: QueuedTurn[], resumeTurn: QueuedTurn): QueuedTurn[] {
  let questionAt = -1;
  for (let i = 0; i < queue.length; i++) {
    if (queue[i].kind !== "question") continue;
    if (questionAt === -1 || Date.parse(queue[i].receivedAt) < Date.parse(queue[questionAt].receivedAt)) {
      questionAt = i;
    }
  }
  // No question left to answer: it was delivered cooperatively in the instant between the abort
  // firing and this running, so the work just goes straight back on the front.
  if (questionAt === -1) return [resumeTurn, ...queue];
  const rest = queue.filter((_, i) => i !== questionAt);
  return [queue[questionAt], resumeTurn, ...rest];
}

/** Marks where a resume prompt's re-statement of the original work starts, so resuming an
 * already-resumed turn re-states the ORIGINAL request instead of nesting one resume preamble
 * inside another until the real task is buried. */
const RESUME_WORK_MARKER = "[the work you were doing]\n";

/** The same idea for a turn passed to a different agent - see buildHandoverPrompt. Distinct
 * text because the reader is a different agent who was not doing this work a moment ago. */
const HANDOVER_WORK_MARKER = "[the work being handed to you]\n";

/**
 * The real request buried inside a turn's prompt, with any re-statement preamble (resume,
 * handover, or a resume of a handover) stripped back off.
 *
 * Reads the LAST marker present, not the first: work that was handed over and then interrupted
 * carries both, and the innermost one is the one wrapping the actual request. Without this, each
 * re-statement would nest inside the previous one until the real task was buried.
 */
function originalWorkText(turn: QueuedTurn): string {
  let at = -1;
  let markerLength = 0;
  for (const marker of [RESUME_WORK_MARKER, HANDOVER_WORK_MARKER]) {
    const index = turn.prompt.lastIndexOf(marker);
    if (index > at) {
      at = index;
      markerLength = marker.length;
    }
  }
  return at >= 0 ? turn.prompt.slice(at + markerLength) : stripPromptWrapper(turn.prompt).trim();
}

/** Whitespace/case-insensitive comparison key, so "the same message" posted mid-turn and then
 * repeated in the final answer with different wrapping still counts as the same message - see
 * the duplicate check in drainQueue. */
function normalizeForDuplicateCheck(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** For display only (the interrupted-turn restart notice) - a prompt built by buildGroupPrompt
 * has a "[group context: ...]" block and a "[group chat message from X]: " prefix wrapped
 * around the actual message; showing that raw wrapper to the user would bury what they
 * actually said. Strips known prefixes, falls back to the raw text for anything else
 * (a direct hub message has no wrapper at all). */
function stripPromptWrapper(prompt: string): string {
  return prompt.replace(/^\[group context:.*?\]\n\n/s, "").replace(/^\[group chat message from [^\]]+\]:\s*/, "");
}

function summarizePrompt(prompt: string): string {
  const stripped = stripPromptWrapper(prompt);
  return stripped.length > 200 ? `${stripped.slice(0, 200)}…` : stripped;
}

/** What a turn is actually trying to get done, for any message a human will read. Needed because
 * a resume turn's own prompt starts with a long re-read preamble, so summarizing it raw showed
 * the user "Your previous turn was stopped part-way through so another agent's..." where they
 * needed to see which piece of work was paused or abandoned. */
/**
 * A sidebar-sized version of what a turn is working on.
 *
 * describeWork() returns up to 200 characters, which is right for a system message but wrong
 * for a two-line row under an agent's name - the first live task rendered there was a whole
 * paragraph of explanation about a bug. Takes the first sentence or line, drops a leading
 * @handle (the row already says who it is), and caps it.
 */
function summarizeTaskLine(work: string): string {
  const firstLine = work.split("\n")[0].trim();
  const withoutMention = firstLine.replace(/^@[a-zA-Z0-9_-]+[,:]?\s*/, "");
  const firstSentence = withoutMention.split(/(?<=[.!?])\s/)[0].trim() || withoutMention;
  return firstSentence.length > 80 ? `${firstSentence.slice(0, 80).trimEnd()}…` : firstSentence;
}

function describeWork(turn: QueuedTurn): string {
  return summarizePrompt(originalWorkText(turn));
}

/** Who a queued turn came from, for the mid-turn delivery note - read back out of the prompt
 * wrapper buildGroupPrompt put there, so this needs no extra field on QueuedTurn. A direct hub
 * message has no wrapper and no agent author, which is exactly the human-operator case. */
function promptAuthorHandle(turn: QueuedTurn): string {
  if (turn.addressedBy) return `@${turn.addressedBy.handle}`;
  const match = turn.prompt.match(/^\[group context:.*?\]\n\n\[group chat message from ([^\]]+)\]:/s);
  const fromGroup = match?.[1] ?? turn.prompt.match(/^\[group chat message from ([^\]]+)\]:/)?.[1];
  return fromGroup && fromGroup !== "you" ? `@${fromGroup}` : "the operator";
}

/**
 * The prompt for a turn that re-runs work an interrupt cut short.
 *
 * It re-states the original request rather than relying on the CLI session to carry it: whether
 * a KILLED `claude -p` turn persists anything at all to its session store is UNVERIFIED (the
 * session is written by the CLI, and we killed the CLI), so assuming the agent still knows what
 * it was doing is assuming something we have never observed.
 *
 * The re-read instruction is there for the same reason in the other direction: the kill can land
 * between two writes of a multi-file edit, so the files on disk may be in a state neither the
 * agent nor we can predict. Telling it to check rather than assume is the only honest option.
 */
export function buildResumePrompt(turn: QueuedTurn): string {
  const work = originalWorkText(turn);
  return [
    "[solace] Your previous turn was stopped part-way through so another agent's question could",
    "be answered first. That has now been handled. Pick this work back up.",
    "",
    "IMPORTANT: you were stopped mid-work, possibly in the middle of an edit. Whether your last",
    "write actually reached disk is unknown - the CLI process was killed, so do not assume it",
    "landed and do not assume it did not. Before you continue, re-read the files you were",
    "changing and check their CURRENT contents, then carry on from whatever state they are",
    "actually in. Do not blindly re-apply an edit that is already there.",
    "",
    RESUME_WORK_MARKER + work,
  ].join("\n");
}

/**
 * Providers don't expose a queryable quota API - the only real signal a rate limit ever gives
 * is the literal sentence in the error text (mirrors the same extraction lib/errorFormat.ts
 * already does client-side for display; this is the server-side version used to actually
 * schedule a retry, not just show a headline). Returns undefined - never a guess - when the
 * message isn't clearly a rate limit, or doesn't contain a time this can confidently parse.
 */
/**
 * Is this failure the provider saying the account is out of usage, rather than any other kind
 * of error?
 *
 * This is deliberately the SAME test parseResetTime has always gated on - extracted, not
 * reinvented. A second heuristic would eventually disagree with the first, and the direction it
 * would disagree in is "treat a syntax error or a bad prompt as a quota problem", which would
 * spend a second agent's tokens reproducing the first agent's failure.
 */
export function looksLikeUsageExhausted(message: string | undefined): boolean {
  return /usage limit|rate limit/i.test(message ?? "");
}

function parseResetTime(message: string, now: Date): Date | undefined {
  if (!looksLikeUsageExhausted(message)) return undefined;
  // JS's Date constructor can't reliably parse a bare time-of-day string ("10:50 PM" alone is
  // Invalid Date in Node, with no timezone attached either) - pull the hour/minute/meridiem
  // out explicitly and build the Date by hand against today's date instead of trusting
  // new Date(arbitraryProviderText) to do the right thing.
  const timeMatch = message.match(/(\d{1,2}):(\d{2})\s?([APap][Mm])/);
  if (!timeMatch) return undefined;
  let hour = Number(timeMatch[1]) % 12;
  if (/pm/i.test(timeMatch[3])) hour += 12;
  const minute = Number(timeMatch[2]);
  const parsed = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  // A bare time-of-day, with no date, means "the next time it's HH:MM" - if that's already in
  // the past relative to now, the only sensible reading is tomorrow, since a rate limit can't
  // have already reset before it was even hit.
  if (parsed.getTime() <= now.getTime()) parsed.setDate(parsed.getDate() + 1);
  return parsed;
}

/**
 * A resume that failed because the session itself is gone (deleted transcript, a CLI upgrade
 * that moved its store, an id from another machine). Distinguished from ordinary errors so it
 * can be recovered from automatically - starting cold is always possible - instead of leaving
 * the agent permanently unable to run because of a stale string we saved.
 */
export function looksLikeStaleSession(message: string): boolean {
  if (
    /no conversation found|session .{0,40}not found|invalid session|unknown session|no session|conversation .{0,40}not found/i.test(
      message,
    )
  ) {
    return true;
  }
  // A session can also be POISONED rather than missing, which fails identically from here: the
  // turn errors and no amount of retrying the same session will ever work again.
  //
  // Copilot stores the reasoning effort INSIDE the session. Verified live: a session created
  // with `--effort none` keeps sending reasoningEffort "none" on every resumed turn even when
  // the flag is omitted entirely, so once its routed model rejects that value the session is
  // permanently broken - and changing the effort in this app cannot fix it, because the stored
  // value is what gets sent. Dropping the session id and running cold is the only repair, and
  // the existing one-shot guard means the worst case is a single extra cold run.
  return /unsupported value.{0,80}(is not supported with|supported values are)|does not support reasoning effort/i.test(
    message,
  );
}

/**
 * How many times one piece of work may be passed to a different agent before this stops.
 *
 * Two is enough to get past "the one agent I was using ran out" without the work being able to
 * tour the roster. Every hop is a real billed turn on a fresh agent that has to re-read the
 * files first, and a chain with no cap has no natural end: agents on the same account share one
 * real limit, so "everybody is exhausted" is the normal case, not the exotic one.
 */
export const MAX_HANDOVERS = 2;

/**
 * Which agents could actually take over this work.
 *
 * The working-directory rule is the whole design constraint, not a nicety. An agent's cwd is
 * where its CLI genuinely runs, so handing "fix the build in landing-page-test" to an agent
 * pointed at another project does not produce a slower answer - it produces confident, wrong
 * work in somebody else's repository, which is worse than the task simply waiting.
 *
 * `cwdOf` is how that directory is resolved, because with agents following the user between
 * projects an agent's EFFECTIVE directory for a turn is the chat's project folder, not the
 * folder it was created against. Defaults to the stored cwd so a caller that has no chat in
 * hand (and every existing test) gets the original rule unchanged.
 *
 * Also excluded: the failing agent itself, and anyone this work has already been through (an
 * agent that just ran out of usage will still be out of usage), so a chain cannot cycle.
 *
 * Order is roster order, which is stable, and puts agents that can actually change files ahead
 * of ones that cannot - a `plan` agent is a legal recipient (it may be all there is), but it is
 * the last resort rather than the first pick.
 */
export function eligibleHandoverAgents(
  from: AgentConfig,
  roster: AgentConfig[],
  turn: QueuedTurn,
  cwdOf: (agent: AgentConfig) => string = (a) => a.cwd,
): AgentConfig[] {
  const alreadyTried = new Set(turn.handover?.agentIds ?? [from.id]);
  alreadyTried.add(from.id);
  const eligible = roster.filter((a) => !alreadyTried.has(a.id) && sameWorkingDirectory(cwdOf(a), cwdOf(from)));
  const canWrite = (a: AgentConfig) => (a.trustLevel === "plan" ? 1 : 0);
  return eligible.sort((a, b) => canWrite(a) - canWrite(b));
}

/**
 * The prompt the receiving agent gets.
 *
 * It says plainly that this is somebody else's unfinished work, because the alternative - a
 * prompt that reads like a fresh request - would have the new agent silently redo whatever the
 * first one had already done. The re-read instruction is there for the same reason it is in
 * buildResumePrompt: the original agent may have got part-way through real edits before its
 * provider cut it off, and whether any of that reached disk is genuinely unknown to us.
 */
export function buildHandoverPrompt(turn: QueuedTurn, fromHandle: string): string {
  return [
    `[solace] @${fromHandle} was given this work but its provider ran out of usage before it could`,
    "finish, so it has been handed to you. You work in the same directory, which is why you and not",
    "somebody else.",
    "",
    `IMPORTANT: @${fromHandle} may have already started. Whether any of its edits reached disk is`,
    "unknown to us. Before you change anything, read the current state of the files involved and",
    "carry on from what is actually there - do not assume nothing was done, and do not assume it",
    "was finished. You are running at your OWN permission level, not the one that agent had.",
    "",
    HANDOVER_WORK_MARKER + originalWorkText(turn),
  ].join("\n");
}

interface EnqueueOptions {
  mentionChainDepth?: number;
  addressedBy?: { id: string; handle: string };
  /** Defaults to "work": the safe classification, and the right one for every internal re-run
   * (restore, retry, rate-limit retry) where nothing new has actually arrived. */
  kind?: IncomingKind;
  sessionRetryDone?: boolean;
  resume?: QueuedTurn["resume"];
  handover?: QueuedTurn["handover"];
  /** Preserve a turn's identity/arrival time across a restart or a retry, so ordering and the
   * queue<->pendingInbound pairing survive rather than being silently re-generated. */
  id?: string;
  receivedAt?: string;
  /** See QueuedTurn.groupMessage - carried so queued messages can be coalesced. */
  groupMessage?: { from: string; text: string };
  /** Is this a message that has just ARRIVED from someone, as opposed to work being re-run?
   * Only arriving traffic is eligible for mid-turn delivery and for escalating to an interrupt.
   * Defaults to false so no internal caller can accidentally opt into killing a turn. */
  inbound?: boolean;
}

/** Map a turn read back off disk onto enqueue options, tolerating state files written before
 * ids/kinds/arrival times existed on a turn - those fields are simply regenerated. */
function restoredTurnOptions(turn: QueuedTurn): EnqueueOptions {
  return {
    mentionChainDepth: turn.mentionChainDepth,
    addressedBy: turn.addressedBy,
    kind: turn.kind,
    sessionRetryDone: turn.sessionRetryDone,
    resume: turn.resume,
    handover: turn.handover,
    id: turn.id,
    receivedAt: turn.receivedAt,
  };
}

/**
 * Scrub any stored vault secret out of text an agent is about to publish.
 *
 * The vault deliberately hands real credentials to agents so they can sign into things, which
 * means a secret legitimately reaches a model - and nothing then stops the model repeating it
 * back in a message. The bridge never does that and the tool description forbids it, but an
 * instruction to a model is not a control. Chat history is persisted to .solace-state.json in
 * plaintext and replayed in Saved chats, so a secret echoed once is a secret kept forever.
 *
 * Returns the scrubbed text and whether anything was found, so the caller can tell the user
 * rather than silently altering what an agent said.
 */
function scrubSecrets(text: string): { text: string; redacted: boolean } {
  let out = text;
  let redacted = false;
  for (const secret of listSecretValues(WORKSPACE_ROOT)) {
    if (!out.includes(secret)) continue;
    out = out.split(secret).join("[redacted - a saved vault secret]");
    redacted = true;
  }
  return { text: out, redacted };
}

function addUsage(total: TurnUsage, delta: TurnUsage): TurnUsage {
  return {
    inputTokens: (total.inputTokens ?? 0) + (delta.inputTokens ?? 0),
    outputTokens: (total.outputTokens ?? 0) + (delta.outputTokens ?? 0),
    totalCostUsd:
      total.totalCostUsd === undefined && delta.totalCostUsd === undefined
        ? undefined
        : (total.totalCostUsd ?? 0) + (delta.totalCostUsd ?? 0),
  };
}

/**
 * Owns the set of configured agents and routes turns to them, both in the shared group chat
 * and in each agent's own direct channel (see ARCHITECTURE.md#group-chat-routing and
 * #agent-hub-direct-chat).
 *
 * Routing rule inside one chat (see routeChatMessage). Every rule below applies within that
 * chat only: a chat filed under a project reaches just the agents whose cwd is in that
 * project's directory, so "everyone" never means an agent that cannot do this work.
 *   - A human message with @mentions only triggers a turn for the mentioned agent(s).
 *   - A human message with no @mentions triggers every agent - each gets its own turn and
 *     decides for itself whether it's relevant to them.
 *   - An agent's own reply triggers another agent when it explicitly @mentions them, and
 *     additionally always goes back to whichever *agent* addressed it, if any, with no
 *     @mention needed - answering whoever just asked you something is the whole point of a
 *     thread. It still never fans out to everyone on no-mention, so agents can't cascade into
 *     everyone replying to everyone forever. A capped chain depth bounds both cases, since
 *     two agents can otherwise keep replying to each other indefinitely.
 * A direct message to one agent's own channel always triggers a turn for just that agent,
 * with no @mention parsing needed, and its reply goes back to that same direct channel.
 */
export class AgentManager {
  private agents = new Map<string, AgentRuntime>();

  /** Set by index.ts to persist state after every agent add/update/remove. */
  onChange: (() => void) | null = null;

  /** Rate limits are held per provider, not per agent: two agents on the same CLI share one
   * real account and one real limit, so whichever of them last heard from the provider holds
   * the current truth for both. */
  private rateLimits: RateLimitStore;

  constructor(
    private bus: ChatBus,
    /** Which chats exist, and which agents each one reaches - see ChatStore.agentsForChat.
     * Routing needs this: a message in a project's chat must not summon an agent whose cwd is
     * some other project's directory. */
    private chats: ChatStore,
    initialAgents: AgentConfig[] = [],
    private approvals?: ApprovalRegistry,
    initialQueues: PersistedAgentQueue[] = [],
    initialSessions: PersistedAgentSession[] = [],
    initialRateLimits: ProviderRateLimit[] = [],
    /** Read live on every failure, never cached: a setting toggled in a browser tab has to
     * apply to the turn that fails five seconds later. Defaults to a store holding the
     * documented defaults, so every existing caller (and every test) keeps working with
     * handover off, which is what off-by-default means. */
    private settings: SettingsStore = new SettingsStore(),
    /** Claims, contracts, blocks and announcement watermarks. Defaults to an empty board so
     * every existing caller and test keeps working with coordination simply unused. */
    private board: CoordinationBoard = new CoordinationBoard(),
  ) {
    this.rateLimits = new RateLimitStore(initialRateLimits);
    for (const config of initialAgents) {
      this.agents.set(config.id, {
        config,
        sessions: new Map(),
        status: "idle",
        busy: false,
        queue: [],
        pendingInbound: [],
        totalUsage: {},
      });
    }
    // Queued/in-flight work used to be pure in-memory state - a restart (a real crash, or
    // just editing server source in dev mode) silently dropped it with no trace it had ever
    // been asked. A turn that was only queued (never started) just runs now, which is
    // correct - nothing lied about having answered it. A turn that was actually mid-generation
    // can't be resumed (that state is genuinely gone), so it's re-run from scratch, but with
    // an honest note explaining why instead of a message that just never got a reply.
    // Restore each agent's own conversation, but only where it still means something: a session
    // belongs to a cwd and a provider, so if the agent has since been repointed or switched, the
    // stored id would drop it into an unrelated conversation. Discard rather than guess.
    for (const saved of initialSessions) {
      const runtime = this.agents.get(saved.agentId);
      if (!runtime) continue;
      // Sessions are keyed by the directory they happened in, so one saved per folder is
      // restored rather than the last one written winning. A provider change still discards
      // them all: the id belongs to that CLI's own store.
      if (runtime.config.provider !== saved.provider) continue;
      runtime.sessions.set(sessionKey(saved.cwd), saved.sessionId);
    }
    for (const saved of initialQueues) {
      const runtime = this.agents.get(saved.agentId);
      if (!runtime) continue; // the agent itself was removed before restart
      // Restored work is a backlog being re-run, not freshly arrived traffic, so none of it is
      // marked `inbound` here - that flag is what makes a message a candidate for cooperative
      // mid-turn delivery, and dumping a whole restored backlog into the first restored turn as
      // text would be neither what the senders asked for nor something anyone could audit.
      // pendingInbound is instead restored explicitly below, exactly as it was saved.
      if (saved.inFlight) {
        this.bus.postMessage({
          id: nanoid(),
          channel: { agentId: saved.agentId },
          authorId: "system",
          authorHandle: "system",
          mentions: [],
          text: `This was interrupted by a restart before finishing - retrying now: "${summarizePrompt(saved.inFlight.prompt)}"`,
          createdAt: new Date().toISOString(),
        });
        this.enqueueTurn(saved.agentId, saved.inFlight.prompt, saved.inFlight.replyChannel, {
          ...restoredTurnOptions(saved.inFlight),
        });
      }
      for (const turn of saved.queued) {
        this.enqueueTurn(saved.agentId, turn.prompt, turn.replyChannel, { ...restoredTurnOptions(turn) });
      }
      // Re-point pendingInbound at the RESTORED turn objects (matched by id), never at the
      // deserialized copies: the whole invariant is that a pendingInbound entry and its queue
      // entry are the same object, so delivering one removes the other. State files written
      // before this field existed simply restore nothing here, which is correct - everything
      // just runs as an ordinary queued turn.
      const pendingIds = new Set((saved.pendingInbound ?? []).map((t) => t?.id).filter(Boolean));
      if (pendingIds.size > 0) {
        runtime.pendingInbound = runtime.queue.filter((t) => pendingIds.has(t.id));
      }
    }
  }

  /**
   * The turn-shaping limits, in the units the code enforces them in, read from the settings
   * store AT THE MOMENT OF THE CALL.
   *
   * Deliberately a method and not a field: a field would be the boot-time snapshot this whole
   * design exists to avoid, and the settings are edited from a browser tab while the server is
   * running. Every caller below invokes it at the point of enforcement, so a turn that starts
   * five seconds after a change is governed by the new value.
   *
   * Minutes/seconds are the units the Settings page speaks; milliseconds are the units
   * setTimeout speaks. Converting here, once, keeps the conversion out of the call sites.
   */
  private limits() {
    const s = this.settings.get();
    return {
      maxTurnMs: s.maxTurnMinutes * 60_000,
      idleMs: s.turnIdleMinutes * 60_000,
      maxResumes: s.maxResumes,
      maxHandovers: s.maxHandovers,
      maxMidTurnPosts: s.maxMidTurnPosts,
      interruptGraceMs: s.interruptGraceSeconds * 1000,
      agentQuestionGraceMs: s.agentQuestionGraceMinutes * 60_000,
    };
  }

  /** A snapshot of every agent's provider-side conversation id, for persistence.ts. */
  getPersistableSessions(): PersistedAgentSession[] {
    const out: PersistedAgentSession[] = [];
    for (const runtime of this.agents.values()) {
      for (const [cwd, sessionId] of runtime.sessions) {
        out.push({
          agentId: runtime.config.id,
          provider: runtime.config.provider,
          cwd,
          sessionId,
          updatedAt: new Date().toISOString(),
        });
      }
    }
    return out;
  }

  /** A snapshot of every agent's outstanding work (in-flight + still-queued turns), for
   * persistence.ts to save alongside agent configs/history - see the constructor's
   * `initialQueues` param for how it's restored. Only agents with something outstanding are
   * included. */
  getPersistableQueues(): PersistedAgentQueue[] {
    const result: PersistedAgentQueue[] = [];
    for (const [agentId, runtime] of this.agents) {
      if (!runtime.currentTurn && runtime.queue.length === 0) continue;
      result.push({
        agentId,
        inFlight: runtime.currentTurn,
        queued: [...runtime.queue],
        pendingInbound: [...runtime.pendingInbound],
      });
    }
    return result;
  }

  addAgent(config: AgentConfig) {
    this.agents.set(config.id, {
      config,
      sessions: new Map(),
      status: "idle",
      busy: false,
      queue: [],
      pendingInbound: [],
      totalUsage: {},
    });
    this.bus.emitEvent({ type: "agent:added", payload: config });
    this.emitStatus(config.id);
    this.onChange?.();
  }

  removeAgent(id: string) {
    // Stop any in-flight turn (kills the underlying CLI child via the adapter's own
    // signal-abort handling) and drop any approval it might be blocked on, *before* the
    // config disappears - otherwise both leak: the turn keeps running against a deleted
    // agent's channel, and a pending approval Promise/resolver sits in the registry forever.
    const runtime = this.agents.get(id);
    if (runtime) {
      runtime.abortKind = "stop";
      this.abandonInterruptState(runtime, false);
    }
    runtime?.activeController?.abort();
    if (runtime?.scheduledRetryTimeout) clearTimeout(runtime.scheduledRetryTimeout);
    this.approvals?.expireForAgent(id);
    // Its claims would otherwise outlive it and hold a lane nobody can release, and its block
    // would sit on the board waiting for a wake-up that can never be delivered.
    this.board.forgetAgent(id);
    this.agents.delete(id);
    this.bus.emitEvent({ type: "agent:removed", payload: { agentId: id } });
    this.onChange?.();
  }

  /**
   * Does (agentId, token) identify a turn that is running RIGHT NOW? Internal HTTP routes are
   * driven by helper processes the CLI spawns, so the only thing distinguishing a real caller
   * from anything else that can reach the port is this per-turn secret. It also expires
   * naturally: the token is cleared when the turn ends, so a child process that outlives its
   * turn (Windows kill() does not reliably reap a whole process tree) cannot keep acting as
   * the agent afterwards.
   */
  /**
   * Forget an agent's provider-side conversation so its next turn starts cold. The manual
   * escape hatch for a session that has gone bad - confused, poisoned by an early mistake, or
   * simply grown expensive - since resumed context is otherwise kept forever. Returns false if
   * there was nothing to forget.
   */
  resetSession(agentId: string): boolean {
    const runtime = this.agents.get(agentId);
    // Forgets every folder's conversation, not just the current one: /reset means "start cold",
    // and leaving another project's session behind would make the next switch resume context
    // the user just asked to be rid of.
    if (!runtime || runtime.sessions.size === 0) return false;
    runtime.sessions.clear();
    runtime.lastRosterSignature = undefined;
    this.onChange?.();
    return true;
  }

  verifyTurnToken(agentId: string, token: unknown): boolean {
    const runtime = this.agents.get(agentId);
    if (!runtime?.activeTurnToken || typeof token !== "string" || !token) return false;
    return runtime.activeTurnToken === token;
  }

  /** Cancels an agent's in-flight turn (if any) without removing the agent itself - the
   * "Stop" action in the UI, distinct from "Remove agent" which also deletes the config. */
  stopAgent(id: string): boolean {
    const runtime = this.agents.get(id);
    if (!runtime?.activeController) return false;
    runtime.abortKind = "stop";
    // Stop has to mean stop. Without this, an agent the user deliberately stopped would sail on
    // through a queued resume turn (and keep a primed interrupt timer pointed at a turn that no
    // longer exists), which is the single most infuriating way this feature could misbehave.
    this.abandonInterruptState(runtime, true);
    runtime.activeController.abort();
    this.approvals?.expireForAgent(id);
    return true;
  }

  /** Disarm everything the interrupt mechanism has in flight for one agent. `announce` posts an
   * honest note for any resume turn this drops, because dropping queued work silently is exactly
   * what the rest of this class goes out of its way not to do. */
  private abandonInterruptState(runtime: AgentRuntime, announce: boolean) {
    this.clearInterruptTimer(runtime);
    runtime.pendingInbound = [];
    const droppedResumes = runtime.queue.filter((t) => t.resume);
    if (droppedResumes.length === 0) return;
    runtime.queue = runtime.queue.filter((t) => !t.resume);
    if (!announce) return;
    for (const dropped of droppedResumes) {
      this.bus.postMessage({
        id: nanoid(),
        channel: { agentId: runtime.config.id },
        authorId: "system",
        authorHandle: "system",
        mentions: [],
        text: `Stopped, so this paused work will NOT resume on its own: "${describeWork(dropped)}"`,
        createdAt: new Date().toISOString(),
      });
    }
  }

  /** Re-submits an agent's most recently failed turn, exactly as it was - the manual "Retry"
   * action for when the error wasn't a rate limit with a parseable reset time (so nothing was
   * auto-scheduled), or the user just doesn't want to wait for the scheduled one. Returns
   * false if there's nothing to retry. */
  retryAgent(id: string): boolean {
    const runtime = this.agents.get(id);
    const turn = runtime?.lastFailedTurn;
    if (!runtime || !turn) return false;
    if (runtime.scheduledRetryTimeout) clearTimeout(runtime.scheduledRetryTimeout);
    runtime.scheduledRetryAt = undefined;
    runtime.lastFailedTurn = undefined;
    // Re-running known work, not new traffic: a fresh id/arrival time, but never `inbound`, so a
    // retry can't make itself a candidate for interrupting somebody.
    //
    // `resume` is deliberately dropped. A manual Retry is a human deciding to run this again
    // from the start, and carrying the old accumulated elapsed time forward would hand that
    // fresh attempt the 60-second floor left over from the interrupt chain that abandoned it -
    // i.e. the retry would be killed almost immediately, for reasons that happened before the
    // user clicked. The prompt is kept exactly as it was (re-read-the-files preamble included,
    // where there was one) because that instruction is still true.
    this.enqueueTurn(id, turn.prompt, turn.replyChannel, {
      mentionChainDepth: turn.mentionChainDepth,
      addressedBy: turn.addressedBy,
      kind: turn.kind,
    });
    return true;
  }

  /** Lets a caller (the approval-bridge route) reflect a state drainQueue itself doesn't know
   * about - specifically "blocked waiting on a human", not just thinking/idle/error. */
  setStatus(id: string, status: AgentRunState) {
    const runtime = this.agents.get(id);
    if (!runtime) return;
    runtime.status = status;
    this.emitStatus(id);
  }

  /** Returns false if `id` doesn't name a live agent, so callers (the PATCH route) can
   * tell a real update apart from a stale/typo'd id instead of both reporting success. */
  updateAgent(
    id: string,
    patch: Partial<Pick<AgentConfig, "trustLevel" | "currentTask" | "model" | "effort" | "authMode" | "credentialId">>,
  ): boolean {
    const runtime = this.agents.get(id);
    if (!runtime) return false;
    Object.assign(runtime.config, patch);
    this.bus.emitEvent({ type: "agent:updated", payload: runtime.config });
    this.emitStatus(id);
    this.onChange?.();
    return true;
  }

  listAgents(): AgentConfig[] {
    return [...this.agents.values()].map((a) => a.config);
  }

  /** Latest real observation per provider - providers that have never reported are simply absent. */
  listRateLimits(): ProviderRateLimit[] {
    return this.rateLimits.list();
  }

  /**
   * Record a limit that did NOT arrive on an adapter event.
   *
   * Every other provider states its limits during a turn, so RateLimitStore learns them as a
   * side effect of working. Copilot emits nothing of the kind, so its quota is fetched
   * separately (copilotQuota.ts) and handed in here - through the same store and the same
   * broadcast, so the socket snapshot, the live event and /api/usage cannot disagree about it.
   */
  recordRateLimit(entry: ProviderRateLimit): void {
    if (!this.rateLimits.record(entry)) return;
    this.bus.emitEvent({ type: "usage:rate-limit", payload: entry });
    this.onChange?.();
  }

  /** Refresh Copilot's quota after one of its turns, since the turn is what moved the number.
   * Fire-and-forget: this must never delay or fail a turn that has already finished. */
  private refreshCopilotQuota(): void {
    clearCopilotQuotaCache();
    void getCopilotQuota()
      .then((quota) => {
        if (quota) this.recordRateLimit(quota);
      })
      .catch(() => {});
  }

  listStatuses(): AgentStatus[] {
    return [...this.agents.values()].map((a) => this.statusFor(a));
  }

  private statusFor(runtime: AgentRuntime): AgentStatus {
    return {
      agentId: runtime.config.id,
      state: runtime.status,
      // What the agent is ACTUALLY doing wins over the label someone typed once.
      //
      // currentTask was only ever written by /task, so it went stale the moment the work
      // moved on: one agent sat there reading "build the checkout flow" for hours after
      // finishing it, while another that was genuinely mid-build showed nothing at all,
      // because no one had ever run /task on it. A field that only a slash command can
      // update cannot stay true on its own.
      //
      // While a turn is running this is derived from that turn's own triggering message, so
      // it updates itself and cannot lie. The manual label is the fallback for an idle
      // agent, where it is what it always was: a note the user chose to leave.
      // Live while working, then the last thing it really did, and only a manual /task label
      // if it has never run a turn. That ordering is the whole fix: the manual label is the
      // least trustworthy of the three because nothing updates it.
      currentTask:
        runtime.currentTurn && runtime.busy
          ? summarizeTaskLine(describeWork(runtime.currentTurn))
          : (runtime.lastTaskLine ?? runtime.config.currentTask),
      turnStartedAt: runtime.busy ? runtime.turnStartedAt : undefined,
      lastActivityAt: new Date().toISOString(),
      lastUsage: runtime.lastUsage,
      totalUsage: runtime.totalUsage,
      lastError: runtime.lastError,
      activeChatId:
        runtime.busy && runtime.currentTurn && isChatChannel(runtime.currentTurn.replyChannel)
          ? runtime.currentTurn.replyChannel.chatId
          : undefined,
      rateLimit: runtime.rateLimit ?? this.rateLimits.get(runtime.config.provider),
      retryAt: runtime.scheduledRetryAt,
      canRetry: runtime.lastFailedTurn !== undefined,
      // Display only, and only when the provider actually told us - see AgentStatus.resolvedModel.
      resolvedModel: runtime.lastResolvedModel,
    };
  }

  private emitStatus(id: string) {
    const runtime = this.agents.get(id);
    if (!runtime) return;
    this.bus.emitEvent({ type: "agent:status", payload: this.statusFor(runtime) });
  }

  /** Human operator posts a message into one chat. No @mention reaches every agent in that chat
   * (each gets its own turn); an @mention reaches only the mentioned agent(s). */
  submitMessage(chatId: string, authorId: string, authorHandle: string, text: string) {
    this.routeChatMessage(chatId, authorId, authorHandle, text, {
      broadcastIfUnmentioned: true,
      mentionChainDepth: 0,
    });
  }

  /**
   * Shared by human-authored messages (submitMessage) and an agent's own final answer at the
   * end of a group-triggered turn (drainQueue). Posting the message and deciding who (if
   * anyone) it triggers a turn for used to be two different, inconsistent code paths - the
   * agent-authored one bypassed mention parsing entirely (hardcoded `mentions: []`), so an
   * agent's own "@codex, thoughts?" never actually reached Codex, only ever displayed as
   * inert text. This is the one place that logic lives now.
   *
   * `broadcastIfUnmentioned` is false for agent-authored messages on purpose: if an agent's
   * own unmentioned reply also fanned out to everyone, agents replying-with-no-mention would
   * cascade into everyone replying to everyone forever. Only an explicit @mention can trigger
   * another agent from an agent-authored message.
   */
  private routeChatMessage(
    chatId: string,
    authorId: string,
    authorHandle: string,
    text: string,
    opts: {
      broadcastIfUnmentioned: boolean;
      mentionChainDepth: number;
      model?: string;
      /** The agent this message is an answer to, when this is an agent's reply to another
       * agent - treated as a target even with no @mention (see `targets` below). */
      replyTo?: { id: string; handle: string };
      /** Set only when the SENDER explicitly said what this is (the solace bridge's `kind`
       * argument). Left undefined everywhere else so classifyIncoming decides - an agent
       * declaring its own message a question is a deliberate act; inferring one is a guess. */
      declaredKind?: IncomingKind;
    },
  ) {
    // The chat can be deleted while a turn is still running. Posting into it anyway would write
    // a message keyed to a room nothing can open. Nothing is lost by returning here: every line
    // of a chat turn is already mirrored into the agent's own hub as it is produced.
    if (!this.chats.getChat(chatId)) return;
    const channel: ChatChannel = { chatId };
    // Only the agents this chat actually reaches can be @mentioned in it. Parsing against the
    // full roster instead would let "@claude" in one project's chat resolve to an agent whose
    // cwd is a different project - it would read and edit the wrong files, confidently.
    const members = this.chats.agentsForChat(chatId, this.listAgents());
    const memberIds = new Set(members.map((a) => a.id));
    const mentions = parseMentions(text, members.map((a) => a.handle));
    // An @mention that names a real agent this chat cannot reach is the one case where silence
    // is actively misleading: with no mentions parsed, an unaddressed human message broadcasts,
    // so "@codex do this" would be answered by everyone EXCEPT codex. Say so instead.
    const unreachable = parseMentions(
      text,
      this.listAgents().filter((a) => !memberIds.has(a.id)).map((a) => a.handle),
    );
    // The end-of-thread marker is routing metadata, not something the human should have to
    // read - strip it from what gets displayed, but keep the raw text for the check below.
    const scrubbedIncoming = scrubSecrets(text);
    if (scrubbedIncoming.redacted) {
      this.bus.postMessage({
        id: nanoid(),
        channel,
        authorId: "system",
        authorHandle: "system",
        mentions: [],
        systemKind: "verification",
        text: "A saved vault secret appeared in a message bound for this chat and was removed before it could be stored. Treat that credential as exposed to the model, and rotate it if that matters.",
        createdAt: new Date().toISOString(),
      });
    }
    text = scrubbedIncoming.text;
    const displayText = text.replace(END_THREAD_MARKER, "").trim() || text.trim();

    const message: ChatMessage = {
      id: nanoid(),
      channel,
      authorId,
      authorHandle,
      mentions,
      text: displayText,
      model: opts.model,
      createdAt: new Date().toISOString(),
      // Group chat only ever receives an agent's completed answer for a turn (drainQueue posts
      // every intermediate line to the agent's own hub channel instead), so anything an agent
      // says here is, by construction, final. Marked rather than left blank so the group chat
      // uses the same renderer as the hub instead of relying on absence-means-answer.
      agentKind: authorId === "user" ? undefined : "answer",
    };
    this.bus.postMessage(message);

    if (unreachable.length > 0) {
      const chatName = this.chats.chatLabel(chatId);
      this.bus.postMessage({
        id: nanoid(),
        channel,
        authorId: "system",
        authorHandle: "system",
        mentions: [],
        systemKind: "verification",
        text:
          `${unreachable.map((h) => `@${h}`).join(", ")} ${unreachable.length === 1 ? "is" : "are"} not in "${chatName}" - ` +
          `an agent belongs to the project its working directory is in, and ${unreachable.length === 1 ? "that one's" : "those"} ` +
          `is elsewhere. Nothing was sent to ${unreachable.length === 1 ? "it" : "them"}.`,
        createdAt: new Date().toISOString(),
      });
      return;
    }

    // Who this message actually reaches. An explicit @mention is still the way to pull in
    // someone new, but an agent answering the agent that just addressed it doesn't have to
    // re-@mention them - that reply is the continuation of an existing thread, not a new
    // summons. Without this, a perfectly reasonable "Claude, one audit item: ..." from Codex
    // reached nobody, and the collaboration stalled with neither agent doing anything wrong.
    // An agent with nothing further to add needs a way to actually end a thread. Auto-replying
    // to whoever addressed you means "thanks, looks good" would otherwise trigger another turn,
    // and that one another, all the way to the depth cap - real billed turns spent on
    // pleasantries. The marker is an explicit opt-out the agent controls, checked only for the
    // implicit reply path: an explicit @mention is a deliberate act and always goes through.
    const endsThread = END_THREAD_MARKER.test(text);
    const replyTarget =
      opts.replyTo && this.agents.has(opts.replyTo.id) && !endsThread ? opts.replyTo.handle : undefined;
    const targets = mentions.length > 0 ? mentions : replyTarget ? [replyTarget] : [];

    if (targets.length === 0 && !opts.broadcastIfUnmentioned) return; // agent-authored, unaddressed: visible only

    // Read at the moment the hop is judged, not at boot - same rule as every other limit here.
    const maxChainDepth = this.settings.get().maxMentionChainDepth;
    if (opts.mentionChainDepth > maxChainDepth) {
      if (announcesChainCutoff(opts.mentionChainDepth, maxChainDepth)) {
        this.bus.postMessage({
          id: nanoid(),
          channel,
          authorId: "system",
          authorHandle: "system",
          mentions: [],
          text:
            maxChainDepth === 0
              ? "Agents are not allowed to trigger each other (0 hops), so this reply went no further - reply directly to continue."
              : `Stopped an agent-to-agent reply chain after ${maxChainDepth} hops to avoid a runaway loop - reply directly to continue.`,
          createdAt: new Date().toISOString(),
        });
      }
      return;
    }

    const isAgentAuthor = this.agents.has(authorId);
    for (const runtime of this.agents.values()) {
      if (runtime.config.id === authorId) continue; // an agent doesn't reply to itself
      if (!memberIds.has(runtime.config.id)) continue; // works in a different project's directory
      // targets empty here means an unaddressed *human* message (the broadcast case above) -
      // everyone in this chat gets a turn and decides relevance for themselves.
      if (targets.length > 0 && !targets.includes(runtime.config.handle)) continue;
      this.enqueueTurn(runtime.config.id, this.buildGroupPrompt(chatId, authorHandle, displayText, runtime.config.id), channel, {
        mentionChainDepth: opts.mentionChainDepth + 1,
        addressedBy: isAgentAuthor ? { id: authorId, handle: authorHandle } : undefined,
        // An agent that declared what it was sending is believed; everything else (every human
        // message, and every agent final answer coming back through here) gets classified.
        kind: opts.declaredKind ?? classifyIncoming(displayText),
        inbound: true,
        groupMessage: { from: authorHandle, text: displayText },
      });
    }
  }

  // -------------------------------------------------------------------------------------
  // Coordination: claims, contracts, blocks, announcements
  // -------------------------------------------------------------------------------------

  /** The chat a running turn coordinates in, resolved the same way postFromCurrentTurn does so
   * a claim and a post from one turn can never land on different boards. */
  private coordinationContext(
    agentId: string,
    token: unknown,
  ): { runtime: AgentRuntime; chatId: string } | { error: string } {
    if (!this.verifyTurnToken(agentId, token)) return { error: "no matching in-flight turn" };
    const runtime = this.agents.get(agentId)!;
    const turn = runtime.currentTurn;
    if (!turn) return { error: "no matching in-flight turn" };
    const chatId = isChatChannel(turn.replyChannel)
      ? turn.replyChannel.chatId
      : this.chats.defaultChatIdFor(runtime.config);
    if (!chatId) return { error: "there are no chats to coordinate in - the user has not created one" };
    return { runtime, chatId };
  }

  /** Post a visible system line into a chat, so every coordination act is auditable by the user
   * rather than happening invisibly between agents. */
  private sayInChat(chatId: string, text: string) {
    this.bus.postMessage({
      id: nanoid(),
      channel: { chatId },
      authorId: "system",
      authorHandle: "system",
      mentions: [],
      text,
      createdAt: new Date().toISOString(),
    });
  }

  claimFiles(agentId: string, token: unknown, paths: string[], note?: string) {
    const ctx = this.coordinationContext(agentId, token);
    if ("error" in ctx) return { ok: false as const, error: ctx.error };
    const { claimed, conflicts } = this.board.claim(ctx.chatId, ctx.runtime.config, paths, note);
    if (claimed.length > 0) {
      this.sayInChat(
        ctx.chatId,
        `@${ctx.runtime.config.handle} is now working in: ${claimed.join(", ")}${note ? ` (${note})` : ""}`,
      );
    }
    this.onChange?.();
    return { ok: true as const, claimed, conflicts };
  }

  releaseFiles(agentId: string, token: unknown, paths?: string[]) {
    const ctx = this.coordinationContext(agentId, token);
    if ("error" in ctx) return { ok: false as const, error: ctx.error };
    const released = this.board.release(ctx.chatId, agentId, paths);
    this.onChange?.();
    return { ok: true as const, released };
  }

  /**
   * Publish a contract, and wake anyone who was waiting for exactly this.
   *
   * The wake is the whole point: the live failure was an agent sitting idle AFTER the thing it
   * was blocked on had landed, because the agent that landed it did not think to name them.
   */
  postContract(agentId: string, token: unknown, title: string, body: string) {
    const ctx = this.coordinationContext(agentId, token);
    if ("error" in ctx) return { ok: false as const, error: ctx.error };
    if (!title.trim() || !body.trim()) {
      return { ok: false as const, error: "a contract needs both a title and a body" };
    }
    const contract = this.board.postContract(ctx.chatId, ctx.runtime.config, title, body);
    this.sayInChat(ctx.chatId, `@${ctx.runtime.config.handle} published the contract "${contract.title}".`);
    const woken = this.wake(ctx.chatId, { kind: "contract", title: contract.title, by: ctx.runtime.config.handle });
    this.onChange?.();
    return { ok: true as const, contract, woken };
  }

  blockOn(agentId: string, token: unknown, kind: Block["kind"], value: string, why?: string) {
    const ctx = this.coordinationContext(agentId, token);
    if ("error" in ctx) return { ok: false as const, error: ctx.error };
    if (!value.trim()) return { ok: false as const, error: "say what you are waiting for" };
    const block = this.board.blockOn(ctx.chatId, ctx.runtime.config, kind, value, why);
    this.sayInChat(
      ctx.chatId,
      `@${ctx.runtime.config.handle} is waiting on ${kind === "agent" ? "@" : ""}${block.value}` +
        `${why ? ` - ${why}` : ""}. It will be woken automatically when that lands.`,
    );
    // Something may ALREADY satisfy this - a file that exists, a contract posted moments ago -
    // in which case blocking would park the agent forever waiting for an event that has been
    // and gone. Checked immediately rather than only on the next event.
    const woken = this.wake(ctx.chatId, { kind: "files" });
    this.onChange?.();
    return { ok: true as const, block, wokenImmediately: woken.length > 0 };
  }

  /**
   * An announcement: everyone should know, nobody needs to answer.
   *
   * An ordinary unaddressed message summons EVERY agent in the chat, so a status update costs
   * three real billed turns. This costs none: it is posted for the user to see, and folded into
   * each other agent's context the next time they genuinely run.
   */
  announce(agentId: string, token: unknown, text: string) {
    const ctx = this.coordinationContext(agentId, token);
    if ("error" in ctx) return { ok: false as const, error: ctx.error };
    const trimmed = typeof text === "string" ? text.trim() : "";
    if (!trimmed) return { ok: false as const, error: "announcement text was empty" };
    this.bus.postMessage({
      id: nanoid(),
      channel: { chatId: ctx.chatId },
      authorId: ctx.runtime.config.id,
      authorHandle: ctx.runtime.config.handle,
      mentions: [],
      text: trimmed,
      model: ctx.runtime.lastResolvedModel ?? ctx.runtime.config.model,
      createdAt: new Date().toISOString(),
      agentKind: "announcement",
    });
    this.onChange?.();
    return { ok: true as const };
  }

  /**
   * Turn every satisfied block into a real turn for that agent.
   *
   * The woken agent is given the reason rather than a bare nudge, because it has been idle and
   * its own CLI session may or may not still remember why it stopped - see resumePrompt for the
   * same reasoning about not trusting a session to carry context across a gap.
   */
  private wake(chatId: string, event: Parameters<CoordinationBoard["resolve"]>[1]): string[] {
    const anyAgent = this.listAgents()[0];
    const cwd = anyAgent ? this.chats.workingDirectoryFor(anyAgent, chatId) : process.cwd();
    const woken = this.board.resolve(chatId, event, cwd);
    for (const { block, because } of woken) {
      if (!this.agents.has(block.agentId)) continue;
      this.sayInChat(chatId, `@${block.handle} is unblocked: ${because}.`);
      this.enqueueTurn(
        block.agentId,
        `[solace] You said you were waiting on "${block.value}"${block.why ? ` (${block.why})` : ""}. ` +
          `That has now happened: ${because}. Pick your work back up from there. ` +
          `If you are still blocked on something else, say so and call block_on again.`,
        { chatId },
        { kind: "work" },
      );
    }
    return woken.map((w) => w.block.agentId);
  }

  /** Called after a turn ends: a turn that wrote files may have satisfied a "file" block that
   * nothing else would ever re-check. */
  private wakeOnFiles(chatId: string | undefined) {
    if (!chatId) return;
    this.wake(chatId, { kind: "files" });
  }

  /**
   * An agent speaking into the group chat WHILE its turn is still running, via the solace MCP
   * bridge (mcp/solaceBridge.mjs). Until this existed, only an agent's final message of a
   * finished turn ever reached the group - a mid-work "@claude I'm proposing a restrained
   * apothecary palette..." was posted to that agent's own hub and nowhere else, and an agent
   * that announced "now I'll message the group with the direction I'm taking" had no mechanism
   * to do so at all.
   *
   * Deliberately delegates to routeChatMessage rather than posting directly: mention parsing,
   * the [no-reply] off-ramp, the chain-depth cap and the reply-to-whoever-addressed-you rule
   * all already live there, and a second, parallel copy of that logic is exactly how an agent's
   * "@codex, thoughts?" once ended up as inert text that reached nobody.
   *
   * Returns rather than throws so the caller can hand the agent a tool error it can actually
   * act on. Never awaits anything the *target* agent does: enqueueTurn only queues, so the
   * posting agent's CLI is not blocked for the duration of someone else's turn.
   */
  postFromCurrentTurn(
    agentId: string,
    token: unknown,
    text: string,
    kind?: "question" | "work" | "fyi",
  ): { ok: true } | { ok: false; reason: "no-turn" | "capped" | "empty" | "no-chat"; error: string } {
    if (!this.verifyTurnToken(agentId, token)) {
      return { ok: false, reason: "no-turn", error: "no matching in-flight turn" };
    }
    const runtime = this.agents.get(agentId)!;
    const turn = runtime.currentTurn;
    if (!turn) return { ok: false, reason: "no-turn", error: "no matching in-flight turn" };
    const trimmed = typeof text === "string" ? text.trim() : "";
    if (!trimmed) return { ok: false, reason: "empty", error: "message text was empty" };

    // The chat this turn is running for. A turn started from the agent's own hub has no chat of
    // its own, and this tool still has to reach somewhere the user will actually look - see
    // ChatStore.defaultChatIdFor for why that fallback is deterministic rather than "whichever
    // chat is open". With no chats at all there is genuinely nowhere to post, and saying so is
    // better than dropping the message and letting the agent believe it was delivered.
    const chatId = isChatChannel(turn.replyChannel)
      ? turn.replyChannel.chatId
      : this.chats.defaultChatIdFor(runtime.config);
    if (!chatId) {
      return { ok: false, reason: "no-chat", error: "there are no chats to post into - the user has not created one" };
    }

    const posts = (turn.midTurnPosts ??= []);
    // Read live, per post, not per turn: lowering the cap mid-turn takes effect on the very next
    // post rather than at the next turn boundary, which is what someone turning the volume down
    // on a chatty run actually wants.
    const { maxMidTurnPosts } = this.limits();
    if (posts.length >= maxMidTurnPosts) {
      // Explicitly refused rather than silently dropped: an agent that believes it told the
      // group something it did not tell them is worse than one that knows it was blocked.
      return {
        ok: false,
        reason: "capped",
        error:
          maxMidTurnPosts === 0
            ? "mid-turn group posts are turned off in this app's settings - say it in your final answer for this turn instead"
            : `mid-turn group posts are capped at ${maxMidTurnPosts} per turn and this turn has used all of them - say the rest in your final answer for this turn`,
      };
    }
    posts.push(trimmed);

    // "work"/"fyi" are statements, not questions, so they must not automatically bounce a turn
    // back to whoever addressed this agent - that reply path is what routeChatMessage's
    // [no-reply] marker exists to opt out of. An explicit @mention in the text still always
    // goes through, because that is a deliberate act.
    const routed = kind === "question" || END_THREAD_MARKER.test(trimmed) ? trimmed : `${trimmed}\n\n[no-reply]`;

    this.routeChatMessage(chatId, agentId, runtime.config.handle, routed, {
      broadcastIfUnmentioned: false,
      mentionChainDepth: turn.mentionChainDepth + 1,
      model: runtime.lastResolvedModel ?? runtime.config.model,
      replyTo: turn.addressedBy,
      declaredKind: kind,
    });
    return { ok: true };
  }

  /** A message sent directly to one agent's own hub - always triggers a turn for just that agent. */
  submitDirectMessage(agentId: string, text: string) {
    const runtime = this.agents.get(agentId);
    if (!runtime) return;
    const channel: ChatChannel = { agentId };
    const message: ChatMessage = {
      id: nanoid(),
      channel,
      authorId: "user",
      authorHandle: "you",
      mentions: [],
      text,
      createdAt: new Date().toISOString(),
    };
    this.bus.postMessage(message);
    // A hub message used to go through with no wrapper at all, so the same agent answered in
    // one voice in a chat and its provider's default voice here. Sent once per session, on the
    // same rule as the chat context block.
    // A hub turn has no chat and therefore no project, so it runs in the agent's own folder;
    // ask that folder's conversation whether the house style has been sent yet.
    const needsStyle = !runtime.sessions.has(sessionKey(runtime.config.cwd));
    const prompt = needsStyle ? `[how to answer here]
${HOUSE_STYLE}

${text}` : text;
    this.enqueueTurn(agentId, prompt, channel, { kind: classifyIncoming(text), inbound: true });
  }

  /**
   * A group-triggered turn used to get just the raw message text, nothing else - two agents
   * pointed at the same project had no built-in sense that the other existed, let alone what
   * it was doing, which is exactly how two agents ended up independently building competing
   * versions of the same page. This prepends real, currently-known data (the same roster
   * `/status` already reports) rather than assuming an agent will infer it from context alone.
   */
  private buildGroupPrompt(chatId: string, fromHandle: string, text: string, forAgentId: string): string {
    const runtime = this.agents.get(forAgentId);
    const self = runtime?.config;
    // The roster is the agents in THIS chat, not every agent configured in the app. Listing
    // someone an @mention here cannot actually reach would invite exactly the handoff that
    // silently goes nowhere.
    const others = this.chats.agentsForChat(chatId, this.listAgents()).filter((a) => a.id !== forAgentId);
    if (!self) {
      return `[group chat message from ${fromHandle}]: ${text}`;
    }
    // Real, live-observed problems this addresses: two agents independently built competing
    // versions of the same page with zero coordination (fixed above by the roster), and
    // separately, an agent reported "Built and launched the candle landing page at
    // http://localhost:3010" when it was not, in fact, actually running there - a claim of
    // success nobody had verified. Neither is fixable by code alone, but a direct, concrete
    // reminder in the one place every group turn passes through is the cheapest real lever
    // available.
    // The first version of this block described solace-agentic-chats at length on every single
    // turn, and the name bled straight into the work: asked to build a candle company's site,
    // an agent named the brand "Solus". The chat app is the room, not the job. So this now says
    // the minimum needed to operate in the room, names the actual working directory as the
    // project, and states outright that the tool's own name has nothing to do with it.
    const identity =
      `[group context: you are "${self.handle}", one of several AI coding agents in a shared group chat. ` +
      `You are working on the project in your working directory (${this.chats.workingDirectoryFor(self, chatId)}) - ` +
      `that project is the job. ` +
      `This chat is only the tool you and the other agents are talking through; its name, branding and purpose ` +
      `are NOT part of what you are building, so never borrow them for names, copy, or design decisions. ` +
      `Don't claim something is running, deployed, or "live" unless you've actually verified it yourself just now ` +
      `(e.g. curled the URL, ran the command) - say what you did and haven't yet checked, rather than assuming. ` +
      // An agent only gets a turn when a message reaches it, so an unaddressed remark about
      // someone's work is a message they will never see. Observed live: an agent finished and
      // said "standing by for codex's end-to-end run" without naming @codex - codex was idle,
      // was never summoned, and the run simply never happened until the operator noticed and
      // asked it directly. Naming them is not etiquette here, it is the delivery mechanism.
      `If you are waiting on another agent, blocked by one, handing work over, or saying anything about their ` +
      `work that changes what they should do next, you MUST @mention them by handle in that message - otherwise ` +
      `they never receive it and will sit idle waiting for you. Don't @mention for remarks they don't need to ` +
      `act on; an @mention costs them a turn, so use it when it changes what they do, not as a courtesy.`;
    const roster =
      others.length > 0
        ? ` Other agents here: ${others
            .map((a) => `"${a.handle}" (${a.provider})${a.currentTask ? ` - currently: ${a.currentTask}` : ""}`)
            .join("; ")}. Your reply automatically goes back to whoever just addressed you, so you don't need to ` +
          `mention them again to answer. To reach a DIFFERENT agent, you must write their handle with a literal ` +
          `"@" (e.g. "@${others[0].handle} ..."): writing their name without the "@" is just text and will not ` +
          `reach them, so if you have a question or a handoff for someone, @mention them explicitly in this reply ` +
          `rather than waiting for them to notice. When the exchange is finished and you don't need an answer back, ` +
          `end your reply with "[no-reply]" so the thread stops there instead of bouncing back and forth.` +
          // Agents could previously only discover each other's work after the fact: one wrote
          // "now I'll message the group with the direction I'm taking" and had no way to do it.
          // The tool is the mechanism; this is the only place every group turn passes through,
          // so it's where an agent finds out the mechanism exists. Phrased conditionally because
          // whether the tool is actually wired up is per-provider (see the adapters).
          ` If you have the tool "post_to_group" available (mcp__solace__post_to_group), use it to tell the ` +
          `group what you're doing WHILE you work - before you commit to a direction, when you claim or hand ` +
          `off a piece of work, or to ask someone a question you need answered during this turn - rather than ` +
          `saving it all for your final answer, which nobody sees until your whole turn ends. If you already ` +
          `@mentioned someone through that tool, do NOT repeat the same @mention in your final answer: they ` +
          `have already received it, and repeating it makes them run a second turn answering the same question. ` +
          `"list_agents" tells you who is here and whether they are mid-turn.`
        : "";
    // The house style rides along with the context block, so it follows the same
    // send-once-per-session rule and costs nothing on every later turn.
    const coordination = this.coordinationBlock(chatId, self);
    // Only the skill NAMES ride in the prompt; the descriptions are written to a file the agent
    // can read. Codex and Copilot pass the prompt in argv, and the full catalogue blew Windows'
    // ~32KB command-line limit outright - spawn ENAMETOOLONG, every Codex and Copilot turn dead.
    // This still runs for EVERY group message an
    // agent receives - so it is sent only on the first turn of a session, where "session" is
    // this agent's provider conversation for the folder it is about to work in. After that the
    // agent has already been told, and the CLI's own session carries it forward.
    const skills = this.sessionIsNew(runtime, chatId) ? `\n\n${buildSkillsPointer()}` : "";
    return `${identity}${roster}${coordination}\n\n${HOUSE_STYLE}]${skills}\n\n[group chat message from ${fromHandle}]: ${text}`;
  }

  /** Is this the first turn of this agent's conversation for the folder this chat works in?
   * Used to send once-per-session context - the skills catalogue - without re-sending it on
   * every single message. */
  private sessionIsNew(runtime: AgentRuntime | undefined, chatId: string): boolean {
    if (!runtime) return false;
    return !runtime.sessions.has(sessionKey(this.chats.workingDirectoryFor(runtime.config, chatId)));
  }

  /**
   * The board, rendered into the one place every group turn passes through.
   *
   * Everything here replaces something that was previously carried in conversation and lost:
   * contracts stop being re-asked, claims stop being merely agreed, and announcements arrive
   * without having cost anybody a turn. Emits nothing at all when the board is empty, so a chat
   * that never coordinates pays no prompt tax for the feature existing.
   */
  private coordinationBlock(chatId: string, self: AgentConfig): string {
    const state = this.board.forChat(chatId);
    const parts: string[] = [];

    if (state.contracts.length > 0) {
      parts.push(
        ` Agreed contracts (build against these; do not ask for them again): ` +
          state.contracts.map((c) => `"${c.title}" by @${c.handle}: ${c.body}`).join(" | ") +
          `.`,
      );
    }

    const owned = state.claims.filter((c) => c.agentId !== self.id);
    if (owned.length > 0) {
      parts.push(
        ` Files other agents own: ` +
          owned.map((c) => `@${c.handle} -> ${c.paths.join(", ")}${c.note ? ` (${c.note})` : ""}`).join(" | ") +
          `. Do not edit those; if you need a change there, @mention the owner and ask.`,
      );
    }
    const mine = state.claims.find((c) => c.agentId === self.id);
    if (mine) parts.push(` You own: ${mine.paths.join(", ")}.`);

    // Announcements are the whole reason that message kind exists: shown once, here, instead of
    // having summoned this agent for a real billed turn when they were posted.
    const announcements = this.board.unseenAnnouncements(
      chatId,
      self.id,
      this.bus
        .getHistoryFor({ chatId })
        .filter((m) => m.agentKind === "announcement" && m.authorId !== self.id)
        .map((m) => ({ createdAt: m.createdAt, authorHandle: m.authorHandle, text: m.text })),
    );
    if (announcements.length > 0) {
      parts.push(
        ` Since your last turn: ` +
          announcements.map((a) => `@${a.authorHandle}: ${a.text.replace(/\s+/g, " ").slice(0, 400)}`).join(" | ") +
          `. No reply is expected to these.`,
      );
      this.board.markAnnouncementsSeen(chatId, self.id, announcements[announcements.length - 1].createdAt);
    }

    if (parts.length === 0) return "";
    return (
      parts.join("") +
      ` Coordination tools, if available: "claim_files" to take a lane before you start writing, ` +
      `"post_contract" to publish a decision others build against, "announce" to tell everyone something ` +
      `that needs no answer (it costs nobody a turn), and "block_on" to say what you are waiting for - ` +
      `you will be woken automatically when it lands, so do NOT sit idle waiting.`
    );
  }

  /** Options object rather than a growing positional tail: this had already reached five
   * parameters, and the two that matter most for interrupts (`kind`, `inbound`) are exactly the
   * ones a caller must not set by accident from position. */
  private enqueueTurn(agentId: string, prompt: string, replyChannel: ChatChannel, opts: EnqueueOptions = {}) {
    const runtime = this.agents.get(agentId);
    if (!runtime) return;
    const turn: QueuedTurn = {
      id: opts.id ?? nanoid(),
      prompt,
      replyChannel,
      mentionChainDepth: opts.mentionChainDepth ?? 0,
      addressedBy: opts.addressedBy,
      sessionRetryDone: opts.sessionRetryDone,
      kind: opts.kind ?? "work",
      receivedAt: opts.receivedAt ?? new Date().toISOString(),
      resume: opts.resume,
      handover: opts.handover,
      groupMessage: opts.groupMessage,
    };
    runtime.queue.push(turn);
    // A message that arrives while the agent is ALREADY mid-turn is the only kind that can be
    // delivered cooperatively - if the agent is idle, drainQueue is about to start this turn
    // properly anyway, and putting it in pendingInbound would just race that.
    if (opts.inbound && runtime.busy) {
      runtime.pendingInbound.push(turn);
      this.armInterruptTimer(runtime);
    }
    this.onChange?.(); // so a restart before this turn even starts still finds it queued
    void this.drainQueue(agentId);
  }

  /**
   * Hand an agent every message that has arrived for it since its current turn started, as text
   * it can act on right now, and take those messages OFF its queue so they cannot also run later
   * as their own separate billed turns. Called from the solace MCP bridge's internal routes, so
   * delivery happens at a tool-call boundary the agent chose - nothing is killed and no context
   * is lost. Returns undefined when there is nothing to say, so the caller appends nothing.
   *
   * The approval bridge deliberately does NOT do this, even though it is the other per-turn
   * channel: its MCP response body is a JSON permission decision that Claude Code parses
   * strictly ({behavior:"allow"|"deny"}), and appending prose to it risks breaking the approval
   * loop itself - a far worse failure than a message arriving a few seconds later.
   */
  takeInboundNotice(agentId: string, token: unknown): string | undefined {
    const runtime = this.agents.get(agentId);
    if (!runtime || !this.verifyTurnToken(agentId, token)) return undefined;
    if (runtime.pendingInbound.length === 0) return undefined;

    // An agent answering a question finishes THAT answer before it is shown another one.
    //
    // Without this, a turn opened by "@claude what is the contract?" gets three more questions
    // pasted into it the moment it calls post_to_group, and the answer that comes back is a
    // blend addressing all four - which is why the live run produced replies like "Same stale
    // context replaying - already resolved" instead of one clean answer per question. Work and
    // FYI still ride along: those are context for what it is already doing, not competing
    // demands on the same reply. Anything held back stays queued and runs as its own turn
    // straight afterwards, so nothing is lost - it is answered one at a time instead of at once.
    //
    // Only ANOTHER AGENT's question is held back. The operator's always goes through, because
    // they are redirecting the work and waiting on the answer; making them queue behind agent
    // chatter is the starvation this whole change exists to prevent, pointed at the one person
    // who cannot be told to wait.
    const answeringAQuestion = runtime.currentTurn?.kind === "question";
    const eligible = answeringAQuestion
      ? runtime.pendingInbound.filter((t) => !(t.kind === "question" && t.addressedBy))
      : runtime.pendingInbound;
    if (eligible.length === 0) return undefined;

    // Sorted by arrival rather than trusting array order: a restore rebuilds this array from a
    // saved list, and an interrupt reorders `queue` underneath it. Arrival order is the promise
    // made to whoever sent these, so it is read off the turns themselves.
    const delivered = [...eligible].sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
    const deliveredIds = new Set(delivered.map((t) => t.id));
    runtime.pendingInbound = runtime.pendingInbound.filter((t) => !deliveredIds.has(t.id));
    runtime.queue = runtime.queue.filter((t) => !deliveredIds.has(t.id));
    // Only stand the interrupt down once no operator question is still waiting: a held-back
    // agent question never armed it, but an operator question that arrived during this delivery
    // still needs its grace period to run out rather than be silently disarmed.
    if (!runtime.pendingInbound.some((t) => t.kind === "question" && !t.addressedBy)) {
      this.clearInterruptTimer(runtime);
    }

    const lines = delivered.map((t) => {
      const who = promptAuthorHandle(t);
      const text = summarizePrompt(t.prompt).replace(/\s+/g, " ").trim();
      if (t.kind === "question") {
        return `- ${who} asked: "${text}" - answer it now with post_to_group, then continue what you were doing.`;
      }
      if (t.kind === "work") {
        return `- ${who} sent work: "${text}" - finish the file or task you are on first, then do this before you end your turn.`;
      }
      return `- ${who} said: "${text}" - no reply needed.`;
    });

    this.onChange?.(); // these are no longer outstanding queued turns
    return [
      "[solace] While you were working, these arrived for you (oldest first):",
      ...lines,
      "They have been taken off your queue and will NOT be delivered to you again, so handle them in this turn.",
    ].join("\n");
  }

  private clearInterruptTimer(runtime: AgentRuntime) {
    if (runtime.interruptTimer) clearTimeout(runtime.interruptTimer);
    runtime.interruptTimer = undefined;
  }

  /**
   * Arm the preemptive fallback for the OLDEST pending question, if one isn't armed already.
   * Anchored to that question's own receivedAt rather than to "now", so a question doesn't get
   * its grace period extended every time some later message shows up behind it.
   *
   * ONLY the operator's questions can do this. An agent's question never kills another agent's
   * turn, because doing so starves the very answer it is asking for. Observed live, in a
   * three-agent run: claude never calls a solace tool mid-turn (its transcript is Bash and Read),
   * so cooperative delivery could never reach it, so every question from codex or copilot
   * expired the grace period and hard-aborted its turn. It was interrupted four times in a row,
   * finished nothing, and posted NOTHING to the group - while the other two, blocked waiting on
   * it, kept asking, which is what kept killing it. A livelock where the asking is the thing
   * preventing the answer.
   *
   * Agent questions still arrive: they stay in pendingInbound for cooperative delivery, and
   * otherwise run as ordinary queued turns the moment the current one ends. They are delayed,
   * never dropped - which is the right trade, because an agent waiting a few minutes for a real
   * answer beats one getting an instant answer to a turn that was destroyed to produce it.
   */
  private armInterruptTimer(runtime: AgentRuntime) {
    if (runtime.interruptTimer) return;
    const candidates = runtime.pendingInbound
      .filter((t) => t.kind === "question")
      .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
    const fromOperator = candidates.filter((t) => !t.addressedBy);
    const fromAgents = candidates.filter((t) => t.addressedBy);

    // The operator's question always arms, at the configured grace. Theirs is a redirection of
    // the work and they are sitting there waiting for it.
    let oldest = fromOperator[0];
    const { interruptGraceMs, agentQuestionGraceMs } = this.limits();
    let graceMs = interruptGraceMs;

    // An agent's question arms too, but only ONCE per turn and only after a much longer wait.
    //
    // Both extremes were observed live and both were wrong. When every agent question
    // interrupted at 50s, claude was killed four times in a row, finished nothing, and posted
    // nothing - while the agents waiting on it kept asking, which is what kept killing it. When
    // none of them could interrupt, claude worked straight through eight @mentions without
    // acknowledging any of them, and the others sat blocked on an answer that was minutes away.
    //
    // So: a running turn is protected for the configured agent-question grace, long enough to
    // finish a real piece of work, and after that it stops once to answer everything waiting.
    // The once-per-turn cap is what makes it an interruption rather than a livelock - a second
    // pile-up waits for the turn that answers the first.
    if (!oldest && fromAgents[0] && !runtime.currentTurn?.agentInterruptUsed) {
      oldest = fromAgents[0];
      graceMs = agentQuestionGraceMs;
    }
    if (!oldest) return;

    const waited = Date.now() - Date.parse(oldest.receivedAt);
    const agentId = runtime.config.id;
    runtime.interruptTimer = setTimeout(
      () => {
        runtime.interruptTimer = undefined;
        this.interruptIfStillPending(agentId);
      },
      Math.max(0, graceMs - (Number.isFinite(waited) ? waited : 0)),
    );
  }

  /**
   * Tier 2: nobody picked the question up cooperatively, so kill the running turn for it. This
   * is the fallback, not the plan - it costs a killed turn and a billed resume, which is why it
   * only ever fires for a "question" and only after INTERRUPT_GRACE_MS.
   */
  private interruptIfStillPending(agentId: string) {
    const runtime = this.agents.get(agentId);
    if (!runtime) return;
    // Re-checked here rather than trusted from arming time, because the pending set can change
    // during the grace period - the question may have been delivered cooperatively in the
    // meantime, and aborting a turn for something already answered is pure waste.
    const stillWaiting = runtime.pendingInbound.filter((t) => t.kind === "question");
    if (stillWaiting.length === 0) return;
    const onlyFromAgents = stillWaiting.every((t) => t.addressedBy);
    if (onlyFromAgents && runtime.currentTurn?.agentInterruptUsed) return;
    // Nothing is actually running, so the question is about to be picked off the queue as a
    // normal turn within moments. Deliberately does NOT re-arm: re-arming on an already-expired
    // deadline is a zero-delay timer loop, and there is nothing here left to fix anyway.
    if (!runtime.busy || !runtime.activeController) return;
    // Spend the once-per-turn allowance before aborting, so the resumed turn cannot be
    // interrupted again by the next agent question that arrives while it is catching up.
    if (runtime.currentTurn && stillWaiting.every((t) => t.addressedBy)) {
      runtime.currentTurn.agentInterruptUsed = true;
    }
    runtime.abortKind = "interrupt";
    runtime.activeController.abort();
    // A killed turn must not leave a live approval card for it in the UI - same reasoning, and
    // the same call, as the MAX_TURN_MS timeout path in drainQueue.
    this.approvals?.expireForAgent(agentId);
  }

  /**
   * Queue a turn that re-runs work an interrupt cut short, or - if this work has already been
   * interrupted too many times or burned its whole time budget - stop and say so honestly.
   *
   * Ordering: the question that caused the interrupt goes to the FRONT, the resume turn goes
   * immediately behind it, and everything else keeps its arrival order behind that. The agent
   * therefore answers the question, resumes, and only then works through whatever else came in -
   * which is the behaviour the interrupt was bought for in the first place.
   */
  private scheduleResume(runtime: AgentRuntime, turn: QueuedTurn, ranForMs: number) {
    const agentId = runtime.config.id;
    if (!this.agents.has(agentId)) return; // agent removed while the turn was being torn down
    const ownChannel: ChatChannel = { agentId };
    const count = (turn.resume?.count ?? 0) + 1;
    const elapsedMs = (turn.resume?.elapsedMs ?? 0) + Math.max(0, ranForMs);
    const ofTurnId = turn.resume?.ofTurnId ?? turn.id;

    // Read live at the moment the decision is made, so raising the allowance in a tab lets work
    // that was about to be abandoned carry on instead.
    const { maxResumes, maxTurnMs } = this.limits();
    if (resumeExhausted(count, elapsedMs, maxResumes, maxTurnMs)) {
      // Never silently drop work: name exactly what was abandoned, and leave it where the
      // existing manual Retry action can pick it up unchanged.
      const why =
        count > maxResumes
          ? maxResumes === 0
            ? "resuming interrupted work is turned off in this app's settings"
            : `it has now been interrupted ${maxResumes + 1} times`
          : `it has already used its full ${Math.round(maxTurnMs / 60000)} minutes of run time across interruptions`;
      this.bus.postMessage({
        id: nanoid(),
        channel: ownChannel,
        authorId: "system",
        authorHandle: "system",
        mentions: [],
        text:
          `Stopped resuming this work because ${why}. It was NOT finished and is not being retried ` +
          `automatically: "${describeWork(turn)}" - use Retry to run it again from the start.`,
        createdAt: new Date().toISOString(),
      });
      runtime.lastFailedTurn = turn;
      this.emitStatus(agentId); // so the UI's Retry affordance actually lights up
      return;
    }

    const resumeTurn: QueuedTurn = {
      ...turn,
      id: nanoid(),
      prompt: buildResumePrompt(turn),
      receivedAt: new Date().toISOString(),
      // Reset, not carried over: MAX_MID_TURN_POSTS is a per-turn budget, and a resumed turn
      // that arrives with its group-posting budget already spent could not coordinate at all -
      // which is precisely the failure this whole feature exists to fix.
      midTurnPosts: undefined,
      resume: { ofTurnId, count, elapsedMs },
    };

    runtime.queue = insertResumeTurn(runtime.queue, resumeTurn);

    this.bus.postMessage({
      id: nanoid(),
      channel: ownChannel,
      authorId: "system",
      authorHandle: "system",
      mentions: [],
      text: `Paused this work to answer a question first - it will resume straight afterwards: "${describeWork(turn)}"`,
      createdAt: new Date().toISOString(),
    });
    this.onChange?.();
  }

  /**
   * Fold every other group message already waiting for this agent, in this same chat, into the
   * turn that is about to start.
   *
   * Observed live: claude was @mentioned eight times while it was mid-build. Each mention
   * enqueued its own turn, so it answered them one at a time, in sequence, minutes apart and
   * charged eight times - and each of those turns carried its own full copy of the context
   * block to deliver one sentence. Answering all eight in one turn is faster, cheaper, and a
   * better answer, because the agent can see that several of them are about the same thing.
   *
   * Only ARRIVED group traffic for the SAME chat is merged. A resume, a handover and a hub turn
   * each mean something specific about what the agent should be doing and merging them would
   * lose that. Order is preserved, because arrival order is the promise made to whoever sent
   * them.
   */
  private coalesceQueuedMessages(runtime: AgentRuntime, turn: QueuedTurn) {
    if (!turn.groupMessage || !isChatChannel(turn.replyChannel) || turn.resume || turn.handover) return;
    const chatId = turn.replyChannel.chatId;
    const mergeable = runtime.queue.filter(
      (t) =>
        t.groupMessage &&
        !t.resume &&
        !t.handover &&
        isChatChannel(t.replyChannel) &&
        t.replyChannel.chatId === chatId,
    );
    if (mergeable.length === 0) return;

    const ids = new Set(mergeable.map((t) => t.id));
    runtime.queue = runtime.queue.filter((t) => !ids.has(t.id));
    runtime.pendingInbound = runtime.pendingInbound.filter((t) => !ids.has(t.id));

    const all = [turn, ...mergeable];
    // The rendered prompt already ends with this turn's own message; everything else is appended
    // after it rather than re-rendering the context block, which is the whole point.
    const extra = mergeable
      .map((t) => `[group chat message from ${t.groupMessage!.from}]: ${t.groupMessage!.text}`)
      .join("\n\n");
    turn.prompt =
      `${turn.prompt}\n\n${extra}\n\n` +
      `[solace] ${all.length} messages arrived for you while you were working, all shown above in the order ` +
      `they were sent. Answer them together in this one turn - several may be about the same thing. Nothing ` +
      `else is queued behind them.`;

    if (all.some((t) => t.kind === "question")) turn.kind = "question";
    this.onChange?.();
  }

  /**
   * Pass a turn that died on a usage limit to another agent working in the same directory.
   *
   * Returns what actually happened, because the caller has to behave differently for each:
   *  - "handed-over"    somebody else now owns this work. The original agent must NOT also
   *                     schedule its own retry for it, or the same task runs twice.
   *  - "declined"       this IS a usage limit and handover IS on, but nobody could take it. An
   *                     explanation naming the working directory (and the reset time, when the
   *                     provider gave one) has already been posted, so the caller suppresses its
   *                     own generic rate-limit line and just arms the retry.
   *  - "not-applicable" handover is off, or this was some other kind of failure. Nothing was
   *                     posted and nothing changed; the caller behaves exactly as it always did.
   *
   * Double execution is prevented in three places at once: the failed turn is never re-queued on
   * the original agent (it is handed over instead), any retry already scheduled for that agent is
   * cancelled before the hand-off, and the receiving agent gets a NEW turn id, so the original
   * turn object exists in exactly one queue.
   */
  private attemptHandover(
    runtime: AgentRuntime,
    turn: QueuedTurn,
    resetAt: Date | undefined,
  ): "handed-over" | "declined" | "not-applicable" {
    if (!this.settings.get().handoverOnUsageExhausted) return "not-applicable";
    // Only genuine exhaustion. A syntax error or a bad prompt would fail the same way on a
    // second agent, so handing it on would just burn somebody else's quota on it.
    if (!looksLikeUsageExhausted(runtime.lastError)) return "not-applicable";

    const from = runtime.config;
    // Two different true statements, not one hedged one. A parseable reset time is also exactly
    // what arms the automatic retry in drainQueue, so when we have it, the work really will run
    // again on its own; when we don't, it really will sit there until someone presses Retry.
    const resetNote = resetAt
      ? ` @${from.handle}'s limit resets at ${resetAt.toLocaleTimeString()}, and this will run again automatically then.`
      : ` The provider did not say when @${from.handle}'s limit resets, so this will not run again on its own - use Retry once it has.`;
    const say = (text: string) => {
      this.bus.postMessage({
        id: nanoid(),
        channel: turn.replyChannel,
        authorId: "system",
        authorHandle: "system",
        mentions: [],
        text,
        createdAt: new Date().toISOString(),
      });
    };

    const count = (turn.handover?.count ?? 0) + 1;
    // Same live read as the enabled check at the top of this method - one settings snapshot per
    // failure, taken when the failure happens.
    const { maxHandovers } = this.limits();
    if (count > maxHandovers) {
      say(
        (maxHandovers === 0
          ? `Handing work on is limited to ${maxHandovers} times in this app's settings, so this is not being passed on. `
          : `This work has already been handed over ${maxHandovers} times and every agent that has had it ran ` +
            `out of usage, so it is not being passed on again. `) +
          `It was NOT finished: "${describeWork(turn)}".` +
          resetNote,
      );
      return "declined";
    }

    // Candidates are filtered by working directory first, then by whether they can even be
    // addressed in the chat this turn replies into - a chat filed under a project must not
    // suddenly acquire an agent it never reaches.
    const roster = this.listAgents();
    const reachable = isChatChannel(turn.replyChannel)
      ? this.chats.agentsForChat(turn.replyChannel.chatId, roster)
      : roster;
    const handoverChatId = isChatChannel(turn.replyChannel) ? turn.replyChannel.chatId : undefined;
    const cwdOf = (a: AgentConfig) => this.chats.workingDirectoryFor(a, handoverChatId);
    const candidates = eligibleHandoverAgents(from, reachable, turn, cwdOf);

    if (candidates.length === 0) {
      say(
        `@${from.handle} is out of usage and no other agent works in ${cwdOf(from)}, so this work is waiting ` +
          `rather than being handed to an agent pointed at a different project - that would mean confident ` +
          `changes in the wrong codebase.${resetNote} Waiting: "${describeWork(turn)}"`,
      );
      return "declined";
    }

    const to = candidates[0];
    // Cancel anything already armed for this turn on the original agent BEFORE handing it on.
    // The scheduled single retry and a handover are both real re-runs of the same work; exactly
    // one of them may exist.
    if (runtime.scheduledRetryTimeout) clearTimeout(runtime.scheduledRetryTimeout);
    runtime.scheduledRetryTimeout = undefined;
    runtime.scheduledRetryAt = undefined;
    // The work now belongs to somebody else, so the original agent must not also offer Retry
    // for it - that button is the manual version of the same double execution.
    runtime.lastFailedTurn = undefined;

    const trustNote =
      to.trustLevel === "plan"
        ? ` @${to.handle} runs in plan mode, so it can read and plan but cannot change any files - it may not be able to finish this.`
        : ` @${to.handle} runs at its own permission level (${to.trustLevel}), not @${from.handle}'s.`;
    // Not `resetNote`: that one promises an automatic re-run, and the re-run was just cancelled
    // in favour of this hand-off. The reset time is still stated, because it is the thing the
    // user most wants to know about the agent that dropped out.
    const whenResets = resetAt ? ` (its limit resets at ${resetAt.toLocaleTimeString()})` : "";
    say(
      `@${to.handle} is picking up @${from.handle}'s work because @${from.handle}'s provider is out of ` +
        `usage${whenResets}. Both agents work in ${cwdOf(from)}.${trustNote} @${from.handle} will NOT also ` +
        `re-run this. Handed over: "${describeWork(turn)}"`,
    );

    this.enqueueTurn(to.id, buildHandoverPrompt(turn, from.handle), turn.replyChannel, {
      mentionChainDepth: turn.mentionChainDepth,
      // Preserved so the answer still lands back with whoever actually asked, rather than the
      // thread dying because a different agent answered it.
      addressedBy: turn.addressedBy,
      kind: turn.kind,
      // `resume` is deliberately dropped: its elapsed-time budget belongs to the run that was
      // interrupted on the OTHER agent, and inheriting it would hand this fresh attempt a
      // near-expired clock for reasons that have nothing to do with it.
      handover: {
        ofTurnId: turn.handover?.ofTurnId ?? turn.id,
        count,
        // De-duplicated: on the second hop the failing agent is already in this list, and a
        // doubled id would make the chain's own record of who has had this work misleading.
        agentIds: [...new Set([...(turn.handover?.agentIds ?? []), from.id, to.id])],
      },
    });
    this.emitStatus(runtime.config.id);
    return "handed-over";
  }

  private async drainQueue(agentId: string) {
    const runtime = this.agents.get(agentId);
    if (!runtime || runtime.busy) return;
    const turn = runtime.queue.shift();
    if (turn === undefined) return;
    this.coalesceQueuedMessages(runtime, turn);
    const { prompt, replyChannel, mentionChainDepth, addressedBy } = turn;
    // It is about to run as a real turn, so it is no longer a candidate for being handed to a
    // running turn as text - without this it could be delivered a second time, as prose, after
    // it had already been answered properly.
    runtime.pendingInbound = runtime.pendingInbound.filter((t) => t.id !== turn.id);

    const turnStartedAt = Date.now();
    // Both limits are read here, as the turn begins, rather than from a value captured at boot.
    // A turn already running keeps the budget it started with (changing a timeout under a live
    // setTimeout would be a surprise in both directions); the next turn to start picks up the
    // new one, which is the "applies to a turn starting five seconds later" guarantee.
    const { maxTurnMs, idleMs } = this.limits();
    const turnBudgetMs = resumeBudgetMs(turn.resume, maxTurnMs);

    runtime.busy = true;
    runtime.currentTurn = turn;
    runtime.turnStartedAt = new Date().toISOString();
    // Written through to the persisted config, not just held in memory.
    //
    // Keeping it in memory alone still left the sidebar wrong: a server restart (which happens
    // constantly in dev) dropped it and the row fell back to the stale /task label again -
    // which is exactly the bug, reappearing every restart. Writing it through means the field
    // now genuinely means "what this agent last worked on", survives restarts, and updates
    // itself. /task still works, as a label that holds until the next turn supersedes it -
    // which is the honest scope for a value nothing else can keep true.
    const taskLine = summarizeTaskLine(describeWork(turn));
    runtime.lastTaskLine = taskLine;
    if (taskLine && runtime.config.currentTask !== taskLine) {
      this.updateAgent(runtime.config.id, { currentTask: taskLine });
    }
    runtime.abortKind = undefined; // a previous turn's reason must never leak into this one
    runtime.activeTurnToken = randomUUID();
    this.onChange?.(); // persist that this turn is now the one actually in flight
    runtime.status = "thinking";
    this.emitStatus(agentId);

    let hadError = false;
    let cancelled = false;
    /** Which limit ended the turn, so the message can say what actually happened rather than
     * quoting a duration the turn may not have reached. */
    let timedOutBecause: "idle" | "ceiling" | undefined;
    // Declared out here so the finally below can always disarm them, whatever happens inside.
    let turnTimeout: NodeJS.Timeout | undefined;
    let idleTimeout: NodeJS.Timeout | undefined;
    let lastText = "";
    const chatTurnId = isChatChannel(replyChannel) ? replyChannel.chatId : undefined;
    // Where this turn's CLI actually runs. With agents following the user between projects this
    // is the chat's project folder, not the folder the agent was created against - so the same
    // agent works on whatever project the chat belongs to. Resolved once, here, and used for
    // the spawn, the session lookup and the prompt's own statement of where it is working, so
    // those three can never disagree about which codebase the agent is in.
    const turnCwd = this.chats.workingDirectoryFor(runtime.config, chatTurnId);
    const turnSessionKey = sessionKey(turnCwd);
    const turnSessionId = runtime.sessions.get(turnSessionKey);
    const isGroupTurn = chatTurnId !== undefined;
    const ownChannel: ChatChannel = { agentId: runtime.config.id };
    // The id of the last "progress" message posted to the agent's own channel this turn. Once
    // the turn genuinely completes it is promoted to "answer" - see the promotion block at the
    // end of this method for why that can only be decided here and not while streaming.
    let lastProgressMessageId: string | undefined;
    // Stable for the whole turn, so the client can fold one turn's activity into one indicator
    // instead of inferring turn boundaries from which messages happen to sit next to each other.
    const turnId = randomUUID();
    const post = (
      channel: ChatChannel,
      text: string,
      extra: { agentKind?: ChatMessage["agentKind"]; tool?: ToolCallSummary } = {},
    ): string | undefined => {
      // The agent may have been removed while this turn was in flight (removeAgent aborts
      // the controller, but an event already queued on the microtask/event-loop can still
      // land here in the brief window before the abort actually stops the CLI child) - don't
      // let a message get written into a channel whose agent no longer exists.
      if (!this.agents.has(runtime.config.id)) return undefined;
      // Scrubbed here rather than at the call sites so every path an agent's own words take
      // into stored history goes through it - see scrubSecrets. A tool call's derived label and
      // its full argument detail are agent-originated text reaching storage by exactly the same
      // route, so they are scrubbed on the same path rather than trusted for being "metadata":
      // an API key passed as an argument to a shell command is the obvious way one leaks.
      const scrubbed = scrubSecrets(text);
      const scrubbedLabel = extra.tool ? scrubSecrets(extra.tool.label) : undefined;
      const scrubbedDetail = extra.tool ? scrubSecrets(extra.tool.detail) : undefined;
      const tool: ToolCallSummary | undefined = extra.tool
        ? { ...extra.tool, label: scrubbedLabel!.text, detail: scrubbedDetail!.text }
        : undefined;
      if (scrubbed.redacted || scrubbedLabel?.redacted || scrubbedDetail?.redacted) {
        this.bus.postMessage({
          id: nanoid(),
          channel,
          authorId: "system",
          authorHandle: "system",
          mentions: [],
          systemKind: "verification",
          text: "A saved vault secret appeared in this agent's output and was removed before it could be written to the chat history. Treat that credential as exposed to the model, and rotate it if that matters.",
          createdAt: new Date().toISOString(),
        });
      }
      const id = nanoid();
      this.bus.postMessage({
        id,
        channel,
        authorId: runtime.config.id,
        authorHandle: runtime.config.handle,
        mentions: [],
        text: scrubbed.text,
        model: runtime.lastResolvedModel ?? runtime.config.model,
        createdAt: new Date().toISOString(),
        agentKind: extra.agentKind,
        tool,
        turnId,
      });
      return id;
    };

    // getAdapter/getRawKey/adapter.runTurn can all throw (e.g. an unsupported provider+authMode
    // combination, or an adapter-internal bug) - previously nothing here was guarded, so a
    // synchronous throw became an unhandled rejection (this whole method is invoked via
    // `void this.drainQueue(...)`) that left `runtime.busy` stuck `true` forever: the agent
    // showed "thinking" permanently with no error surfaced and its queue never drained again.
    try {
      const authMode = runtime.config.authMode ?? "cli";
      const adapter = getAdapter(runtime.config.provider, authMode);
      // baseUrl is resolved from the same credential as apiKey, in the same file read: the
      // base URL is a property of the saved credential (which service the key belongs to),
      // not of the agent config - so an agent can't end up pointing a DeepSeek key at a Groq
      // endpoint.
      const secrets =
        authMode === "api-key" && runtime.config.credentialId
          ? getCredentialSecrets(WORKSPACE_ROOT, runtime.config.credentialId)
          : undefined;
      const apiKey = secrets?.key;
      const baseUrl = secrets?.baseUrl;
      const controller = new AbortController();
      runtime.activeController = controller;
      // Two separate limits, because they mean different things. The idle timer is the one
      // that fires in practice; the ceiling only catches a turn that never stops talking.
      const giveUp = (reason: "idle" | "ceiling") => {
        timedOutBecause = reason;
        runtime.abortKind = "timeout";
        controller.abort();
        // A killed turn shouldn't leave a live approval card in the UI for it.
        this.approvals?.expireForAgent(agentId);
      };
      turnTimeout = setTimeout(() => giveUp("ceiling"), turnBudgetMs);
      idleTimeout = setTimeout(() => giveUp("idle"), idleMs);
      const noteActivity = () => {
        clearTimeout(idleTimeout);
        idleTimeout = setTimeout(() => giveUp("idle"), idleMs);
      };
      await adapter.runTurn({
        cwd: turnCwd,
        prompt,
        trustLevel: runtime.config.trustLevel,
        agentId: runtime.config.id,
        agentHandle: runtime.config.handle,
        // The configured alias, NOT lastResolvedModel: what to request is the user's choice,
        // and the resolved id is only ever for display. Feeding a resolved id back as --model
        // would quietly pin the agent to one snapshot of an alias the user chose deliberately.
        model: runtime.config.model,
        effort: runtime.config.effort,
        apiKey,
        baseUrl,
        turnToken: runtime.activeTurnToken,
        sessionId: turnSessionId,
        // Only the endpoint adapters act on this - see RunTurnOptions.ownerOfPath for why a
        // claim cannot be enforced for a CLI that writes with its own built-in tools.
        ownerOfPath: chatTurnId
          ? (path: string) => this.board.conflictsFor(chatTurnId, agentId, [path])[0]?.owner
          : undefined,
        signal: controller.signal,
        onEvent: (event) => {
          noteActivity();
          if (event.type === "text" && event.text.trim()) {
            // Group chat is a coordination channel, not a transcript: it only ever sees an
            // agent's final answer for the turn, posted once the turn completes below. Every
            // intermediate message (and, for a group-triggered turn, tool-use notes too) goes
            // to the agent's own hub channel in real time so the full working is still visible
            // there. A turn addressed directly to the agent's hub already IS that "everything"
            // channel, so it posts straight through with no buffering.
            lastText = event.text;
            // Posted as "progress", never as "answer". While the stream is still open there is
            // no way to know whether this paragraph is the agent's conclusion or a line of
            // narration it is about to continue past, and marking it "answer" on the chance
            // that the stream ends here would regularly present a half-finished thought as the
            // final word. The last one is promoted after the turn closes, below.
            const id = post(isGroupTurn ? ownChannel : replyChannel, event.text, { agentKind: "progress" });
            if (id) lastProgressMessageId = id;
          } else if (event.type === "reasoning") {
            post(ownChannel, event.text, { agentKind: "reasoning" });
            // Opt-in copy into the group. Read live, per line, so turning it on mid-turn shows
            // the rest of that turn's working rather than waiting for a turn boundary. The hub
            // post above is unconditional: this setting adds a view, it never moves the record.
            if (isGroupTurn && this.settings.get().showAgentWorkInGroupChat) {
              post(replyChannel, event.text, { agentKind: "reasoning" });
            }
          } else if (event.type === "tool-use") {
            // The label comes from the provider's real tool name and real arguments; when the
            // adapter had no structured input to give (an in-stream notice), the already-built
            // description is used as the name so the row still says something true rather than
            // something invented. Text keeps the old `_used …_` wrapper so a client that predates
            // agentKind - and every already-persisted message - still renders identically.
            const summary = describeToolCall(event.toolName ?? event.description, event.input);
            post(ownChannel, `_used ${event.description}_`, { agentKind: "tool", tool: summary });
            if (isGroupTurn && this.settings.get().showAgentWorkInGroupChat) {
              post(replyChannel, `_used ${event.description}_`, { agentKind: "tool", tool: summary });
            }
          } else if (event.type === "usage") {
            runtime.lastUsage = event.usage;
            runtime.totalUsage = addUsage(runtime.totalUsage, event.usage);
          } else if (event.type === "rate-limit") {
            runtime.rateLimit = event.rateLimit;
            if (this.rateLimits.record(event.rateLimit)) {
              this.bus.emitEvent({ type: "usage:rate-limit", payload: event.rateLimit });
              this.onChange?.();
            }
            this.emitStatus(agentId);
          } else if (event.type === "cancelled") {
            // Not a failure - see AdapterEvent.cancelled. Deliberately does NOT set hadError,
            // so an aborted turn never lands in lastFailedTurn or schedules a retry.
            cancelled = true;
          } else if (event.type === "model") {
            // Push it out immediately rather than waiting for the turn to end: the whole point
            // of showing the resolved id is to answer "which model is answering me right now".
            const changed = runtime.lastResolvedModel !== event.model;
            runtime.lastResolvedModel = event.model;
            if (changed) this.emitStatus(agentId);
          } else if (event.type === "session") {
            runtime.sessions.set(turnSessionKey, event.sessionId);
            this.onChange?.();
          } else if (event.type === "error" && event.message.trim()) {
            hadError = true;
            runtime.lastError = event.message.trim();
            post(replyChannel, `error: ${event.message.trim()}`, { agentKind: "error" });
            runtime.status = "error";
            this.emitStatus(agentId);
          }
        },
      });
    } catch (err) {
      // An aborted fetch rejects rather than emitting a "cancelled" event (the API adapters
      // have no child process to kill), so the abort reason is the authority here, not the
      // shape of the throw.
      if (runtime.abortKind) {
        cancelled = true;
      } else {
        hadError = true;
        const message = err instanceof Error ? err.message : String(err);
        runtime.lastError = message;
        post(replyChannel, `error: ${message}`, { agentKind: "error" });
      }
    } finally {
      // In a finally, not after the await: if runTurn throws, both timers were still armed
      // and would fire later against a controller whose turn had already ended - aborting
      // whatever turn happened to be running by then.
      clearTimeout(turnTimeout);
      clearTimeout(idleTimeout);
      // The turn just consumed Copilot quota, and Copilot is the one provider that never says
      // so on an event - so this is the moment to go and ask. Deliberately inside the finally:
      // a turn that errored or was killed still spent the request.
      if (runtime.config.provider === "copilot-cli") this.refreshCopilotQuota();
      // A turn that wrote files may have satisfied a "file" block. Nothing else would ever
      // re-check it: the agent waiting on that path is idle by definition, so without this the
      // wake never happens and we are back to the stall this feature exists to remove.
      this.wakeOnFiles(chatTurnId);
    }

    // Captured before the cleanup at the bottom clears abortKind, and used to suppress the
    // end-of-turn routing below: a turn we killed mid-sentence has no "final answer", and
    // routing its half-finished last message into the group would hand other agents a partial
    // thought as if the agent had meant to say it.
    const wasInterrupted = cancelled && runtime.abortKind === "interrupt";

    if (cancelled) {
      // A cancelled turn is reported honestly for what it was, and deliberately skips the whole
      // failure path below: no lastFailedTurn, no Retry affordance, no rate-limit retry
      // scheduled for a turn the user chose to end. A timeout IS a real failure, so it keeps
      // the retry affordance; "stop" does not, because the user already decided. An "interrupt"
      // is not a failure either - the work was deliberately paused by us and is being requeued
      // below, so it must not set hadError, must not populate lastFailedTurn, and must not
      // schedule a rate-limit retry for a turn that never actually failed.
      if (runtime.abortKind === "timeout") {
        hadError = true;
        // Name the limit that actually fired. The old message quoted a duration the turn had
        // not necessarily reached, which read as "the provider gave up" when the truth was
        // "we stopped it".
        runtime.lastError =
          timedOutBecause === "ceiling"
            ? // Reported in whichever unit is not a lie. The budget used to be a fixed two hours,
              // so "2h" was always right; it is now configurable down to five minutes, where
              // rounding to hours would print "turn stopped after 0h".
              `turn stopped after ${formatDuration(turnBudgetMs)} - it hit this app's maximum turn length while still producing output`
            : `turn stopped: no output for ${Math.round(idleMs / 60000)} minutes, so it was treated as stuck`;
        post(replyChannel, `error: ${runtime.lastError}`, { agentKind: "error" });
      } else if (runtime.abortKind === "stop" && this.agents.has(runtime.config.id)) {
        post(ownChannel, "_stopped before this turn finished_", { agentKind: "progress" });
      }
    }

    if (wasInterrupted) this.scheduleResume(runtime, turn, Date.now() - turnStartedAt);

    // Promote this turn's last piece of prose from "progress" to "answer".
    //
    // This is the only point at which "that was the final answer" is a fact rather than a bet:
    // the stream is closed, the process exited, and nothing more is coming. It is deliberately
    // skipped when the turn failed, timed out, was stopped, or was interrupted mid-sentence -
    // in all of those cases the agent never reached a conclusion, and promoting its last
    // half-thought would dress an abandoned turn up as a finished one. Those turns keep every
    // message they produced, all rendered as the progress they actually were.
    //
    // Note this promotes an EXISTING message rather than writing a summary of the turn: the
    // words shown as the answer are always words the agent itself said.
    if (!hadError && !cancelled && lastProgressMessageId) {
      this.bus.updateMessage(lastProgressMessageId, { agentKind: "answer" });
    }

    // Recover from a stale session id exactly once, then never again for this turn. Without the
    // one-shot guard this is an infinite billed retry loop; with it, the worst case is a single
    // extra cold run of a turn that would otherwise have failed outright.
    if (hadError && turnSessionId && !turn.sessionRetryDone && looksLikeStaleSession(runtime.lastError ?? "")) {
      runtime.sessions.delete(turnSessionKey);
      runtime.lastResolvedModel = undefined;
      this.onChange?.();
      if (this.agents.has(runtime.config.id)) {
        this.bus.postMessage({
          id: nanoid(),
          channel: ownChannel,
          authorId: "system",
          authorHandle: "system",
          mentions: [],
          text: "Could not resume this agent's previous session, so it is starting a fresh one and retrying - it will not remember earlier turns.",
          createdAt: new Date().toISOString(),
        });
        runtime.queue.unshift({ ...turn, sessionRetryDone: true });
      }
      hadError = false;
      runtime.lastError = undefined;
    }

    if (hadError) {
      // Keep the exact failed turn around so it can be re-run without the human retyping it -
      // either automatically (below, only when the error text itself gave a real, parseable
      // reset time) or via the manual "Retry" action, which is always available regardless.
      runtime.lastFailedTurn = turn;
      const resetAt = parseResetTime(runtime.lastError ?? "", new Date());
      // Handover is decided first, because it is the one outcome that must REPLACE the
      // scheduled retry rather than sit alongside it - two re-runs of the same turn is the
      // failure mode this whole feature has to avoid. "declined" means handover was on and this
      // really was a usage limit, but nobody could take it: it has already said so, naming the
      // reset time, so the generic rate-limit line below would only repeat it.
      const handover = this.attemptHandover(runtime, turn, resetAt);
      if (resetAt && handover !== "handed-over") {
        runtime.scheduledRetryAt = resetAt.toISOString();
        this.emitStatus(agentId);
        runtime.scheduledRetryTimeout = setTimeout(() => {
          const stillHere = this.agents.get(agentId);
          if (!stillHere) return;
          stillHere.scheduledRetryAt = undefined;
          stillHere.scheduledRetryTimeout = undefined;
          stillHere.lastFailedTurn = undefined;
          this.enqueueTurn(agentId, turn.prompt, turn.replyChannel, {
            mentionChainDepth: turn.mentionChainDepth,
            addressedBy: turn.addressedBy,
            kind: turn.kind,
            resume: turn.resume,
            handover: turn.handover,
          });
        }, Math.max(0, resetAt.getTime() - Date.now()));
        if (handover !== "declined" && this.agents.has(runtime.config.id)) {
          this.bus.postMessage({
            id: nanoid(),
            channel: replyChannel,
            authorId: "system",
            authorHandle: "system",
            mentions: [],
            text: `That looks like a rate limit - will automatically retry the same message at ${resetAt.toLocaleTimeString()}.`,
            createdAt: new Date().toISOString(),
          });
        }
      }
    }

    // An agent that posts "@codex what palette?" mid-turn and then repeats that same sentence
    // as its final answer would hand codex the identical question twice - two real, billed
    // turns for one question. Routing the final text is skipped when it's effectively something
    // this turn already said (whitespace/case-normalised); it is not re-posted either, because
    // the group already has it.
    const alreadyPostedMidTurn =
      lastText.trim().length > 0 &&
      (turn.midTurnPosts ?? []).some((p) => normalizeForDuplicateCheck(p) === normalizeForDuplicateCheck(lastText));

    if (chatTurnId && lastText.trim() && !hadError && !alreadyPostedMidTurn && !wasInterrupted) {
      // Route the agent's own final answer through the same mention-parsing/triggering logic
      // as a human message - see routeChatMessage's doc comment for why this matters. Guard
      // against the agent having been removed while this turn was running, same reasoning as
      // the post() closure above.
      if (this.agents.has(runtime.config.id)) {
        this.routeChatMessage(chatTurnId, runtime.config.id, runtime.config.handle, lastText.trim(), {
          broadcastIfUnmentioned: false,
          mentionChainDepth: mentionChainDepth + 1,
          model: runtime.lastResolvedModel ?? runtime.config.model,
          replyTo: addressedBy,
        });
      }
    }

    // Deliberately not awaited: this does real (short) network waits, and the turn is already
    // finished - holding the agent "thinking" while we fact-check it would be worse than the
    // note arriving a couple of seconds late.
    if (lastText.trim() && !hadError && !wasInterrupted) {
      void this.checkLocalUrlClaims(runtime.config.id, lastText, replyChannel);
    }

    runtime.turnStartedAt = undefined;
    runtime.activeController = undefined;
    runtime.activeTurnToken = undefined; // a child that outlived its turn can no longer post as this agent
    runtime.abortKind = undefined;
    runtime.currentTurn = undefined;
    runtime.busy = false;
    runtime.status = hadError ? "error" : "idle";
    this.emitStatus(agentId);
    this.onChange?.(); // this turn is no longer outstanding - persist that too
    void this.drainQueue(agentId); // pick up anything queued while this turn ran
  }

  /**
   * Fact-check any localhost URL an agent just claimed, and post an honest note if nothing is
   * actually listening there - see claimCheck.ts for why a prompt-level instruction wasn't
   * enough. The note is a system message, never attributed to the agent, and only ever states
   * an observed failed connection.
   */
  private async checkLocalUrlClaims(agentId: string, text: string, channel: ChatChannel) {
    const claims = extractLiveClaims(text);
    if (claims.length === 0) return;
    const unreachable = await findUnreachableClaims(claims);
    if (unreachable.length === 0) return;
    if (!this.agents.has(agentId)) return; // agent removed while we were probing
    this.bus.postMessage({
      id: nanoid(),
      channel,
      authorId: "system",
      authorHandle: "system",
      mentions: [],
      text: unreachableClaimNotice(unreachable, new Date()),
      systemKind: "verification",
      createdAt: new Date().toISOString(),
    });
  }
}

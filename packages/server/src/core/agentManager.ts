import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { nanoid } from "nanoid";
import {
  isChatChannel,
  pathCoveredBy,
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
import { addUsage } from "./usage";
import { clearCopilotQuotaCache, getCopilotQuota } from "./copilotQuota";
import { CoordinationBoard } from "./coordination";
import { TaskBoard } from "./taskBoard";
import { buildSkillsPointer } from "./skills";
import type { Block } from "@solace/shared";
import { SettingsStore } from "./settingsStore";
import { SERVER_PORT } from "./serverPort";
import type { ApprovalRegistry } from "./approvalRegistry";
import { extractLiveClaims, findUnreachableClaims, unreachableClaimNotice } from "./claimCheck";
import { getCredentialSecrets, listSecretValues } from "./credentials";
import type { PersistedAgentSession } from "./persistence";
import {
  classFromDeclaredKind,
  classGetsATurn,
  classifyIncoming,
  classifyMessageClass,
  extractFilePaths,
  incomingKindForClass,
  type IncomingKind,
  type MessageClass,
} from "./turnIntent";
import { describeToolCall } from "./toolLabel";
import { AgentGate } from "./agentGate";
import type { ProgressDigest } from "./progressDigest";
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
  /** What the message that created this turn WAS - see turnIntent.MessageClass. Distinct from
   * `kind`, which is only ever about whether a running turn may be killed for it. Absent on
   * internal re-runs (restore, retry, wake) where no message arrived at all, and on state files
   * written before classes existed. */
  class?: MessageClass;
  /** Set only on a "finding" turn that was routed to this agent because it OWNS the file the
   * finding is about, per the coordination board's claims. That is the one non-question case
   * allowed to preempt a running turn: the owner is the only agent who can act on it, and a
   * finding sitting undelivered for a whole build is a file being edited on a wrong premise. */
  ownedFileFinding?: boolean;
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
  /**
   * How long each COMPLETED turn took, in milliseconds, this process's lifetime.
   *
   * Kept in memory only and deliberately not persisted: the point of the figure is to answer
   * "how long will this probably take", and a duration measured against a different machine
   * state, a different model or a different provider plan is not evidence about now. An empty
   * list after a restart correctly means "we do not know yet" - which the UI says rather than
   * filling in.
   */
  /** The label of the tool the in-flight turn is running, from the provider's own tool name via
   * the existing label table. Cleared when the turn ends; absent before its first tool call. */
  workingOn?: string;
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
  /**
   * Did the turn currently in flight actually DO anything - run a tool, touch a file?
   *
   * Used to reset the agent-to-agent hop counter. The cap exists to stop two agents volleying
   * pleasantries forever, but it was counting message hops alone, so four agents doing real
   * collaborative work tripped it constantly: ten "Stopped an agent-to-agent reply chain after 6
   * hops" notices in one session, each one a message that never reached its recipient. A chain
   * that is producing work is not a loop, so work resets the count and only pure talk advances it.
   */
  currentTurnDidWork?: boolean;
  /** The armed escalation for the oldest unpicked-up question in pendingInbound. Held here so
   * Stop/Remove can disarm it: auto-resuming work after the user explicitly pressed Stop would
   * be the worst possible behaviour of this whole feature. */
  interruptTimer?: NodeJS.Timeout;
  /** Which message the armed interruptTimer is for, so an OPERATOR question arriving behind an
   * agent's can re-arm at the operator's much shorter grace instead of inheriting the agent
   * one. Without it, "if (interruptTimer) return" made the operator wait out the agent-question
   * grace - four minutes by default - purely because an agent asked first. */
  interruptArmedFor?: { turnId: string; fromOperator: boolean; firesAt: number };
  /**
   * How long this agent's own completed turns actually took, in ms, most recent last.
   *
   * The ONLY source for the "~3 min" the composer shows. Deliberately per agent and never
   * pooled: a Claude turn and an OpenCode turn are not the same length, and a number borrowed
   * from another agent is exactly the kind of confident figure nobody checked that this app
   * refuses to show. Empty until this agent finishes a turn, and empty again after a restart -
   * it is not persisted, so the UI shows no estimate rather than a stale one.
   */
  turnDurationsMs: number[];
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
 * The key an agent's provider session is stored under: the CONVERSATION plus its working
 * directory.
 *
 * The directory half is normalised the same way chatStore.ts normalises paths (resolved,
 * case-folded, no trailing separator), because Windows hands us one folder as both "C:\x\y" and
 * "c:/x/y" and two spellings must not mean two cold conversations.
 *
 * The conversation half fixes a real complaint. This used to be the directory ALONE, so every
 * chat working in the same folder shared one provider session. Opening a NEW chat and giving the
 * agents the same brief got back "this looks like a replay of your original kickoff" and "it's
 * already live" - the agent answering out of the previous chat's memory, in a chat the operator
 * had created precisely to start over. A new chat is a new conversation and now starts one.
 * Within a chat, memory still carries across turns, which is the half that was working.
 *
 * The cost is honest and expected: each conversation pays one cold start. That is the price of
 * a new chat actually being new.
 */
/**
 * The inverse of sessionKey(), used only when writing state to disk.
 *
 * The separator is a NUL because it is the one byte that cannot appear in a Windows or POSIX
 * path, so a directory can never be mistaken for the conversation half or vice versa.
 */
export function splitSessionKey(key: string): [cwd: string, conversationId: string] {
  const at = key.indexOf("\u0000");
  return at === -1 ? [key, "hub"] : [key.slice(0, at), key.slice(at + 1)];
}

export function sessionKey(cwd: string, conversationId: string | undefined): string {
  const dir = resolve(cwd).toLowerCase().replace(/[\/]+$/, "");
  // A hub turn has no chat, and the agent's own 1:1 is a conversation in its own right - so it
  // gets its own stable key rather than sharing with whichever chat runs in the same folder.
  return `${dir}\u0000${conversationId ?? "hub"}`;
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
/**
 * The ports this app itself occupies, stated to agents as fact.
 *
 * The API port is read from the same env var the server binds with, so it cannot drift from
 * reality. The UI port is Vite's default and is NOT knowable from here - the web dev server is a
 * separate process this one never talks to - so it is named as the default rather than asserted
 * as certain. Both are told to agents because an agent debugging "my site is not loading" will
 * otherwise happily inspect the chat app's own server, find it healthy, and say so.
 */
const SOLACE_UI_PORT = 5173;

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
  // Ports and servers, measured: two agents each restarting a server the other was holding
  // (twice), and 22 "it's live" claims of which 4 were contradicted within fifteen messages. A
  // sentence in the chat is not a reservation and a server started inside a turn dies with it,
  // so both of those are a tool call rather than a good intention. The full reasoning lives on
  // the tools themselves; this is the pointer that makes them the first thing reached for.
  "- Never pick a port yourself. Call reserve_port - it hands you one that is genuinely free and holds it in your name, and tells you who has a port you cannot have.",
  "- Start any long-running server with start_server, not your shell. A server you start any other way is inside this turn's process tree and dies when the turn ends, so the URL is live while you write about it and dead when the user clicks it.",
  "- Any localhost URL you post is checked against a real HTTP request and badged with the status. Check it yourself first - a ✗ next to your message is worse than saying you have not verified it.",
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

/**
 * How much of an agent's final answer the GROUP is shown, when that answer is not addressed to
 * anybody.
 *
 * Agent messages measured median 282 / p90 1,359 characters across 670 real messages. The median
 * is fine; the tail is what turns a room of four into a report queue nobody reads. 600 is above
 * the median by design - most messages are untouched - and cuts the p90 to a head the room can
 * actually scan.
 *
 * Three things this cap deliberately does NOT do, each of which was a real incident:
 *   - It never truncates what another AGENT receives. A 200-character delivery cap once made an
 *     agent write its findings to a file on disk to get them across (see deliverableText).
 *   - It never touches a message addressed to someone. A message written TO you arrives whole.
 *   - It never loses the text: the agent's own hub already holds the full answer, and the group
 *     message carries fullTextInHub so the UI can link straight to it.
 */
export const GROUP_REPLY_BUDGET_CHARS = 600;

/** How many recent turn durations one agent keeps, for the queue estimate. Twenty is enough for
 * a median to stop swinging on a single long turn, and short enough that an agent whose work has
 * changed shape stops being described by what it was doing an hour ago. */
export const TURN_DURATION_SAMPLES = 20;

/**
 * The median of some durations, or undefined when there are none.
 *
 * Median, not mean, because turn durations are wildly skewed - one twelve-minute build sits
 * among a dozen forty-second answers, and a mean would report a typical wait that has never
 * once happened. Returns undefined rather than 0 for an empty list: the caller must be able to
 * tell "no history" from "instant", and the UI shows nothing for the first.
 */
export function medianMs(values: number[]): number | undefined {
  const usable = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (usable.length === 0) return undefined;
  const mid = Math.floor(usable.length / 2);
  return usable.length % 2 === 1 ? usable[mid] : Math.round((usable[mid - 1] + usable[mid]) / 2);
}

/**
 * The head of an over-budget answer, cut at a sentence or a line rather than mid-word.
 *
 * Returns undefined when nothing needed cutting, so the caller can tell "this is the whole
 * message" from "this is a head" without comparing lengths again. The cut point walks BACK from
 * the budget to the last sentence end or newline, and only falls back to a hard character cut
 * when that would throw away more than a third of the budget - a paragraph with no punctuation
 * in it should still be shown, not reduced to two words.
 */
export function capForGroup(text: string, budget: number = GROUP_REPLY_BUDGET_CHARS): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length <= budget) return undefined;
  const window = trimmed.slice(0, budget);
  const breakAt = Math.max(window.lastIndexOf("\n"), window.search(/[.!?](?=[^.!?]*$)/) + 1);
  const head = breakAt > Math.floor(budget * 0.66) ? window.slice(0, breakAt) : window;
  return head.trimEnd();
}

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
  // Cut at the marker that introduces the REAL message, rather than peeling known blocks off the
  // front one at a time.
  //
  // The old version stripped `[group context: ...]` and then expected the message marker to be
  // next. buildGroupPrompt now also inserts once-per-session blocks between them - the
  // project-context pointer, the skills pointer - so the second strip matched nothing and an
  // agent's sidebar "current task" read `[project context: this project keeps a living context
  // file at ...`. Cutting at the marker is immune to whatever else is added in front of it,
  // which is the only version of this that stays correct as the wrapper grows.
  const marker = prompt.match(/\[group chat message from [^\]]+\]:\s*/);
  if (marker?.index !== undefined) return prompt.slice(marker.index + marker[0].length);
  // A direct hub message has no wrapper at all; a group turn always carries the marker above.
  return prompt.replace(/^\[group context:.*?\]\n\n/s, "");
}

/**
 * A message being HANDED TO an agent to act on, with the prompt wrapper removed and nothing cut.
 *
 * Deliberately not summarizePrompt(). That one caps at 200 characters because it feeds the
 * sidebar's task line, and it was being reused to deliver mid-turn messages - so an agent's
 * numbered audit arrived as finding #1 and an ellipsis. Twice. Observed live:
 *   "I only received a truncated preview of your audit findings"
 *   "the group-chat notification truncates long messages, so I've now twice only gotten #1"
 * The sender eventually wrote its findings to a file on disk to get them across, burning two
 * turns to work around a 200-character cap.
 *
 * The cap here exists only because Codex and Copilot take their prompt on argv, where Windows
 * stops at ~32,764 characters for the WHOLE command line - and this is one part of a prompt that
 * already carries the group context. 12,000 leaves room for the rest. When it does bite, it says
 * so in words: a silent ellipsis is what made the original failure so hard to see from outside.
 */
export const MAX_DELIVERED_CHARS = 12_000;

/**
 * `maxChars` defaults to the constant, so every existing caller and test behaves exactly as
 * before. The manager passes the CONFIGURED value in at the moment of delivery, which is what
 * makes the setting live rather than a number captured at boot - the same shape resumeBudgetMs
 * already uses for the turn budget.
 */
/**
 * The median of a list of turn durations, or undefined when there are too few to mean anything.
 *
 * MIN_TURN_SAMPLES is the whole point of this function existing rather than being one inline
 * expression. "@claude is mid-turn - queued #2, ~3 min" is a promise, and a promise built from a
 * single previous turn is a number the app invented: one turn that happened to read a file takes
 * eight seconds and one that builds a page takes twelve minutes, and either one alone would be
 * quoted with equal confidence. Under three samples the UI is told nothing and says nothing
 * about how long the wait will be, which is the honest version of the same line.
 *
 * Median, not mean, because one twelve-minute build must not drag the estimate for the twenty
 * short turns around it.
 */
export const MIN_TURN_SAMPLES = 3;

export function medianOf(durations: number[]): number | undefined {
  if (durations.length < MIN_TURN_SAMPLES) return undefined;
  const sorted = [...durations].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

export function deliverableText(prompt: string, maxChars: number = MAX_DELIVERED_CHARS): string {
  const stripped = stripPromptWrapper(prompt).replace(/\r\n/g, "\n").trim();
  if (stripped.length <= maxChars) return stripped;
  const notice =
    `[solace: this message was ${stripped.length} characters and was cut here at ` +
    `${maxChars}. Ask the sender for the rest, or ask them to write it to a file.]`;
  return `${stripped.slice(0, maxChars)}\n\n${notice}`;
}

export function summarizePrompt(prompt: string): string {
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
export function summarizeTaskLine(work: string): string {
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
 * Order is stable roster order within each band, and puts agents that can actually change files
 * ahead of ones that cannot - a `plan` agent is a legal recipient (it may be all there is), but
 * it is the last resort rather than the first pick.
 *
 * The bands, best first, are the whole point of preferring a sibling account:
 *
 *   0. SAME provider, DIFFERENT account. The best possible recipient. The model and its
 *      behaviour match exactly, so the work continues as the same kind of work rather than in a
 *      different model's voice and habits - and the two accounts are separate real
 *      subscriptions, so the limit that just stopped the first agent does not apply here at all.
 *      Multi-account now works for 8 of the 11 CLIs (see providerAccounts.supportsMultipleAccounts),
 *      so this band is usually populated when anything is.
 *   1. A DIFFERENT provider. A real fallback: different model, different behaviour, but its own
 *      quota.
 *   2. SAME provider, SAME account (which includes two agents that both named no account at
 *      all). Last, because agents sharing one account share one real limit: the agent that just
 *      ran out is the same login, so this candidate is likely to fail on arrival. It stays
 *      eligible rather than being filtered out, because a limit can be per-model or per-window
 *      and "probably exhausted" is not "certainly exhausted" - but it is never preferred over an
 *      account that is definitely someone else's.
 */
export function handoverBand(from: AgentConfig, candidate: AgentConfig): 0 | 1 | 2 {
  if (candidate.provider !== from.provider) return 1;
  // Normalised so "undefined" and "" cannot read as two different accounts, which would promote
  // an agent on the identical default login into the best band.
  const accountOf = (a: AgentConfig) => (a.account ?? "").trim().toLowerCase();
  return accountOf(candidate) !== accountOf(from) ? 0 : 2;
}

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
  // Write-capability first, then the provider/account band. A plan-mode agent may not be able to
  // finish the work at all, which is a harder blocker than being on a busier account.
  return eligible.sort(
    (a, b) => canWrite(a) - canWrite(b) || handoverBand(from, a) - handoverBand(from, b),
  );
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
  /** See QueuedTurn.class. Absent for every internal re-run, where no message arrived. */
  class?: MessageClass;
  /** See QueuedTurn.ownedFileFinding. */
  ownedFileFinding?: boolean;
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
    class: turn.class,
    ownedFileFinding: turn.ownedFileFinding,
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

// addUsage lives in core/usage.ts now, next to the per-provider extraction it has to agree with.
// It is not a plain field-wise sum any more: every field stays absent unless a provider actually
// reported it, and a session-cumulative report (Crush) replaces the running total instead of
// being added to it. See the doc comment there.

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

  /** Muted and paused agents - see core/agentGate.ts. Public because the commands set it and
   * routing reads it; it holds two Sets of ids and no behaviour of its own. */
  readonly gate = new AgentGate();

  /** Set by index.ts. Fed the turn's real tool-use events so it can COUNT them; it is never
   * given, and never asks for, any generated text. See core/progressDigest.ts. */
  progress: ProgressDigest | null = null;

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
    /** The task board: owner, status, depends-on and files per task. Defaults to an empty
     * board for the same reason as `board` above. All of its rules live in core/taskBoard.ts;
     * what is here is the turn-token wrapper around each one, plus the context injection. */
    private tasks: TaskBoard = new TaskBoard(),
  ) {
    this.rateLimits = new RateLimitStore(initialRateLimits);
    // Unpausing has to actually run the backlog. Without this the queue would only drain when
    // the next message happened to arrive, which for an agent nobody is talking to is never -
    // /resume would look like it had silently dropped everything that piled up.
    this.gate.onResumed = (id) => void this.drainQueue(id);
    for (const config of initialAgents) {
      this.agents.set(config.id, {
        config,
        sessions: new Map(),
        status: "idle",
        busy: false,
        queue: [],
        pendingInbound: [],
        turnDurationsMs: [],
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
      // A record written before sessions were per-conversation has no conversationId, and there
      // is no way to know which chat it belonged to. Guessing would restore one chat's memory
      // into another - the exact bug this change fixes - so it is dropped, and that
      // conversation pays one cold start.
      if (!saved.conversationId) continue;
      runtime.sessions.set(sessionKey(saved.cwd, saved.conversationId), saved.sessionId);
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
      maxDeliveredChars: s.maxDeliveredChars,
    };
  }

  /** A snapshot of every agent's provider-side conversation id, for persistence.ts. */
  getPersistableSessions(): PersistedAgentSession[] {
    const out: PersistedAgentSession[] = [];
    for (const runtime of this.agents.values()) {
      for (const [key, sessionId] of runtime.sessions) {
        // The map key is the composite sessionKey() builds. Split back into its parts so the
        // stored record stays readable and so a future change to the key's shape cannot silently
        // write a mangled path into state as if it were a directory.
        const [cwd, conversationId] = splitSessionKey(key);
        out.push({
          agentId: runtime.config.id,
          provider: runtime.config.provider,
          cwd,
          conversationId,
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
      turnDurationsMs: [],
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
    // Same reasoning for tasks: a task still owned by a deleted agent is a lane nobody can
    // take, so its claimed tasks go back on the board as open. Finished ones keep their owner.
    this.tasks.forgetAgent(id);
    // A mute or a pause held against an id nobody can look up any more is state with no way out.
    this.gate.forget(id);
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
    if (!runtime) return false;

    // Stop also calls off a rate-limit retry, and works when nothing is in flight.
    //
    // It used to require an active turn, so an agent that had hit its provider's usage limit
    // could not be stopped at all: Stop answered "no turn in flight" while two re-runs of the
    // same work sat armed for whenever the quota reset. Observed live - Codex hit its limit,
    // two retries were scheduled for 1:09 AM, and there was no way to cancel them short of
    // deleting the agent or restarting the server.
    const hadScheduledRetry = Boolean(runtime.scheduledRetryTimeout || runtime.scheduledRetryAt);
    if (runtime.scheduledRetryTimeout) clearTimeout(runtime.scheduledRetryTimeout);
    runtime.scheduledRetryTimeout = undefined;
    runtime.scheduledRetryAt = undefined;
    runtime.lastFailedTurn = undefined;

    if (!runtime.activeController) {
      // Nothing was running, but a retry may have been called off - and the queue is dropped
      // either way, since "stop" on an agent with queued work and no live turn can only sensibly
      // mean "do not start any of it".
      const dropped = runtime.queue.length;
      runtime.queue = [];
      this.abandonInterruptState(runtime, true);
      if (hadScheduledRetry || dropped > 0) {
        this.emitStatus(id);
        this.onChange?.();
        return true;
      }
      return false;
    }
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
      // Carried so a re-run of this work keeps the class it was routed as - see QueuedTurn.class.
      class: turn.class,
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
    // "account" is here so /accounts can switch an agent between two logins of the same
    // provider without going through the Add-agent form. Setting it to undefined is meaningful
    // and is how /accounts @handle default puts an agent back on the CLI's own login.
    patch: Partial<Pick<AgentConfig, "trustLevel" | "currentTask" | "model" | "effort" | "authMode" | "credentialId" | "account">>,
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
      // Work waiting behind the turn in flight. Counted off the real queue rather than tracked
      // separately, so it cannot drift from what will actually run.
      queuedTurns: runtime.queue.length,
      medianTurnMs: medianOf(runtime.turnDurationsMs),
      workingOn: runtime.busy ? runtime.workingOn : undefined,
      account: runtime.config.account,
      // Resolved by provider AND account. Before, an agent that had never run a turn borrowed
      // whatever figure the provider had last reported - which, with two accounts of one
      // provider, was routinely the OTHER account's remaining quota shown against this one.
      rateLimit: runtime.rateLimit ?? this.rateLimits.get(runtime.config.provider, runtime.config.account),
      retryAt: runtime.scheduledRetryAt,
      canRetry: runtime.lastFailedTurn !== undefined,
      // Display only, and only when the provider actually told us - see AgentStatus.resolvedModel.
      resolvedModel: runtime.lastResolvedModel,
      queue: this.queueStateFor(runtime),
    };
  }

  /**
   * What a message sent to this agent right now would be queued behind, and how long that is
   * likely to take - the data behind "@claude is mid-turn - queued (#2), ~3 min".
   *
   * The position is arithmetic on real queue contents and is always reported. The duration is
   * not: it exists only once this agent has actually finished turns, and is its OWN median, not
   * a pooled one and not a default. `medianTurnMs` and `etaMs` are simply absent until then, so
   * the UI can say "queued (#2)" with no time rather than "~0 min", which would be a confident
   * number nobody measured - the exact thing the house rule forbids.
   *
   * The estimate is the median for everything ahead in the queue, plus whatever is left of the
   * in-flight turn. The in-flight remainder is floored at zero rather than going negative: a
   * turn already running longer than the median tells us the estimate has been beaten, not that
   * it will finish in the past. That case is genuinely unknowable from a median alone, and it is
   * reported as "any moment" rather than dressed up.
   */
  private queueStateFor(runtime: AgentRuntime): AgentStatus["queue"] {
    const waiting = runtime.queue.length;
    const inFlight = runtime.busy && runtime.currentTurn ? 1 : 0;
    const medianTurnMs = medianMs(runtime.turnDurationsMs);
    const samples = runtime.turnDurationsMs.length;
    const state: NonNullable<AgentStatus["queue"]> = {
      waiting,
      nextPosition: waiting + inFlight + 1,
      samples,
    };
    if (medianTurnMs === undefined) return state;
    state.medianTurnMs = medianTurnMs;
    const startedAt = runtime.turnStartedAt ? Date.parse(runtime.turnStartedAt) : NaN;
    const remainingOfCurrent =
      inFlight === 1 && Number.isFinite(startedAt) ? Math.max(0, medianTurnMs - (Date.now() - startedAt)) : 0;
    state.etaMs = remainingOfCurrent + medianTurnMs * waiting;
    return state;
  }

  private emitStatus(id: string) {
    const runtime = this.agents.get(id);
    if (!runtime) return;
    this.bus.emitEvent({ type: "agent:status", payload: this.statusFor(runtime) });
  }

  /** Human operator posts a message into one chat. No @mention reaches every agent in that chat
   * (each gets its own turn); an @mention reaches only the mentioned agent(s). */
  /**
   * `declaredKind` is what /ask exists for. Left undefined for an ordinary typed message, so
   * classifyIncoming decides as it always has - inferring a question from wording is a guess and
   * stays one. Passing it is the operator SAYING this is a question, which is what buys it the
   * interrupt-after-grace treatment in armInterruptTimer rather than a place in the queue.
   */
  submitMessage(chatId: string, authorId: string, authorHandle: string, text: string, declaredKind?: IncomingKind) {
    this.routeChatMessage(chatId, authorId, authorHandle, text, {
      broadcastIfUnmentioned: true,
      mentionChainDepth: 0,
      declaredKind,
    });
  }

  /**
   * Abort whatever this agent is doing RIGHT NOW, so that whatever was just queued for it is
   * picked up next. This is `/interrupt`: the operator saying stop, rather than a question
   * waiting out its grace period in armInterruptTimer.
   *
   * Uses exactly the same abort path as the graced interrupt (abortKind "interrupt"), so the
   * killed turn is resumed afterwards by the existing scheduleResume machinery and counts
   * against the same resume budget - a force preempt costs a real billed turn and must not be
   * able to sneak past the limit that says how often that may happen.
   *
   * Returns false when there was nothing running, which the command reports as such rather than
   * printing "interrupted" for a turn that never existed.
   */
  forcePreempt(agentId: string): boolean {
    const runtime = this.agents.get(agentId);
    if (!runtime?.busy || !runtime.activeController) return false;
    this.clearInterruptTimer(runtime);
    runtime.abortKind = "interrupt";
    runtime.activeController.abort();
    // A killed turn must not leave a live approval card for it in the UI - same reasoning and
    // the same call as every other abort path here.
    this.approvals?.expireForAgent(agentId);
    return true;
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

  /**
   * Which agents the OPERATOR has scoped this chat's current work to.
   *
   * The incident this exists for: the operator wrote "@claude @Claude2 work together to think of
   * a landing page idea". Routing was correct - only those two were given turns. But @claude's
   * reply carried mentions ['Claude2','codex','copilot'], so codex and copilot were pulled into
   * a task the operator had deliberately scoped to two agents, and each spent a real turn. From
   * the operator's side that is indistinguishable from the app ignoring their addressing.
   *
   * The agents were not misbehaving: the group context tells them an @mention is the delivery
   * mechanism and hands them a roster of everyone in the chat. So the rule has to be enforced
   * here rather than asked for in the prompt.
   *
   * Derived from history rather than held in memory, so it survives a restart: the most recent
   * HUMAN message in the chat defines the scope. No mentions on it - an unaddressed broadcast -
   * means no scope, and everyone is fair game, which is what the operator asked for by not
   * naming anyone.
   */
  private operatorScope(chatId: string): Set<string> | undefined {
    const history = this.bus.getHistoryFor({ chatId });
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i];
      if (this.agents.has(m.authorId) || m.authorId === "system") continue;
      // The most recent human message. Its mentions are the scope; none means unscoped.
      return m.mentions.length > 0 ? new Set(m.mentions) : undefined;
    }
    return undefined;
  }


  /**
   * Handles that have already spoken since the operator's most recent message.
   *
   * Used to decide who still owes a first response to the current request, which is how the
   * opener's proposal reaches the agents waiting on it even if the opener forgets to name them.
   */
  private spokenSinceOperator(chatId: string): Set<string> {
    const history = this.bus.getHistoryFor({ chatId });
    const spoken = new Set<string>();
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i];
      if (!this.agents.has(m.authorId) && m.authorId !== "system") break; // the operator's message
      if (this.agents.has(m.authorId)) spoken.add(m.authorHandle);
    }
    return spoken;
  }

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
      declaredKind?: IncomingKind | MessageClass;
      /**
       * Is this the answer to a turn that was itself a QUESTION?
       *
       * The one case where a status-shaped message must still be delivered as an ordinary
       * message. "@claude which port is it on?" can perfectly well be answered "Done - it's on
       * 4321", which classifies as status; suppressing that would leave the asker waiting
       * forever for a reply that was written, sent, and silently filed in somebody else's hub.
       * An answer that is OWED is never suppressed, whatever shape it takes.
       */
      answeringAQuestion?: boolean;
      /** The turn whose final answer this is, when it is one. Rides onto a capped group message
       * as fullTextInHub.turnId so the "full detail in hub" affordance can open the hub at the
       * exact turn rather than at the top of a long history. */
      hubTurnId?: string;
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
    // Falling back to the raw text when stripping leaves nothing put the marker ITSELF in the
    // chat: four messages reading exactly "[no-reply]", which is routing metadata rendered as
    // conversation. An agent that has nothing to add and says only "[no-reply]" has said
    // nothing, so nothing is posted - the marker still ends the thread below.
    const displayText = text.replace(END_THREAD_MARKER, "").trim();
    const isMarkerOnly = displayText.length === 0 && END_THREAD_MARKER.test(text);

    const isAgentAuthor = this.agents.has(authorId);

    // What this message IS - the axis that decides who pays a turn for it and where it shows.
    //
    // Only agent-authored traffic is classified. The operator's messages are never suppressed
    // whatever words they open with: the 36 measured noise messages (19 unasked status reports,
    // 17 acknowledgements) were all from agents, and a human typing "done" into their own chat
    // and getting silence back would be the app deciding it knew better than the person using
    // it. A sender that declared its own kind is believed either way.
    const messageClass: MessageClass = isAgentAuthor
      ? (classFromDeclaredKind(opts.declaredKind) ?? classifyMessageClass(displayText))
      : (classFromDeclaredKind(opts.declaredKind) ??
        (classifyIncoming(displayText) === "question" ? "question" : "handoff"));

    // status and ack cost nobody a turn. An ack never reaches the group at all; a status line is
    // posted so the room can fold N of them into one collapsed row, and both are written to the
    // author's own hub in full so nothing is ever only in a classifier's opinion.
    if (isAgentAuthor && !classGetsATurn(messageClass) && !isMarkerOnly && !opts.answeringAQuestion) {
      const common = {
        authorId,
        authorHandle,
        mentions,
        text: displayText,
        model: opts.model,
        createdAt: new Date().toISOString(),
      };
      // The hub copy is the record. It is posted first and unconditionally, so that if anything
      // below is ever wrong about the group the message still exists somewhere a human can read.
      this.bus.postMessage({
        ...common,
        id: nanoid(),
        channel: { agentId: authorId },
        agentKind: messageClass === "ack" ? "progress" : "status",
        turnId: opts.hubTurnId,
      });
      if (messageClass === "status") {
        this.bus.postMessage({ ...common, id: nanoid(), channel, agentKind: "status" });
      }
      return;
    }

    // Cap an unaddressed final answer for the ROOM only - see GROUP_REPLY_BUDGET_CHARS. A
    // message addressed to somebody is delivered whole, because it was written to be read by
    // that person rather than skimmed by a room.
    const addressedToSomeone = mentions.length > 0 || Boolean(opts.replyTo);
    const groupHead = isAgentAuthor && !addressedToSomeone ? capForGroup(displayText) : undefined;

    const message: ChatMessage = {
      id: nanoid(),
      channel,
      authorId,
      authorHandle,
      mentions,
      text: groupHead ?? displayText,
      model: opts.model,
      createdAt: new Date().toISOString(),
      // Group chat only ever receives an agent's completed answer for a turn (drainQueue posts
      // every intermediate line to the agent's own hub channel instead), so anything an agent
      // says here is, by construction, final. Marked rather than left blank so the group chat
      // uses the same renderer as the hub instead of relying on absence-means-answer.
      agentKind: authorId === "user" ? undefined : "answer",
      // Only set when something was actually cut, so "absent" means "this is the whole message"
      // rather than "we did not check".
      fullTextInHub: groupHead ? { chars: displayText.length, turnId: opts.hubTurnId } : undefined,
    };
    // A marker-only message still ends the thread (endsThread below reads the raw text) - it
    // just is not shown, because there is nothing in it to show.
    if (!isMarkerOnly) this.bus.postMessage(message);

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

    // An agent may not summon an agent the operator left out of this task. It may still reply to
    // anyone already in it - including whoever addressed it - so genuine collaboration between
    // the scoped agents is untouched; what is refused is widening the roster, which costs the
    // operator real turns on agents they deliberately did not ask for.
    let reachable: string[] = targets;
    if (isAgentAuthor) {
      const scope = this.operatorScope(chatId);
      if (scope) {
        // Whoever addressed this agent is always answerable, even if the operator's last message
        // did not name them - otherwise an agent could be spoken to and forbidden from replying.
        const allowed = new Set(scope);
        if (replyTarget) allowed.add(replyTarget);
        allowed.add(authorHandle);
        const refused = targets.filter((t) => !allowed.has(t));
        reachable = targets.filter((t) => allowed.has(t));
        if (refused.length > 0) {
          this.bus.postMessage({
            id: nanoid(),
            channel,
            authorId: "system",
            authorHandle: "system",
            mentions: [],
            systemKind: "verification",
            text:
              `@${authorHandle} tried to bring ${refused.map((r) => `@${r}`).join(", ")} into this, but ` +
              `you scoped this work to ${[...scope].map((r) => `@${r}`).join(", ")}. ` +
              `No turn was spent. @mention them yourself if you do want them on it.`,
            createdAt: new Date().toISOString(),
          });
        }
      }
    }
    if (reachable.length === 0 && targets.length > 0) return; // every target was out of scope

    // A FINDING - "src/api/routes.ts looks wrong" - is charged to the file's OWNER and nobody
    // else. This is the case the measured data is worst at: an agent auditing a backend posts
    // one observation, and with four agents in the room every addressed one pays a turn
    // reasoning about a file three of them do not own and must not edit (the coordination block
    // tells them so explicitly). Routing it to the owner makes one agent pay for one file.
    //
    // Falls back to the addressee whenever the board cannot answer - no claim, no file it
    // recognises, or an owner who is not in this chat. A finding that reaches the wrong agent
    // wastes a turn; a finding that reaches nobody loses a real defect report, so the fallback
    // is always "route it as it would have been routed before this existed".
    const findingOwner =
      messageClass === "finding" ? this.ownerOfFinding(chatId, authorId, displayText, memberIds) : undefined;
    const finalReach = findingOwner ? [findingOwner.handle] : reachable;

    const mutedSkipped: string[] = [];
    for (const runtime of this.agents.values()) {
      if (runtime.config.id === authorId) continue; // an agent doesn't reply to itself
      if (!memberIds.has(runtime.config.id)) continue; // works in a different project's directory
      // Muted: in the chat, addressable, and deliberately not given work. Collected rather than
      // skipped in silence - a message ADDRESSED to a muted agent that vanished without a word
      // is indistinguishable from the app losing it, which is the one thing routing must never
      // look like. An unaddressed broadcast is not announced: nobody was singled out, so there
      // is no expectation of a specific reply to explain away. See core/agentGate.ts.
      if (this.gate.isMuted(runtime.config.id)) {
        if (reachable.includes(runtime.config.handle)) mutedSkipped.push(runtime.config.handle);
        continue;
      }
      // targets empty here means an unaddressed *human* message (the broadcast case above) -
      // everyone in this chat gets a turn and decides relevance for themselves.
      if (finalReach.length > 0 && !finalReach.includes(runtime.config.handle)) continue;
      // Never hand work to an agent whose provider has already said it is out of usage: the
      // turn would fail on arrival, and failing loudly on arrival is worse than not starting,
      // because the message is consumed either way.
      const limited = this.rateLimitedUntil(runtime);
      if (limited) {
        this.sayInChat(
          chatId,
          `@${runtime.config.handle} is rate-limited by ${runtime.config.provider} until ` +
            `${limited.toLocaleTimeString()}, so nothing was sent to it. It will pick its queued work back ` +
            `up then - or @mention someone else if this cannot wait.`,
        );
        continue;
      }
      this.enqueueTurn(runtime.config.id, this.buildGroupPrompt(chatId, authorHandle, displayText, runtime.config.id), channel, {
        mentionChainDepth: opts.mentionChainDepth + 1,
        addressedBy: isAgentAuthor ? { id: authorId, handle: authorHandle } : undefined,
        // The class decides who gets a turn; the kind decides whether that turn may kill a
        // running one. Derived from the one class rather than classified twice, so the two can
        // never disagree about the same message.
        kind: incomingKindForClass(messageClass),
        class: messageClass,
        // Only an owner-routed finding preempts; a finding that fell back to the addressee is an
        // ordinary piece of work for somebody who does not own the file.
        ownedFileFinding: findingOwner?.id === runtime.config.id,
        inbound: true,
        groupMessage: { from: authorHandle, text: displayText },
      });
    }
    if (mutedSkipped.length > 0) {
      this.sayInChat(
        chatId,
        `${mutedSkipped.map((h) => `@${h}`).join(", ")} ${mutedSkipped.length === 1 ? "is" : "are"} muted, so ` +
          `that message was not routed to ${mutedSkipped.length === 1 ? "it" : "them"} and nothing was queued. ` +
          `/unmute ${mutedSkipped.map((h) => `@${h}`).join(" ")} to start routing again.`,
      );
    }
  }

  /**
   * Who owns the file a finding is about, per the coordination board's claims.
   *
   * Every file named in the message is looked up, and the FIRST one with a claim wins - a
   * finding that names three files is about the first problem the sender found, and splitting
   * one message across three agents would charge three turns for it, which is the thing this
   * whole class exists to stop.
   *
   * Never returns the author (an agent does not get a turn for its own message), never returns
   * an agent this chat cannot reach, and never returns anything at all when the board has no
   * claim covering any named file - "nobody has claimed it" is a real answer and the honest
   * response to it is to fall back to the addressee rather than to pick somebody.
   */
  private ownerOfFinding(
    chatId: string,
    authorId: string,
    text: string,
    memberIds: Set<string>,
  ): { id: string; handle: string } | undefined {
    const paths = extractFilePaths(text);
    if (paths.length === 0) return undefined;
    const claims = this.board.forChat(chatId).claims;
    for (const path of paths) {
      for (const claim of claims) {
        if (claim.agentId === authorId) continue;
        if (!memberIds.has(claim.agentId)) continue;
        if (!this.agents.has(claim.agentId)) continue;
        if (!claim.paths.some((owned) => pathCoveredBy(path, owned))) continue;
        return { id: claim.agentId, handle: claim.handle };
      }
    }
    return undefined;
  }

  /**
   * When this agent's provider says its limit resets, if it is out of usage RIGHT NOW.
   *
   * Deliberately reads only `scheduledRetryAt`, which is set from a reset time this app actually
   * parsed out of the provider's own error text on a real failed turn (see parseResetTime). The
   * rate-limit WINDOWS a provider reports during a healthy turn are a usage percentage, not a
   * refusal: an agent at 97% of its five-hour window can still run, and refusing to route to it
   * on that basis would stop work that would have succeeded. Returns undefined for a reset time
   * already in the past, so a stale value can never make an agent permanently unreachable.
   */
  private rateLimitedUntil(runtime: AgentRuntime): Date | undefined {
    if (!runtime.scheduledRetryAt) return undefined;
    const at = new Date(runtime.scheduledRetryAt);
    if (!Number.isFinite(at.getTime()) || at.getTime() <= Date.now()) return undefined;
    return at;
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

  /**
   * Who is running right now, for a tool that lives outside this class.
   *
   * The port/server registry (core/portRegistry.ts) needs exactly what coordinationContext
   * resolves - a verified in-flight turn, the agent behind it, and the chat it is coordinating
   * in - and needs it resolved the SAME way, or a port reservation and a file claim from one
   * turn could land against different chats. Rather than duplicating that resolution, or moving
   * the registry's logic in here where it does not belong, this exposes the answer.
   */
  turnContextFor(
    agentId: string,
    token: unknown,
  ): { agent: AgentConfig; chatId: string } | { error: string } {
    const ctx = this.coordinationContext(agentId, token);
    if ("error" in ctx) return { error: ctx.error };
    return { agent: ctx.runtime.config, chatId: ctx.chatId };
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
        // The agent's WORKING DIRECTORY is stated, because a bare path is ambiguous and the
        // ambiguity nearly caused real damage. One agent claimed `package.json`,
        // `astro.config.mjs`, `tsconfig.json` and `src/` for a site it was building in its own
        // folder; another read that as the Solace monorepo root - those are exactly this repo's
        // real files - and raised an urgent alarm. It took three messages and four minutes to
        // establish they were in different directories entirely. It was also the RIGHT alarm to
        // raise given what the board showed, which is the point: the board was not showing
        // enough to tell.
        `@${ctx.runtime.config.handle} is now working in: ${claimed.join(", ")} ` +
          `(under ${ctx.runtime.config.cwd})${note ? ` - ${note}` : ""}`,
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
      // The agent may or may not have typed the "@" itself - "@@Claude2" appeared in a real run
      // because it did and this added another. Normalised rather than assumed either way.
      `@${ctx.runtime.config.handle} is waiting on ` +
        `${kind === "agent" ? `@${block.value.replace(/^@+/, "")}` : block.value}` +
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

  // -------------------------------------------------------------------------------------
  // The task board
  //
  // Four thin wrappers, and nothing else. Every rule - who may claim what, what "blocked"
  // means, which tasks a finish unblocks - lives in core/taskBoard.ts, because a rule that
  // needs a live agent, a live turn and a provider process to exercise is a rule nobody tests.
  // What is here is the part that genuinely belongs to a turn: the token check, the visible
  // system line, and turning an unmet dependency into a real wake-up.
  // -------------------------------------------------------------------------------------

  createTask(agentId: string, token: unknown, input: { title: string; dependsOn?: string[]; files?: string[] }) {
    const ctx = this.coordinationContext(agentId, token);
    if ("error" in ctx) return { ok: false as const, error: ctx.error };
    const result = this.tasks.create(ctx.chatId, ctx.runtime.config.handle, input);
    if (!result.ok) return result;
    this.sayInChat(
      ctx.chatId,
      `${result.task.id} on the board: ${result.task.title} (added by @${ctx.runtime.config.handle}` +
        `${result.task.dependsOn.length ? `, after ${result.task.dependsOn.join(", ")}` : ""}).`,
    );
    this.onChange?.();
    return result;
  }

  /**
   * Claim a task, and - if it waits on something unfinished - park the claimant on the existing
   * block machinery rather than letting it start early or idle.
   *
   * The block is deliberately the SAME mechanism block_on uses. A second scheduler for task
   * dependencies would be a second thing that can forget to wake somebody, and the one that
   * forgets is the one that matters: an agent idle after the thing it waited for landed is the
   * exact failure this board exists to remove.
   */
  claimTask(agentId: string, token: unknown, taskId: string) {
    const ctx = this.coordinationContext(agentId, token);
    if ("error" in ctx) return { ok: false as const, error: ctx.error };
    const result = this.tasks.claim(ctx.chatId, ctx.runtime.config, taskId);
    if (!result.ok) return result;

    // A task's files become a real lane, not an intention. This is the whole join between the
    // two boards: "I'll take the landing page" said in prose stopped nobody, and a claim the
    // other agents can see in their context does.
    const files =
      result.task.files.length > 0
        ? this.board.claim(ctx.chatId, ctx.runtime.config, result.task.files, result.task.title)
        : { claimed: [], conflicts: [] };

    if (result.waitingOn.length === 0) {
      this.sayInChat(
        ctx.chatId,
        `@${ctx.runtime.config.handle} is on ${result.task.id}: ${result.task.title}` +
          `${files.claimed.length ? ` (files: ${files.claimed.join(", ")}, under ${ctx.runtime.config.cwd})` : ""}.`,
      );
      this.onChange?.();
      return { ...result, files, blocked: false as const };
    }

    // One block per agent, so one dependency: whichever is waited on first. Named explicitly
    // in the message so the user can see which one the wake-up will be about.
    const waitFor = result.waitingOn[0];
    this.board.blockOn(ctx.chatId, ctx.runtime.config, "task", waitFor.id, `to start ${result.task.id}`);
    this.sayInChat(
      ctx.chatId,
      `@${ctx.runtime.config.handle} owns ${result.task.id} (${result.task.title}) but cannot start it yet - ` +
        `it waits on ${result.waitingOn.map((t) => `${t.id} ${t.ownerHandle ? `@${t.ownerHandle}` : "unclaimed"}`).join(", ")}. ` +
        `It will be woken when ${waitFor.id} is finished.`,
    );
    this.onChange?.();
    return { ...result, files, blocked: true as const, waitFor };
  }

  /** Finish a task and wake everyone whose own task was waiting on it. */
  finishTask(agentId: string, token: unknown, taskId: string, result?: string) {
    const ctx = this.coordinationContext(agentId, token);
    if ("error" in ctx) return { ok: false as const, error: ctx.error };
    const done = this.tasks.finish(ctx.chatId, ctx.runtime.config, taskId, result);
    if (!done.ok) return done;
    // The lane goes back, or the next agent to need those files is blocked by somebody who has
    // finished with them.
    if (done.task.files.length > 0) this.board.release(ctx.chatId, ctx.runtime.config.id, done.task.files);
    this.sayInChat(
      ctx.chatId,
      `${done.task.id} done: ${done.task.title} (@${ctx.runtime.config.handle})` +
        `${done.task.result ? ` - ${done.task.result}` : ""}.`,
    );
    const woken = this.wake(ctx.chatId, {
      kind: "task",
      taskId: done.task.id,
      title: done.task.title,
      by: ctx.runtime.config.handle,
    });
    this.onChange?.();
    return { ...done, woken };
  }

  listTasks(agentId: string, token: unknown) {
    const ctx = this.coordinationContext(agentId, token);
    if ("error" in ctx) return { ok: false as const, error: ctx.error };
    return { ok: true as const, tasks: this.tasks.forChat(ctx.chatId) };
  }

  /** For the UI's board panel. Unlike the four above this is not a turn acting - the browser is
   * asking - so it takes a chat id and no token. */
  tasksForChat(chatId: string) {
    return this.tasks.forChat(chatId);
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
        // A "task" block was recorded by the system when this agent claimed a task with an
        // unfinished dependency, not typed by the agent - so telling it "you said you were
        // waiting" would be describing something it never did.
        (block.kind === "task"
          ? `[solace] ${block.value} was blocking a task you own${block.why ? ` (${block.why})` : ""}. `
          : `[solace] You said you were waiting on "${block.value}"${block.why ? ` (${block.why})` : ""}. `) +
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
    /** What the SENDER says this is. The bridge has carried "question" | "work" | "fyi" since
     * before message classes existed and still sends those, so both vocabularies are accepted
     * and mapped in one place - see classFromDeclaredKind. An unrecognised value is ignored and
     * the text is classified, rather than being half-believed. */
    kind?: IncomingKind | MessageClass,
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
    const declaredClass = classFromDeclaredKind(kind);
    const routed =
      declaredClass === "question" || END_THREAD_MARKER.test(trimmed) ? trimmed : `${trimmed}\n\n[no-reply]`;

    this.routeChatMessage(chatId, agentId, runtime.config.handle, routed, {
      broadcastIfUnmentioned: false,
      // A turn that ran tools is work, not a volley, so it starts the count over. Pure talk
      // still advances it, which is what the cap is actually for.
      mentionChainDepth: runtime.currentTurnDidWork ? 0 : turn.mentionChainDepth + 1,
      model: runtime.lastResolvedModel ?? runtime.config.model,
      replyTo: turn.addressedBy,
      // Same rule as the final answer: an agent that was asked something may well answer through
      // this tool mid-turn, and that answer is owed to the asker whatever shape it takes.
      answeringAQuestion: turn.kind === "question",
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
    const needsStyle = !runtime.sessions.has(sessionKey(runtime.config.cwd, undefined));
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
    // Read at build-time of the block, from the same env var index.ts binds with, so this can
    // never tell an agent a port the server is not actually on.
    const solacePorts = String(SERVER_PORT);
    const identity =
      `[group context: you are "${self.handle}", one of several AI coding agents in a shared group chat. ` +
      `You are working on the project in your working directory (${this.chats.workingDirectoryFor(self, chatId)}) - ` +
      `that project is the job. ` +
      `This chat is only the tool you and the other agents are talking through; its name, branding and purpose ` +
      `are NOT part of what you are building, so never borrow them for names, copy, or design decisions. ` +
      `Don't claim something is running, deployed, or "live" unless you've actually verified it yourself just now ` +
      `(e.g. curled the URL, ran the command) - say what you did and haven't yet checked, rather than assuming. ` +
      // Observed live, and the reason this is spelled out with real numbers: an agent was asked
      // why the site it had built was not loading, went and looked at THIS APP's own dev server,
      // found it healthy, and told the user the site was fine. Both things are "a localhost", and
      // nothing in the prompt had ever said which one was which - so the agent had no way to know
      // it was inspecting the room rather than its own work.
      `Two ports on this machine belong to the chat app you are talking through, not to your work: ` +
      `${solacePorts} is its API and ${SOLACE_UI_PORT} serves its user interface. Never bind them, never stop ` +
      `anything on them, and never report either of them as the address of what YOU built - they will always ` +
      `look healthy and they are never your site. If you start a server for your own project, choose a ` +
      `different port, say which port you chose, and verify your own URL specifically (curl that exact ` +
      `address) before calling it live. If the user says your site is not loading, re-check YOUR port - do not ` +
      `go and look at the app's ports and conclude everything is fine. ` +
      // Separately: a server started inside a turn is a child of the CLI process, and a turn that
      // is stopped or times out takes the whole process tree with it. An agent that starts a dev
      // server, reports it live (truthfully, at the time) and ends its turn leaves the user with
      // a URL that worked when it was written and is dead by the time they click it.
      `A server you start during a turn may not outlive that turn, so if you tell the user something is ` +
      `running, say plainly that it stays up only while the process does, rather than implying it is permanent. ` +
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
          // Classes are inferred from the text for every message, and the inference is
          // deliberately cautious - it only ever suppresses something short and unambiguous. An
          // agent that says outright what it is sending gets that believed instead of guessed,
          // which is both cheaper and more accurate than any wording this prompt could ask for.
          `That tool takes a "kind", and saying which is cheaper and more accurate than leaving it to be read ` +
          `off your text: "question" when you need an answer back, "work" when you are handing something on, ` +
          `and "fyi" for a progress report or an acknowledgement - an "fyi" appears in the room but summons ` +
          `NOBODY, so use it for anything that needs no reply instead of an unaddressed message that costs ` +
          `every agent here a turn. If you are reporting that a specific FILE looks wrong, name the path: that ` +
          `is routed to whoever owns that file and to nobody else. ` +
          `"list_agents" tells you who is here and whether they are mid-turn.`
        : "";
    // The house style rides along with the context block, so it follows the same
    // send-once-per-session rule and costs nothing on every later turn.
    const coordination = this.coordinationBlock(chatId, self);
    // The task board, one line per OPEN task and nothing else. This is what turns "announce
    // what you are taking" from a request in the prompt into the cheapest thing to do: the
    // agent arrives already knowing what exists, what is taken, and by whom, so the who-builds-
    // what paragraphs have nothing left to negotiate.
    //
    // Its size is a hard cap, not a guideline - see TASK_BLOCK_MAX_CHARS. Codex and Copilot
    // pass the whole prompt on argv and Windows caps a command line at ~32,764 characters;
    // this repo has already had every Codex and Copilot turn die with spawn ENAMETOOLONG from
    // an over-large context block. A board grows with the work, so it is exactly the next
    // thing that would do it.
    const taskBoard = this.tasks.contextBlock(chatId, self);
    // When the operator addresses SEVERAL agents in one message, they are asking for
    // collaboration, and the default behaviour is the opposite of it.
    //
    // Observed: "@claude @Claude2 work together to think of a landing page idea ... think back
    // and forth" produced no exchange at all. Both agents went straight to building, and the
    // first thing either said in the chat was "I've got the landing page live and verified" -
    // by which point there was nothing left to plan together. They then spent turns fighting
    // over the same port and reconciling two separate builds of one page.
    //
    // Why it happens: the group chat only ever shows an agent's FINAL answer for a turn, so an
    // agent that does its thinking and its building inside one turn is silent until it finishes.
    // Saying "post as you go" in the house style was not enough, because a turn that builds the
    // whole thing is a perfectly good turn by every other measure.
    const collaboration = this.collaborationBlock(chatId, self);
    // Only the skill NAMES ride in the prompt; the descriptions are written to a file the agent
    // can read. Codex and Copilot pass the prompt in argv, and the full catalogue blew Windows'
    // ~32KB command-line limit outright - spawn ENAMETOOLONG, every Codex and Copilot turn dead.
    // This still runs for EVERY group message an
    // agent receives - so it is sent only on the first turn of a session, where "session" is
    // this agent's provider conversation for the folder it is about to work in. After that the
    // agent has already been told, and the CLI's own session carries it forward.
    const skills = this.sessionIsNew(runtime, chatId) ? `\n\n${buildSkillsPointer()}` : "";
    // The project's own living context, from the folder this chat actually works in - so a chat
    // in repo A and one in repo B get different files and neither inherits the other's. A
    // POINTER, not the content: this file grows over months and Codex/Copilot take their prompt
    // on argv, where Windows caps the command line at ~32KB. Once per session, same rule as the
    // skills pointer, because the CLI's own conversation carries it forward after the first turn.
    return `${identity}${roster}${taskBoard}${coordination}\n\n${HOUSE_STYLE}${collaboration}]${skills}\n\n[group chat message from ${fromHandle}]: ${text}`;
  }


  /**
   * The instruction an agent gets when the operator addressed this work to more than one agent.
   *
   * Deliberately narrow: it is emitted ONLY when the operator's own message named two or more
   * agents. A single-agent request is untouched, because there is nobody to plan with and the
   * fastest useful thing is to do the work.
   */
  private collaborationBlock(chatId: string, self: AgentConfig): string {
    const scope = this.operatorScope(chatId);
    if (!scope || scope.size < 2) return "";
    const others = [...scope].filter((h) => h.toLowerCase() !== self.handle.toLowerCase());
    if (others.length === 0) return "";
    const named = others.map((h) => `@${h}`).join(", ");
    return (
      `

The operator addressed this to you AND ${named}, and every one of you is running ` +
      `RIGHT NOW, at the same time, on the same request. None of you can see the others' replies ` +
      `yet - when your turn began, they had not been written. Two agents that discover this only ` +
      `at the end produce two versions of one thing that fight over the same files and ports, ` +
      `which has actually happened here.
` +
      `So, before you commit to a direction or touch anything shared: use post_to_group to say ` +
      `what you are taking or proposing, @mentioning ${named}. That tool's reply carries whatever ` +
      `the others have said since your turn started - READ IT, and adapt to it rather than ` +
      `restating your own plan as though theirs did not exist.
` +
      `Then judge from what the operator actually asked for. If they asked you to think, plan or ` +
      `agree something TOGETHER, post your proposal and end your turn there so the others can ` +
      `answer - do not create files, start a server, or call anything live on that turn. If they ` +
      `instead gave each of you a distinct piece of work, do not wait: announce which piece you ` +
      `are taking, check nobody has claimed it, and get on with it.`
    );
  }



  /** Is this the first turn of this agent's conversation for the folder this chat works in?
   * Used to send once-per-session context - the skills catalogue - without re-sending it on
   * every single message. */
  private sessionIsNew(runtime: AgentRuntime | undefined, chatId: string): boolean {
    if (!runtime) return false;
    return !runtime.sessions.has(sessionKey(this.chats.workingDirectoryFor(runtime.config, chatId), chatId));
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
      class: opts.class,
      ownedFileFinding: opts.ownedFileFinding,
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
    if (!runtime.pendingInbound.some((t) => (t.kind === "question" || t.ownedFileFinding) && !t.addressedBy)) {
      this.clearInterruptTimer(runtime);
    }

    const lines = delivered.map((t) => {
      const who = promptAuthorHandle(t);
      // The whole message, not a 200-char preview - see deliverableText. Newlines are kept:
      // these are numbered findings and file paths, and flattening them was half of why the
      // truncated delivery read as a "preview" rather than as content.
      const text = deliverableText(t.prompt, this.limits().maxDeliveredChars);
      if (t.kind === "question") {
        return `- ${who} asked: "${text}" - answer it now with post_to_group, then continue what you were doing.`;
      }
      if (t.ownedFileFinding) {
        // Named as a finding about a file this agent OWNS, because that is why it and nobody
        // else received it - the board says the file is in this agent's lane. Told to check
        // rather than to trust: the sender is reporting what it read, not what it can change.
        return (
          `- ${who} reported a problem in a file YOU own: "${text}" - check it against what is actually ` +
          `on disk now, and say what you found. Nobody else was given this.`
        );
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
    runtime.interruptArmedFor = undefined;
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
    // An interrupt-eligible message is a question, or a finding about a file this agent OWNS.
    //
    // The finding case is new and narrow on purpose. The owner is the only agent who can act on
    // it, and the thing being reported is that the file is wrong - so every minute it waits is a
    // minute the owner may spend building on the premise it contradicts. It is NOT a question,
    // so it never gets the operator's short grace; it rides the agent-question grace and the
    // same once-per-turn cap, which is what keeps it an interruption rather than a livelock.
    const interruptible = (t: QueuedTurn) => t.kind === "question" || t.ownedFileFinding === true;
    const candidates = runtime.pendingInbound
      .filter(interruptible)
      .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
    // A finding is always from an agent - the operator's messages are never classified into a
    // suppressible or file-owner class (see routeChatMessage) - so "no addressedBy" still means
    // "from the operator", which is what the two graces below actually differ on.
    const fromOperator = candidates.filter((t) => !t.addressedBy);
    const fromAgents = candidates.filter((t) => t.addressedBy);

    // The operator's question always arms, at the configured grace. Theirs is a redirection of
    // the work and they are sitting there waiting for it.
    let oldest = fromOperator[0];
    const { interruptGraceMs, agentQuestionGraceMs } = this.limits();
    let graceMs = interruptGraceMs;

    // An already-armed timer is left alone UNLESS the operator has since asked something and the
    // armed one is an agent's.
    //
    // This is the "operator messages preempt immediately, always" rule actually holding. The old
    // guard was a bare `if (runtime.interruptTimer) return`, so an agent question arriving first
    // armed the four-minute agent grace and the operator's question - which arrived second and
    // is the one with a human sitting in front of it - silently inherited that deadline instead
    // of its own 50 seconds. The operator waited out a grace period that exists to protect turns
    // FROM agents.
    if (runtime.interruptTimer) {
      const armed = runtime.interruptArmedFor;
      if (!oldest || !armed || armed.fromOperator) return;
      const wouldFireAt = Date.now() + Math.max(0, interruptGraceMs - (Date.now() - Date.parse(oldest.receivedAt)));
      // Never push an existing deadline OUT - only ever pull it in. Re-arming to a later time
      // would turn an operator question into a delay.
      if (wouldFireAt >= armed.firesAt) return;
      this.clearInterruptTimer(runtime);
    }

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
    const delay = Math.max(0, graceMs - (Number.isFinite(waited) ? waited : 0));
    runtime.interruptArmedFor = {
      turnId: oldest.id,
      fromOperator: !oldest.addressedBy,
      firesAt: Date.now() + delay,
    };
    runtime.interruptTimer = setTimeout(() => {
      runtime.interruptTimer = undefined;
      runtime.interruptArmedFor = undefined;
      this.interruptIfStillPending(agentId);
    }, delay);
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
    const stillWaiting = runtime.pendingInbound.filter((t) => t.kind === "question" || t.ownedFileFinding === true);
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
    // Why THIS agent, stated rather than left for the user to work out from the roster. A second
    // account of the same provider is the best possible recipient and the least obvious one - the
    // two agents look identical in the sidebar apart from a label - so the message says outright
    // that the model matches and the quota does not.
    const band = handoverBand(from, to);
    const whyThisOne =
      band === 0
        ? ` Same provider (${to.provider}) on a different account${to.account ? ` ("${to.account}")` : ""}, ` +
          `so the model and its behaviour match and it has its own separate limit.`
        : band === 1
          ? ` No second account of ${from.provider} was available here, so this goes to ${to.provider} instead - ` +
            `a different model, with its own quota.`
          : ` @${to.handle} is on the SAME ${to.provider} account as @${from.handle}, so it shares the same real ` +
            `limit and may well hit it too - it was the only agent available in this directory.`;
    say(
      `@${to.handle} is picking up @${from.handle}'s work because @${from.handle}'s provider is out of ` +
        `usage${whenResets}. Both agents work in ${cwdOf(from)}.${whyThisOne}${trustNote} @${from.handle} will ` +
        `NOT also re-run this. Handed over: "${describeWork(turn)}"`,
    );

    this.enqueueTurn(to.id, buildHandoverPrompt(turn, from.handle), turn.replyChannel, {
      mentionChainDepth: turn.mentionChainDepth,
      // Preserved so the answer still lands back with whoever actually asked, rather than the
      // thread dying because a different agent answered it.
      addressedBy: turn.addressedBy,
      kind: turn.kind,
      // Carried so a re-run of this work keeps the class it was routed as - see QueuedTurn.class.
      class: turn.class,
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
    // Paused: the queue keeps filling and simply does not drain. Checked before shift() so the
    // work stays ON the queue - held, not dropped - and runs in arrival order when /resume
    // calls back in through AgentGate.onResumed. See core/agentGate.ts.
    if (this.gate.isPaused(agentId)) return;
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
    const turnSessionKey = sessionKey(turnCwd, chatTurnId);
    // Fresh per turn: a previous turn's work must not credit this one.
    runtime.currentTurnDidWork = false;
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
    // The progress digest counts this turn's real tool calls, and posts one derived line into
    // the group every few minutes of a long one. A hub turn passes chatId undefined and is
    // ignored: the hub already shows every tool call as it happens.
    this.progress?.beginTurn(agentId, runtime.config.handle, chatTurnId);
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
        account: runtime.config.account,
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
          // A heartbeat is ONLY the noteActivity() above. It exists so an adapter can say "the
          // CLI is alive" without that being mistaken for the agent having produced something,
          // so it must return before any of the handling below.
          if (event.type === "heartbeat") return;
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
            // Proof this turn is doing something rather than talking - see currentTurnDidWork.
            runtime.currentTurnDidWork = true;
            // The label comes from the provider's real tool name and real arguments; when the
            // adapter had no structured input to give (an in-stream notice), the already-built
            // description is used as the name so the row still says something true rather than
            // something invented. Text keeps the old `_used …_` wrapper so a client that predates
            // agentKind - and every already-persisted message - still renders identically.
            const summary = describeToolCall(event.toolName ?? event.description, event.input);
            // The one-line "working on:" the group shows under this agent. The same mechanically
            // derived label the transcript uses - the provider's own tool name and arguments
            // through the fixed table - never a description of intent.
            runtime.workingOn = summary.label || undefined;
            this.emitStatus(agentId);
            // The same pair, unchanged, to the digest - which counts it rather than describing
            // it. Passing the provider's own name and own arguments is the whole basis of the
            // "derived, never generated" rule: a pre-formatted string would count nothing.
            this.progress?.recordTool(agentId, event.toolName ?? event.description, event.input);
            post(ownChannel, `_used ${event.description}_`, { agentKind: "tool", tool: summary });
            if (isGroupTurn && this.settings.get().showAgentWorkInGroupChat) {
              post(replyChannel, `_used ${event.description}_`, { agentKind: "tool", tool: summary });
            }
          } else if (event.type === "usage") {
            runtime.lastUsage = event.usage;
            runtime.totalUsage = addUsage(runtime.totalUsage, event.usage);
          } else if (event.type === "rate-limit") {
            // Stamped with the account THIS turn ran on, here rather than in each adapter: the
            // runtime is the one place that certainly knows which login the CLI was pointed at
            // (accountEnv was built from this same config), so no adapter can forget to say and
            // silently file a second subscription's quota under the first. Undefined = the
            // CLI's own default login.
            const observation = { ...event.rateLimit, account: runtime.config.account };
            runtime.rateLimit = observation;
            if (this.rateLimits.record(observation)) {
              this.bus.emitEvent({ type: "usage:rate-limit", payload: observation });
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
      // Nothing is posted on close: the agent's own answer lands in the same chat moments later,
      // and a digest immediately in front of it is the duplicate-post noise chatNoise.test.ts
      // already covers. The chat-wide tally /summary reads keeps everything counted so far.
      this.progress?.endTurn(agentId);
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
            // Carried so a re-run of this work keeps the class it was routed as - see QueuedTurn.class.
            class: turn.class,
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
    const midTurnPosts = turn.midTurnPosts ?? [];
    const exactRepeat =
      lastText.trim().length > 0 &&
      midTurnPosts.some((p) => normalizeForDuplicateCheck(p) === normalizeForDuplicateCheck(lastText));

    // Exact equality was too weak. An agent that posts mid-turn and then REWORDS the same thing
    // as its final answer sails past it, which is why one session produced pairs like "@claude
    // @copilot @Claude2 I'm taking the Codex lane..." followed by "I posted my Codex lane update
    // to the group and did not touch shared files." - the same news, twice, in the same channel.
    // Roughly ten of the run's messages were that.
    //
    // So: if this turn already said something to the group, its final answer only goes there too
    // when it carries a NEW @mention - i.e. it is addressed to somebody who has not had it. The
    // agent's own hub still gets the full final answer either way, so nothing is lost; the group
    // just stops hearing it twice.
    const saidSomethingAlready = midTurnPosts.length > 0;
    const newMentions = parseMentions(
      lastText,
      this.chats.agentsForChat(chatTurnId ?? "", this.listAgents()).map((a) => a.handle),
    ).filter((h) => !midTurnPosts.some((p) => p.includes(`@${h}`)));
    const alreadyPostedMidTurn = exactRepeat || (saidSomethingAlready && newMentions.length === 0);

    if (chatTurnId && lastText.trim() && !hadError && !alreadyPostedMidTurn && !wasInterrupted) {
      // Route the agent's own final answer through the same mention-parsing/triggering logic
      // as a human message - see routeChatMessage's doc comment for why this matters. Guard
      // against the agent having been removed while this turn was running, same reasoning as
      // the post() closure above.
      if (this.agents.has(runtime.config.id)) {
        this.routeChatMessage(chatTurnId, runtime.config.id, runtime.config.handle, lastText.trim(), {
          broadcastIfUnmentioned: false,
          // Same rule as the mid-turn path: work resets the hop count, talk advances it.
          mentionChainDepth: runtime.currentTurnDidWork ? 0 : mentionChainDepth + 1,
          model: runtime.lastResolvedModel ?? runtime.config.model,
          replyTo: addressedBy,
          // Somebody asked this turn a question, so this answer is owed and is never filed away
          // as a status line however it happens to be worded.
          answeringAQuestion: turn.kind === "question",
          // This turn's id, so a group message capped to the reply budget can point the "full
          // detail in hub" affordance at the hub AT THIS TURN. Every hub message from this turn
          // already carries the same turnId, including the full-length answer being capped here.
          hubTurnId: turnId,
        });
      }
    }

    // Deliberately not awaited: this does real (short) network waits, and the turn is already
    // finished - holding the agent "thinking" while we fact-check it would be worse than the
    // note arriving a couple of seconds late.
    if (lastText.trim() && !hadError && !wasInterrupted) {
      void this.checkLocalUrlClaims(runtime.config.id, lastText, replyChannel);
    }

    // How long this turn really took, kept only when the turn actually RAN to completion.
    //
    // A turn that errored on arrival (seconds), one the user stopped, one killed for an
    // interrupt, and one that hit the idle timeout are all real events but none of them is an
    // example of how long this agent's work takes - and the median exists to answer exactly that
    // question for somebody deciding whether to wait. Feeding failures in would drag the
    // estimate toward the length of a failure, which is the one duration nobody is asking about.
    if (!hadError && !cancelled) {
      runtime.turnDurationsMs.push(Date.now() - turnStartedAt);
      if (runtime.turnDurationsMs.length > TURN_DURATION_SAMPLES) {
        runtime.turnDurationsMs = runtime.turnDurationsMs.slice(-TURN_DURATION_SAMPLES);
      }
    }

    runtime.turnStartedAt = undefined;
    runtime.workingOn = undefined;
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

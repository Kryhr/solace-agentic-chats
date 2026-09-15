import { randomUUID } from "node:crypto";
import { nanoid } from "nanoid";
import type { AgentConfig, AgentRunState, AgentStatus, ChatChannel, ChatMessage, TurnUsage } from "@solace/shared";
import { getAdapter } from "../adapters";
import { ChatBus } from "./chatBus";
import { parseMentions } from "./mentions";
import type { ApprovalRegistry } from "./approvalRegistry";
import { extractLiveClaims, findUnreachableClaims, unreachableClaimNotice } from "./claimCheck";
import { getCredentialSecrets } from "./credentials";
import type { PersistedAgentSession } from "./persistence";
import { WORKSPACE_ROOT } from "./workspace";

export interface QueuedTurn {
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
   * "@", so the reply reached nobody and the thread died silently. See routeGroupMessage. */
  addressedBy?: { id: string; handle: string };
  /** Set on the single cold retry allowed after a stale-session failure, so that retry can
   * never itself trigger another one. See looksLikeStaleSession. */
  sessionRetryDone?: boolean;
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
   * nothing was interrupted. */
  queued: QueuedTurn[];
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
  /** The provider CLI's own session id for this agent's ongoing conversation. Undefined means
   * the next turn starts cold. */
  sessionId?: string;
  /** The roster as it was last described to this agent, so the context block is re-sent when it
   * actually changed rather than on every single message. */
  lastRosterSignature?: string;
  /** The turn currently being run, if any - set right after it's popped off `queue` and
   * cleared when it finishes. Distinct from `queue` (which only holds turns waiting to
   * start) so a persistence snapshot taken mid-turn can still capture what was actually
   * running, not just what's still waiting. */
  currentTurn?: QueuedTurn;
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
}

/** Large open-ended asks (e.g. "build a whole site") can legitimately take a while, but a
 * turn must eventually end so a genuinely stuck CLI doesn't leave an agent stuck "thinking"
 * forever with no feedback. */
const MAX_TURN_MS = 15 * 60 * 1000;

/** How many agent-to-agent @mention hops are allowed before a chain is cut off. Two agents
 * mentioning each other back and forth is legitimate collaboration, not a bug - but with no
 * cap at all, it has no natural stopping point either. */
const MAX_MENTION_CHAIN_DEPTH = 6;

/** How an agent says "I'm done, don't hand this back to me" - see routeGroupMessage. Matched
 * anywhere in the reply (agents reliably put it on its own last line, but pinning it to the
 * very end would make a single trailing period silently disable the off-ramp). */
const END_THREAD_MARKER = /\[no-reply\]/i;

/** For display only (the interrupted-turn restart notice) - a prompt built by buildGroupPrompt
 * has a "[group context: ...]" block and a "[group chat message from X]: " prefix wrapped
 * around the actual message; showing that raw wrapper to the user would bury what they
 * actually said. Strips known prefixes, falls back to the raw text for anything else
 * (a direct hub message has no wrapper at all). */
function summarizePrompt(prompt: string): string {
  const stripped = prompt.replace(/^\[group context:.*?\]\n\n/s, "").replace(/^\[group chat message from [^\]]+\]:\s*/, "");
  return stripped.length > 200 ? `${stripped.slice(0, 200)}…` : stripped;
}

/**
 * Providers don't expose a queryable quota API - the only real signal a rate limit ever gives
 * is the literal sentence in the error text (mirrors the same extraction lib/errorFormat.ts
 * already does client-side for display; this is the server-side version used to actually
 * schedule a retry, not just show a headline). Returns undefined - never a guess - when the
 * message isn't clearly a rate limit, or doesn't contain a time this can confidently parse.
 */
function parseResetTime(message: string, now: Date): Date | undefined {
  if (!/usage limit|rate limit/i.test(message)) return undefined;
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
function looksLikeStaleSession(message: string): boolean {
  return /no conversation found|session .{0,40}not found|invalid session|unknown session|no session|conversation .{0,40}not found/i.test(
    message,
  );
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
 * Routing rule for the group channel (see routeGroupMessage):
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

  constructor(
    private bus: ChatBus,
    initialAgents: AgentConfig[] = [],
    private approvals?: ApprovalRegistry,
    initialQueues: PersistedAgentQueue[] = [],
    initialSessions: PersistedAgentSession[] = [],
  ) {
    for (const config of initialAgents) {
      this.agents.set(config.id, { config, status: "idle", busy: false, queue: [], totalUsage: {} });
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
      if (runtime.config.cwd !== saved.cwd || runtime.config.provider !== saved.provider) continue;
      runtime.sessionId = saved.sessionId;
    }
    for (const saved of initialQueues) {
      if (!this.agents.has(saved.agentId)) continue; // the agent itself was removed before restart
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
        this.enqueueTurn(saved.agentId, saved.inFlight.prompt, saved.inFlight.replyChannel, saved.inFlight.mentionChainDepth, saved.inFlight.addressedBy);
      }
      for (const turn of saved.queued) {
        this.enqueueTurn(saved.agentId, turn.prompt, turn.replyChannel, turn.mentionChainDepth, turn.addressedBy);
      }
    }
  }

  /** A snapshot of every agent's provider-side conversation id, for persistence.ts. */
  getPersistableSessions(): PersistedAgentSession[] {
    const out: PersistedAgentSession[] = [];
    for (const runtime of this.agents.values()) {
      if (!runtime.sessionId) continue;
      out.push({
        agentId: runtime.config.id,
        provider: runtime.config.provider,
        cwd: runtime.config.cwd,
        sessionId: runtime.sessionId,
        updatedAt: new Date().toISOString(),
      });
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
      result.push({ agentId, inFlight: runtime.currentTurn, queued: [...runtime.queue] });
    }
    return result;
  }

  addAgent(config: AgentConfig) {
    this.agents.set(config.id, { config, status: "idle", busy: false, queue: [], totalUsage: {} });
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
    if (runtime) runtime.abortKind = "stop";
    runtime?.activeController?.abort();
    if (runtime?.scheduledRetryTimeout) clearTimeout(runtime.scheduledRetryTimeout);
    this.approvals?.expireForAgent(id);
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
    if (!runtime?.sessionId) return false;
    runtime.sessionId = undefined;
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
    runtime.activeController.abort();
    this.approvals?.expireForAgent(id);
    return true;
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
    this.enqueueTurn(id, turn.prompt, turn.replyChannel, turn.mentionChainDepth, turn.addressedBy);
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

  listStatuses(): AgentStatus[] {
    return [...this.agents.values()].map((a) => this.statusFor(a));
  }

  private statusFor(runtime: AgentRuntime): AgentStatus {
    return {
      agentId: runtime.config.id,
      state: runtime.status,
      currentTask: runtime.config.currentTask,
      lastActivityAt: new Date().toISOString(),
      lastUsage: runtime.lastUsage,
      totalUsage: runtime.totalUsage,
      lastError: runtime.lastError,
      retryAt: runtime.scheduledRetryAt,
      canRetry: runtime.lastFailedTurn !== undefined,
    };
  }

  private emitStatus(id: string) {
    const runtime = this.agents.get(id);
    if (!runtime) return;
    this.bus.emitEvent({ type: "agent:status", payload: this.statusFor(runtime) });
  }

  /** Human operator posts a message into the shared group chat. No @mention reaches every
   * other agent (each gets its own turn); an @mention reaches only the mentioned agent(s). */
  submitMessage(authorId: string, authorHandle: string, text: string) {
    this.routeGroupMessage(authorId, authorHandle, text, { broadcastIfUnmentioned: true, mentionChainDepth: 0 });
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
  private routeGroupMessage(
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
    },
  ) {
    const knownHandles = [...this.agents.values()].map((a) => a.config.handle);
    const mentions = parseMentions(text, knownHandles);
    // The end-of-thread marker is routing metadata, not something the human should have to
    // read - strip it from what gets displayed, but keep the raw text for the check below.
    const displayText = text.replace(END_THREAD_MARKER, "").trim() || text.trim();

    const message: ChatMessage = {
      id: nanoid(),
      channel: "group",
      authorId,
      authorHandle,
      mentions,
      text: displayText,
      model: opts.model,
      createdAt: new Date().toISOString(),
    };
    this.bus.postMessage(message);

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

    if (opts.mentionChainDepth > MAX_MENTION_CHAIN_DEPTH) {
      if (opts.mentionChainDepth === MAX_MENTION_CHAIN_DEPTH + 1) {
        this.bus.postMessage({
          id: nanoid(),
          channel: "group",
          authorId: "system",
          authorHandle: "system",
          mentions: [],
          text: `Stopped an agent-to-agent reply chain after ${MAX_MENTION_CHAIN_DEPTH} hops to avoid a runaway loop - reply directly to continue.`,
          createdAt: new Date().toISOString(),
        });
      }
      return;
    }

    const isAgentAuthor = this.agents.has(authorId);
    for (const runtime of this.agents.values()) {
      if (runtime.config.id === authorId) continue; // an agent doesn't reply to itself
      // targets empty here means an unaddressed *human* message (the broadcast case above) -
      // everyone gets a turn and decides relevance for themselves.
      if (targets.length > 0 && !targets.includes(runtime.config.handle)) continue;
      this.enqueueTurn(
        runtime.config.id,
        this.buildGroupPrompt(authorHandle, displayText, runtime.config.id),
        "group",
        opts.mentionChainDepth + 1,
        isAgentAuthor ? { id: authorId, handle: authorHandle } : undefined,
      );
    }
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
    this.enqueueTurn(agentId, text, channel);
  }

  /**
   * A group-triggered turn used to get just the raw message text, nothing else - two agents
   * pointed at the same project had no built-in sense that the other existed, let alone what
   * it was doing, which is exactly how two agents ended up independently building competing
   * versions of the same page. This prepends real, currently-known data (the same roster
   * `/status` already reports) rather than assuming an agent will infer it from context alone.
   */
  private buildGroupPrompt(fromHandle: string, text: string, forAgentId: string): string {
    const runtime = this.agents.get(forAgentId);
    const self = runtime?.config;
    const others = [...this.agents.values()].map((a) => a.config).filter((a) => a.id !== forAgentId);
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
    const identity =
      `[group context: you are "${self.handle}" in the group chat for solace-agentic-chats, an open-source, ` +
      `local multi-agent hub (like an open-source Claude Desktop) - this chat is the actual product, not a demo. ` +
      `Don't claim something is running, deployed, or "live" unless you've actually verified it yourself just now ` +
      `(e.g. curled the URL, ran the command) - say what you did and haven't yet checked, rather than assuming.`;
    const roster =
      others.length > 0
        ? ` Other agents here: ${others
            .map((a) => `"${a.handle}" (${a.provider})${a.currentTask ? ` - currently: ${a.currentTask}` : ""}`)
            .join("; ")}. Your reply automatically goes back to whoever just addressed you, so you don't need to ` +
          `mention them again to answer. To reach a DIFFERENT agent, you must write their handle with a literal ` +
          `"@" (e.g. "@${others[0].handle} ..."): writing their name without the "@" is just text and will not ` +
          `reach them, so if you have a question or a handoff for someone, @mention them explicitly in this reply ` +
          `rather than waiting for them to notice. When the exchange is finished and you don't need an answer back, ` +
          `end your reply with "[no-reply]" so the thread stops there instead of bouncing back and forth.`
        : "";
    return `${identity}${roster}]\n\n[group chat message from ${fromHandle}]: ${text}`;
  }

  private enqueueTurn(
    agentId: string,
    prompt: string,
    replyChannel: ChatChannel,
    mentionChainDepth = 0,
    addressedBy?: { id: string; handle: string },
  ) {
    const runtime = this.agents.get(agentId);
    if (!runtime) return;
    runtime.queue.push({ prompt, replyChannel, mentionChainDepth, addressedBy });
    this.onChange?.(); // so a restart before this turn even starts still finds it queued
    void this.drainQueue(agentId);
  }

  private async drainQueue(agentId: string) {
    const runtime = this.agents.get(agentId);
    if (!runtime || runtime.busy) return;
    const turn = runtime.queue.shift();
    if (turn === undefined) return;
    const { prompt, replyChannel, mentionChainDepth, addressedBy } = turn;

    runtime.busy = true;
    runtime.currentTurn = turn;
    runtime.abortKind = undefined; // a previous turn's reason must never leak into this one
    runtime.activeTurnToken = randomUUID();
    this.onChange?.(); // persist that this turn is now the one actually in flight
    runtime.status = "thinking";
    this.emitStatus(agentId);

    let hadError = false;
    let cancelled = false;
    let lastText = "";
    const isGroupTurn = replyChannel === "group";
    const ownChannel: ChatChannel = { agentId: runtime.config.id };
    const post = (channel: ChatChannel, text: string) => {
      // The agent may have been removed while this turn was in flight (removeAgent aborts
      // the controller, but an event already queued on the microtask/event-loop can still
      // land here in the brief window before the abort actually stops the CLI child) - don't
      // let a message get written into a channel whose agent no longer exists.
      if (!this.agents.has(runtime.config.id)) return;
      this.bus.postMessage({
        id: nanoid(),
        channel,
        authorId: runtime.config.id,
        authorHandle: runtime.config.handle,
        mentions: [],
        text,
        model: runtime.lastResolvedModel ?? runtime.config.model,
        createdAt: new Date().toISOString(),
      });
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
      const turnTimeout = setTimeout(() => {
        runtime.abortKind = "timeout";
        controller.abort();
        // A killed turn shouldn't leave a live approval card in the UI for it.
        this.approvals?.expireForAgent(agentId);
      }, MAX_TURN_MS);
      await adapter.runTurn({
        cwd: runtime.config.cwd,
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
        sessionId: runtime.sessionId,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === "text" && event.text.trim()) {
            // Group chat is a coordination channel, not a transcript: it only ever sees an
            // agent's final answer for the turn, posted once the turn completes below. Every
            // intermediate message (and, for a group-triggered turn, tool-use notes too) goes
            // to the agent's own hub channel in real time so the full working is still visible
            // there. A turn addressed directly to the agent's hub already IS that "everything"
            // channel, so it posts straight through with no buffering.
            lastText = event.text;
            post(isGroupTurn ? ownChannel : replyChannel, event.text);
          } else if (event.type === "tool-use") {
            post(ownChannel, `_used ${event.description}_`);
          } else if (event.type === "usage") {
            runtime.lastUsage = event.usage;
            runtime.totalUsage = addUsage(runtime.totalUsage, event.usage);
          } else if (event.type === "cancelled") {
            // Not a failure - see AdapterEvent.cancelled. Deliberately does NOT set hadError,
            // so an aborted turn never lands in lastFailedTurn or schedules a retry.
            cancelled = true;
          } else if (event.type === "model") {
            runtime.lastResolvedModel = event.model;
          } else if (event.type === "session") {
            runtime.sessionId = event.sessionId;
            this.onChange?.();
          } else if (event.type === "error" && event.message.trim()) {
            hadError = true;
            runtime.lastError = event.message.trim();
            post(replyChannel, `error: ${event.message.trim()}`);
            runtime.status = "error";
            this.emitStatus(agentId);
          }
        },
      });
      clearTimeout(turnTimeout);
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
        post(replyChannel, `error: ${message}`);
      }
    }

    if (cancelled) {
      // A cancelled turn is reported honestly for what it was, and deliberately skips the whole
      // failure path below: no lastFailedTurn, no Retry affordance, no rate-limit retry
      // scheduled for a turn the user chose to end. A timeout IS a real failure, so it keeps
      // the retry affordance; "stop" does not, because the user already decided.
      if (runtime.abortKind === "timeout") {
        hadError = true;
        runtime.lastError = `turn stopped after ${Math.round(MAX_TURN_MS / 60000)} minutes without finishing`;
        post(replyChannel, `error: ${runtime.lastError}`);
      } else if (runtime.abortKind === "stop" && this.agents.has(runtime.config.id)) {
        post(ownChannel, "_stopped before this turn finished_");
      }
    }

    // Recover from a stale session id exactly once, then never again for this turn. Without the
    // one-shot guard this is an infinite billed retry loop; with it, the worst case is a single
    // extra cold run of a turn that would otherwise have failed outright.
    if (hadError && runtime.sessionId && !turn.sessionRetryDone && looksLikeStaleSession(runtime.lastError ?? "")) {
      runtime.sessionId = undefined;
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
      if (resetAt) {
        runtime.scheduledRetryAt = resetAt.toISOString();
        this.emitStatus(agentId);
        runtime.scheduledRetryTimeout = setTimeout(() => {
          const stillHere = this.agents.get(agentId);
          if (!stillHere) return;
          stillHere.scheduledRetryAt = undefined;
          stillHere.scheduledRetryTimeout = undefined;
          stillHere.lastFailedTurn = undefined;
          this.enqueueTurn(agentId, turn.prompt, turn.replyChannel, turn.mentionChainDepth, turn.addressedBy);
        }, Math.max(0, resetAt.getTime() - Date.now()));
        if (this.agents.has(runtime.config.id)) {
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

    if (isGroupTurn && lastText.trim() && !hadError) {
      // Route the agent's own final answer through the same mention-parsing/triggering logic
      // as a human message - see routeGroupMessage's doc comment for why this matters. Guard
      // against the agent having been removed while this turn was running, same reasoning as
      // the post() closure above.
      if (this.agents.has(runtime.config.id)) {
        this.routeGroupMessage(runtime.config.id, runtime.config.handle, lastText.trim(), {
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
    if (lastText.trim() && !hadError) {
      void this.checkLocalUrlClaims(runtime.config.id, lastText, replyChannel);
    }

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

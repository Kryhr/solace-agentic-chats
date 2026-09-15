import { nanoid } from "nanoid";
import type { AgentConfig, AgentRunState, AgentStatus, ChatChannel, ChatMessage, TurnUsage } from "@solace/shared";
import { getAdapter } from "../adapters";
import { ChatBus } from "./chatBus";
import { parseMentions } from "./mentions";
import type { ApprovalRegistry } from "./approvalRegistry";
import { getRawKey } from "./credentials";
import { WORKSPACE_ROOT } from "./workspace";

export interface QueuedTurn {
  prompt: string;
  replyChannel: ChatChannel;
  /** How many agent-to-agent @mention hops led to this turn (0 for a human-triggered turn).
   * Two agents can legitimately keep mentioning each other back and forth; this caps that
   * chain instead of letting it run forever - see MAX_MENTION_CHAIN_DEPTH. */
  mentionChainDepth: number;
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
 *   - An agent's own reply only triggers another agent when it explicitly @mentions them -
 *     never on no-mention, so two agents replying-with-no-mention can't cascade into everyone
 *     replying to everyone forever. A capped mention-chain depth guards the explicit-mention
 *     case too, since two agents can otherwise keep mentioning each other indefinitely.
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
        this.enqueueTurn(saved.agentId, saved.inFlight.prompt, saved.inFlight.replyChannel, saved.inFlight.mentionChainDepth);
      }
      for (const turn of saved.queued) {
        this.enqueueTurn(saved.agentId, turn.prompt, turn.replyChannel, turn.mentionChainDepth);
      }
    }
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
    runtime?.activeController?.abort();
    if (runtime?.scheduledRetryTimeout) clearTimeout(runtime.scheduledRetryTimeout);
    this.approvals?.expireForAgent(id);
    this.agents.delete(id);
    this.bus.emitEvent({ type: "agent:removed", payload: { agentId: id } });
    this.onChange?.();
  }

  /** Cancels an agent's in-flight turn (if any) without removing the agent itself - the
   * "Stop" action in the UI, distinct from "Remove agent" which also deletes the config. */
  stopAgent(id: string): boolean {
    const runtime = this.agents.get(id);
    if (!runtime?.activeController) return false;
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
    this.enqueueTurn(id, turn.prompt, turn.replyChannel, turn.mentionChainDepth);
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
    opts: { broadcastIfUnmentioned: boolean; mentionChainDepth: number; model?: string },
  ) {
    const knownHandles = [...this.agents.values()].map((a) => a.config.handle);
    const mentions = parseMentions(text, knownHandles);

    const message: ChatMessage = {
      id: nanoid(),
      channel: "group",
      authorId,
      authorHandle,
      mentions,
      text,
      model: opts.model,
      createdAt: new Date().toISOString(),
    };
    this.bus.postMessage(message);

    if (mentions.length === 0 && !opts.broadcastIfUnmentioned) return; // agent-authored, unmentioned: visible only

    if (opts.mentionChainDepth > MAX_MENTION_CHAIN_DEPTH) {
      if (opts.mentionChainDepth === MAX_MENTION_CHAIN_DEPTH + 1) {
        this.bus.postMessage({
          id: nanoid(),
          channel: "group",
          authorId: "system",
          authorHandle: "system",
          mentions: [],
          text: `Stopped an agent-to-agent @mention chain after ${MAX_MENTION_CHAIN_DEPTH} hops to avoid a runaway loop - reply directly to continue.`,
          createdAt: new Date().toISOString(),
        });
      }
      return;
    }

    for (const runtime of this.agents.values()) {
      if (runtime.config.id === authorId) continue; // an agent doesn't reply to itself
      const targeted = mentions.length === 0 || mentions.includes(runtime.config.handle);
      if (mentions.length > 0 && !targeted) continue; // explicit @mentions: only those agents get a turn
      this.enqueueTurn(
        runtime.config.id,
        this.buildGroupPrompt(authorHandle, text, runtime.config.id),
        "group",
        opts.mentionChainDepth + 1,
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
    const self = this.agents.get(forAgentId)?.config;
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
            .join("; ")}. Mention an agent by handle (e.g. "@${others[0].handle} ...") to bring them into this ` +
          `specific thread - otherwise your reply only reaches whoever already mentioned you.`
        : "";
    return `${identity}${roster}]\n\n[group chat message from ${fromHandle}]: ${text}`;
  }

  private enqueueTurn(agentId: string, prompt: string, replyChannel: ChatChannel, mentionChainDepth = 0) {
    const runtime = this.agents.get(agentId);
    if (!runtime) return;
    runtime.queue.push({ prompt, replyChannel, mentionChainDepth });
    this.onChange?.(); // so a restart before this turn even starts still finds it queued
    void this.drainQueue(agentId);
  }

  private async drainQueue(agentId: string) {
    const runtime = this.agents.get(agentId);
    if (!runtime || runtime.busy) return;
    const turn = runtime.queue.shift();
    if (turn === undefined) return;
    const { prompt, replyChannel, mentionChainDepth } = turn;

    runtime.busy = true;
    runtime.currentTurn = turn;
    this.onChange?.(); // persist that this turn is now the one actually in flight
    runtime.status = "thinking";
    this.emitStatus(agentId);

    let hadError = false;
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
        model: runtime.config.model,
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
      const apiKey =
        authMode === "api-key" && runtime.config.credentialId ? getRawKey(WORKSPACE_ROOT, runtime.config.credentialId) : undefined;
      const controller = new AbortController();
      runtime.activeController = controller;
      const turnTimeout = setTimeout(() => {
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
        model: runtime.config.model,
        effort: runtime.config.effort,
        apiKey,
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
      hadError = true;
      const message = err instanceof Error ? err.message : String(err);
      runtime.lastError = message;
      post(replyChannel, `error: ${message}`);
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
          this.enqueueTurn(agentId, turn.prompt, turn.replyChannel, turn.mentionChainDepth);
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
          model: runtime.config.model,
        });
      }
    }

    runtime.activeController = undefined;
    runtime.currentTurn = undefined;
    runtime.busy = false;
    runtime.status = hadError ? "error" : "idle";
    this.emitStatus(agentId);
    this.onChange?.(); // this turn is no longer outstanding - persist that too
    void this.drainQueue(agentId); // pick up anything queued while this turn ran
  }
}

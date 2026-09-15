import { nanoid } from "nanoid";
import type { AgentConfig, AgentRunState, AgentStatus, ChatChannel, ChatMessage, TurnUsage } from "@solace/shared";
import { getAdapter } from "../adapters";
import { ChatBus } from "./chatBus";
import { parseMentions } from "./mentions";
import type { ApprovalRegistry } from "./approvalRegistry";
import { getRawKey } from "./credentials";
import { WORKSPACE_ROOT } from "./workspace";

interface QueuedTurn {
  prompt: string;
  replyChannel: ChatChannel;
  /** How many agent-to-agent @mention hops led to this turn (0 for a human-triggered turn).
   * Two agents can legitimately keep mentioning each other back and forth; this caps that
   * chain instead of letting it run forever - see MAX_MENTION_CHAIN_DEPTH. */
  mentionChainDepth: number;
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
}

/** Large open-ended asks (e.g. "build a whole site") can legitimately take a while, but a
 * turn must eventually end so a genuinely stuck CLI doesn't leave an agent stuck "thinking"
 * forever with no feedback. */
const MAX_TURN_MS = 15 * 60 * 1000;

/** How many agent-to-agent @mention hops are allowed before a chain is cut off. Two agents
 * mentioning each other back and forth is legitimate collaboration, not a bug - but with no
 * cap at all, it has no natural stopping point either. */
const MAX_MENTION_CHAIN_DEPTH = 6;

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
  ) {
    for (const config of initialAgents) {
      this.agents.set(config.id, { config, status: "idle", busy: false, queue: [], totalUsage: {} });
    }
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
    this.agents.get(id)?.activeController?.abort();
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
    if (!self || others.length === 0) {
      return `[group chat message from ${fromHandle}]: ${text}`;
    }
    const roster = others
      .map((a) => `"${a.handle}" (${a.provider})${a.currentTask ? ` - currently: ${a.currentTask}` : ""}`)
      .join("; ");
    const context =
      `[group context: you are "${self.handle}" in this group chat. Other agents here: ${roster}. ` +
      `Mention an agent by handle (e.g. "@${others[0].handle} ...") to bring them into this specific thread - ` +
      `otherwise your reply only reaches whoever already mentioned you.]\n\n`;
    return `${context}[group chat message from ${fromHandle}]: ${text}`;
  }

  private enqueueTurn(agentId: string, prompt: string, replyChannel: ChatChannel, mentionChainDepth = 0) {
    const runtime = this.agents.get(agentId);
    if (!runtime) return;
    runtime.queue.push({ prompt, replyChannel, mentionChainDepth });
    void this.drainQueue(agentId);
  }

  private async drainQueue(agentId: string) {
    const runtime = this.agents.get(agentId);
    if (!runtime || runtime.busy) return;
    const turn = runtime.queue.shift();
    if (turn === undefined) return;
    const { prompt, replyChannel, mentionChainDepth } = turn;

    runtime.busy = true;
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
    runtime.busy = false;
    runtime.status = hadError ? "error" : "idle";
    this.emitStatus(agentId);
    void this.drainQueue(agentId); // pick up anything queued while this turn ran
  }
}

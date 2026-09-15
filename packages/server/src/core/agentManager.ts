import { nanoid } from "nanoid";
import type { AgentConfig, AgentRunState, AgentStatus, ChatChannel, ChatMessage, TurnUsage } from "@solace/shared";
import { getAdapter } from "../adapters";
import { ChatBus } from "./chatBus";
import { parseMentions } from "./mentions";

interface QueuedTurn {
  prompt: string;
  replyChannel: ChatChannel;
}

interface AgentRuntime {
  config: AgentConfig;
  status: AgentRunState;
  busy: boolean;
  queue: QueuedTurn[];
  lastUsage?: TurnUsage;
  totalUsage: TurnUsage;
  lastError?: string;
}

/** Large open-ended asks (e.g. "build a whole site") can legitimately take a while, but a
 * turn must eventually end so a genuinely stuck CLI doesn't leave an agent stuck "thinking"
 * forever with no feedback. */
const MAX_TURN_MS = 15 * 60 * 1000;

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
 * Routing rule for the group channel:
 *   - a message with @mentions only triggers a turn for the mentioned agent(s);
 *     everyone else keeps working uninterrupted.
 *   - a message with no @mentions is still recorded in the shared history (every
 *     agent sees it as context on its *next* turn) but does not interrupt anyone.
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
    this.agents.delete(id);
    this.bus.emitEvent({ type: "agent:removed", payload: { agentId: id } });
    this.onChange?.();
  }

  updateAgent(id: string, patch: Partial<Pick<AgentConfig, "trustLevel" | "currentTask" | "model" | "effort">>) {
    const runtime = this.agents.get(id);
    if (!runtime) return;
    Object.assign(runtime.config, patch);
    this.bus.emitEvent({ type: "agent:updated", payload: runtime.config });
    this.emitStatus(id);
    this.onChange?.();
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

  /** Human operator (or another agent) posts a message into the shared group chat. */
  submitMessage(authorId: string, authorHandle: string, text: string) {
    const knownHandles = [...this.agents.values()].map((a) => a.config.handle);
    const mentions = parseMentions(text, knownHandles);

    const message: ChatMessage = {
      id: nanoid(),
      channel: "group",
      authorId,
      authorHandle,
      mentions,
      text,
      createdAt: new Date().toISOString(),
    };
    this.bus.postMessage(message);

    for (const runtime of this.agents.values()) {
      if (runtime.config.id === authorId) continue; // an agent doesn't reply to itself
      const targeted = mentions.length === 0 || mentions.includes(runtime.config.handle);
      if (mentions.length > 0 && !targeted) continue; // explicit @mentions: only those agents get a turn
      if (mentions.length === 0) continue; // no mentions: visible in history, nobody is interrupted
      this.enqueueTurn(runtime.config.id, this.buildPrompt(authorHandle, text), "group");
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

  private buildPrompt(fromHandle: string, text: string): string {
    return `[group chat message from ${fromHandle}]: ${text}`;
  }

  private enqueueTurn(agentId: string, prompt: string, replyChannel: ChatChannel) {
    const runtime = this.agents.get(agentId);
    if (!runtime) return;
    runtime.queue.push({ prompt, replyChannel });
    void this.drainQueue(agentId);
  }

  private async drainQueue(agentId: string) {
    const runtime = this.agents.get(agentId);
    if (!runtime || runtime.busy) return;
    const turn = runtime.queue.shift();
    if (turn === undefined) return;
    const { prompt, replyChannel } = turn;

    runtime.busy = true;
    runtime.status = "thinking";
    this.emitStatus(agentId);

    let hadError = false;
    const adapter = getAdapter(runtime.config.provider);
    const controller = new AbortController();
    const turnTimeout = setTimeout(() => controller.abort(), MAX_TURN_MS);
    await adapter.runTurn({
      cwd: runtime.config.cwd,
      prompt,
      trustLevel: runtime.config.trustLevel,
      model: runtime.config.model,
      effort: runtime.config.effort,
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "text" && event.text.trim()) {
          this.bus.postMessage({
            id: nanoid(),
            channel: replyChannel,
            authorId: runtime.config.id,
            authorHandle: runtime.config.handle,
            mentions: [],
            text: event.text,
            model: runtime.config.model,
            createdAt: new Date().toISOString(),
          });
        } else if (event.type === "tool-use") {
          this.bus.postMessage({
            id: nanoid(),
            channel: replyChannel,
            authorId: runtime.config.id,
            authorHandle: runtime.config.handle,
            mentions: [],
            text: `_used ${event.description}_`,
            createdAt: new Date().toISOString(),
          });
        } else if (event.type === "usage") {
          runtime.lastUsage = event.usage;
          runtime.totalUsage = addUsage(runtime.totalUsage, event.usage);
        } else if (event.type === "error" && event.message.trim()) {
          hadError = true;
          runtime.lastError = event.message.trim();
          this.bus.postMessage({
            id: nanoid(),
            channel: replyChannel,
            authorId: runtime.config.id,
            authorHandle: runtime.config.handle,
            mentions: [],
            text: `error: ${event.message.trim()}`,
            createdAt: new Date().toISOString(),
          });
          runtime.status = "error";
          this.emitStatus(agentId);
        }
      },
    });
    clearTimeout(turnTimeout);

    runtime.busy = false;
    runtime.status = hadError ? "error" : "idle";
    this.emitStatus(agentId);
    void this.drainQueue(agentId); // pick up anything queued while this turn ran
  }
}

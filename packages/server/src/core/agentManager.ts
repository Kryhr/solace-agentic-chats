import { nanoid } from "nanoid";
import type { AgentConfig, AgentRunState, AgentStatus, ChatMessage } from "@solace/shared";
import { getAdapter } from "../adapters";
import { ChatBus } from "./chatBus";
import { parseMentions } from "./mentions";

interface AgentRuntime {
  config: AgentConfig;
  status: AgentRunState;
  busy: boolean;
  queue: string[];
}

/** Large open-ended asks (e.g. "build a whole site") can legitimately take a while, but a
 * turn must eventually end so a genuinely stuck CLI doesn't leave an agent stuck "thinking"
 * forever with no feedback. */
const MAX_TURN_MS = 15 * 60 * 1000;

/**
 * Owns the set of configured agents and routes group-chat turns to them.
 *
 * Routing rule (see ARCHITECTURE.md#group-chat-routing):
 *   - a message with @mentions only triggers a turn for the mentioned agent(s);
 *     everyone else keeps working uninterrupted.
 *   - a message with no @mentions is still recorded in the shared history (every
 *     agent sees it as context on its *next* turn) but does not interrupt anyone.
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
      this.agents.set(config.id, { config, status: "idle", busy: false, queue: [] });
    }
  }

  addAgent(config: AgentConfig) {
    this.agents.set(config.id, { config, status: "idle", busy: false, queue: [] });
    this.bus.emitEvent({ type: "agent:added", payload: config });
    this.emitStatus(config.id);
    this.onChange?.();
  }

  removeAgent(id: string) {
    this.agents.delete(id);
    this.bus.emitEvent({ type: "agent:removed", payload: { agentId: id } });
    this.onChange?.();
  }

  updateAgent(id: string, patch: Partial<Pick<AgentConfig, "trustLevel" | "currentTask">>) {
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
      this.enqueueTurn(runtime.config.id, this.buildPrompt(authorHandle, text));
    }
  }

  private buildPrompt(fromHandle: string, text: string): string {
    return `[group chat message from ${fromHandle}]: ${text}`;
  }

  private enqueueTurn(agentId: string, prompt: string) {
    const runtime = this.agents.get(agentId);
    if (!runtime) return;
    runtime.queue.push(prompt);
    void this.drainQueue(agentId);
  }

  private async drainQueue(agentId: string) {
    const runtime = this.agents.get(agentId);
    if (!runtime || runtime.busy) return;
    const prompt = runtime.queue.shift();
    if (prompt === undefined) return;

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
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "text" && event.text.trim()) {
          this.bus.postMessage({
            id: nanoid(),
            channel: "group",
            authorId: runtime.config.id,
            authorHandle: runtime.config.handle,
            mentions: [],
            text: event.text,
            createdAt: new Date().toISOString(),
          });
        } else if (event.type === "tool-use") {
          this.bus.postMessage({
            id: nanoid(),
            channel: "group",
            authorId: runtime.config.id,
            authorHandle: runtime.config.handle,
            mentions: [],
            text: `_used ${event.description}_`,
            createdAt: new Date().toISOString(),
          });
        } else if (event.type === "error" && event.message.trim()) {
          hadError = true;
          this.bus.postMessage({
            id: nanoid(),
            channel: "group",
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

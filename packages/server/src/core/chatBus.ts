import type { ChatChannel, ChatMessage, ServerEvent } from "@solace/shared";

function sameChannel(a: ChatChannel, b: ChatChannel): boolean {
  if (a === "group" || b === "group") return a === b;
  return a.agentId === b.agentId;
}

type Listener = (event: ServerEvent) => void;

/**
 * Shared group-chat transcript + pub/sub. Every WebSocket client and every agent turn
 * reads/writes through this single bus, so "the group chat" is always one consistent history.
 */
export class ChatBus {
  private history: ChatMessage[] = [];
  private listeners = new Set<Listener>();

  /** Set by index.ts to persist state after every new message. */
  onChange: (() => void) | null = null;

  constructor(initialHistory: ChatMessage[] = []) {
    this.history = initialHistory;
  }

  getHistory(): ChatMessage[] {
    return this.history;
  }

  getHistoryFor(channel: ChatChannel): ChatMessage[] {
    return this.history.filter((m) => sameChannel(m.channel, channel));
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: ServerEvent) {
    for (const listener of this.listeners) listener(event);
  }

  postMessage(message: ChatMessage) {
    this.history.push(message);
    this.emit({ type: "chat:message", payload: message });
    this.onChange?.();
  }

  /** Used by the /clear slash command - drops every message in one channel and returns
   * exactly what was removed, so the caller can archive it instead of losing it outright. */
  clearChannel(channel: ChatChannel): ChatMessage[] {
    const removed = this.history.filter((m) => sameChannel(m.channel, channel));
    this.history = this.history.filter((m) => !sameChannel(m.channel, channel));
    this.emit({ type: "chat:cleared", payload: { channel } });
    this.onChange?.();
    return removed;
  }

  emitEvent(event: ServerEvent) {
    this.emit(event);
  }
}

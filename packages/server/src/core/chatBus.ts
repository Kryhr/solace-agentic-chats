import type { ChatMessage, ServerEvent } from "@solace/shared";

type Listener = (event: ServerEvent) => void;

/**
 * Shared group-chat transcript + pub/sub. Every WebSocket client and every agent turn
 * reads/writes through this single bus, so "the group chat" is always one consistent history.
 */
export class ChatBus {
  private history: ChatMessage[] = [];
  private listeners = new Set<Listener>();

  getHistory(): ChatMessage[] {
    return this.history;
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
  }

  emitEvent(event: ServerEvent) {
    this.emit(event);
  }
}

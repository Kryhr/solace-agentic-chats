import { nanoid } from "nanoid";
import type { ChatChannel, ChatMessage } from "@solace/shared";

export interface ChatArchive {
  id: string;
  channel: ChatChannel;
  clearedAt: string;
  messages: ChatMessage[];
}

/**
 * /clear doesn't delete anything - it moves a channel's messages here instead, so "my local
 * server crashed / I cleared the wrong chat" never actually loses anything. Persisted to disk
 * the same way agents/history are (see persistence.ts).
 */
export class ArchiveStore {
  private archives: ChatArchive[];

  constructor(initial: ChatArchive[] = []) {
    this.archives = initial;
  }

  /** No-op if there was nothing to archive (an already-empty channel). */
  add(channel: ChatChannel, messages: ChatMessage[]) {
    if (messages.length === 0) return;
    this.archives.unshift({ id: nanoid(), channel, clearedAt: new Date().toISOString(), messages });
  }

  list(): ChatArchive[] {
    return this.archives;
  }
}

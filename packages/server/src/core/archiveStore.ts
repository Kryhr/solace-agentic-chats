import { nanoid } from "nanoid";
import type { ChatChannel, ChatMessage } from "@solace/shared";

export interface ChatArchive {
  id: string;
  channel: ChatChannel;
  clearedAt: string;
  messages: ChatMessage[];
  /** The agent's handle (or "Group chat") at the moment this was archived, captured once
   * here rather than resolved live against the current agent list every time it's displayed -
   * if the agent is later removed, the archive still shows who it actually was instead of
   * falling back to a generic "an agent's hub" placeholder. Optional only because archives
   * persisted before this field existed won't have it. */
  channelLabel: string;
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
  add(channel: ChatChannel, messages: ChatMessage[], channelLabel: string) {
    if (messages.length === 0) return;
    this.archives.unshift({ id: nanoid(), channel, clearedAt: new Date().toISOString(), messages, channelLabel });
  }

  list(): ChatArchive[] {
    return this.archives;
  }
}

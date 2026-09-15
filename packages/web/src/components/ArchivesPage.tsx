import { useState } from "react";
import type { AgentConfig } from "@solace/shared";
import type { ChatArchive } from "../api";

function formatChannel(archive: ChatArchive, agentsById: Record<string, AgentConfig>): string {
  // Prefer the label captured at archive time (survives the agent later being removed);
  // only fall back to a live lookup for archives saved before that field existed.
  if (archive.channelLabel) return archive.channelLabel;
  if (archive.channel === "group") return "Group chat";
  const agent = agentsById[archive.channel.agentId];
  return agent ? `${agent.handle}'s hub` : "an agent's hub";
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function formatMessageCount(count: number): string {
  return `${count} message${count === 1 ? "" : "s"}`;
}

export function ArchivesPage({
  archives,
  agentsById,
  onBack,
}: {
  archives: ChatArchive[];
  agentsById: Record<string, AgentConfig>;
  onBack: () => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="hub-page">
      <div className="hub-page-header">
        <button className="back-btn" onClick={onBack}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          Group chat
        </button>
        <div className="hub-page-identity">
          <h2>Saved chats</h2>
        </div>
      </div>

      <div className="hub-page-chat">
        {archives.length === 0 && (
          <div className="chat-empty">
            <div className="chat-empty-title">Nothing saved yet</div>
            <div className="chat-empty-body">
              Running <kbd>/clear</kbd> on a chat archives it here rather than deleting it, so you can always go back and
              read what an agent actually did.
            </div>
          </div>
        )}
        {archives.map((a) => (
          <div key={a.id} className={`archive-entry ${openId === a.id ? "is-open" : ""}`}>
            <button
              className="archive-entry-header"
              onClick={() => setOpenId(openId === a.id ? null : a.id)}
              aria-expanded={openId === a.id}
            >
              <span className="archive-entry-title">
                <svg className="archive-chevron" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M6 3.5 10.5 8 6 12.5" />
                </svg>
                {formatChannel(a, agentsById)}
              </span>
              <span className="archive-entry-meta">
                {formatMessageCount(a.messages.length)} · cleared {formatDate(a.clearedAt)}
              </span>
            </button>
            {openId === a.id && (
              <div className="archive-entry-body">
                {a.messages.map((m) => (
                  <div key={m.id} className="archive-message">
                    <span className="archive-message-author">{m.authorHandle}</span>
                    <span className="archive-message-text">{m.text}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

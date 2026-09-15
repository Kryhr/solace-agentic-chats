import { useState } from "react";
import type { AgentConfig } from "@solace/shared";
import type { ChatArchive } from "../api";

function formatChannel(channel: ChatArchive["channel"], agentsById: Record<string, AgentConfig>): string {
  if (channel === "group") return "Group chat";
  const agent = agentsById[channel.agentId];
  return agent ? `${agent.handle}'s hub` : "an agent's hub";
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
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
            Nothing archived yet - running /clear on a chat moves it here instead of deleting it.
          </div>
        )}
        {archives.map((a) => (
          <div key={a.id} className="archive-entry">
            <button className="archive-entry-header" onClick={() => setOpenId(openId === a.id ? null : a.id)}>
              <span className="archive-entry-title">{formatChannel(a.channel, agentsById)}</span>
              <span className="archive-entry-meta">
                {a.messages.length} messages · cleared {formatDate(a.clearedAt)}
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

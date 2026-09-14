import { useState } from "react";
import type { ChatMessage } from "@solace/shared";
import { colorForHandle, initialsForHandle } from "../lib/color";

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function ChatPanel({ history, onSend }: { history: ChatMessage[]; onSend: (text: string) => void }) {
  const [draft, setDraft] = useState("");

  const submit = () => {
    if (!draft.trim()) return;
    onSend(draft.trim());
    setDraft("");
  };

  const isToolUse = (text: string) => text.startsWith("_used ") && text.endsWith("_");

  return (
    <div className="chat">
      <div className="chat-history">
        {history.length === 0 && (
          <div className="chat-empty">
            No messages yet. Add an agent in the sidebar, then say hello or @mention it directly.
          </div>
        )}
        {history.map((m) => {
          const isUser = m.authorId === "user";
          const text = isToolUse(m.text) ? m.text.slice(6, -1) : m.text;
          return (
            <div key={m.id} className={`message-row ${isUser ? "from-user" : ""}`}>
              {!isUser && (
                <span
                  className="agent-avatar"
                  style={{ background: colorForHandle(m.authorHandle), flexShrink: 0 }}
                >
                  {initialsForHandle(m.authorHandle)}
                </span>
              )}
              <div className="message">
                <div className="meta">
                  <span>{m.authorHandle}</span>
                  <span>·</span>
                  <span>{formatTime(m.createdAt)}</span>
                  {m.mentions.map((h) => (
                    <span key={h} className="mention">
                      @{h}
                    </span>
                  ))}
                </div>
                <div className={`body ${isToolUse(m.text) ? "tool-use" : ""}`}>{text}</div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="composer">
        <input
          value={draft}
          placeholder="Message the group chat. Use @handle to target a specific agent."
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <button onClick={submit} disabled={!draft.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}

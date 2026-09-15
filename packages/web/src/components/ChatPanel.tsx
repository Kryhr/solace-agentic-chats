import { useMemo, useRef, useState } from "react";
import type { AgentConfig, ChatMessage, ProviderModelInfo } from "@solace/shared";
import { ProviderIcon } from "./ProviderIcon";

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Finds the "@partial" token touching the cursor, so we know what to autocomplete. */
function findMentionQuery(text: string, cursor: number): { start: number; query: string } | null {
  const upToCursor = text.slice(0, cursor);
  const at = upToCursor.lastIndexOf("@");
  if (at === -1) return null;
  const between = upToCursor.slice(at + 1);
  if (/\s/.test(between)) return null; // the "@" isn't part of the token under the cursor anymore
  return { start: at, query: between };
}

export function ChatPanel({
  history,
  agents,
  modelCatalog,
  onSend,
}: {
  history: ChatMessage[];
  agents: AgentConfig[];
  modelCatalog: ProviderModelInfo[];
  onSend: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [cursor, setCursor] = useState(0);
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const mention = findMentionQuery(draft, cursor);
  const suggestions = mention
    ? agents.filter((a) => a.handle.toLowerCase().startsWith(mention.query.toLowerCase()))
    : [];

  const acceptSuggestion = (handle: string) => {
    if (!mention) return;
    const before = draft.slice(0, mention.start);
    const after = draft.slice(cursor);
    const next = `${before}@${handle} ${after}`;
    setDraft(next);
    const nextCursor = before.length + handle.length + 2;
    requestAnimationFrame(() => {
      inputRef.current?.setSelectionRange(nextCursor, nextCursor);
      inputRef.current?.focus();
    });
    setCursor(nextCursor);
    setHighlighted(0);
  };

  const submit = () => {
    if (!draft.trim()) return;
    onSend(draft.trim());
    setDraft("");
    setCursor(0);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (suggestions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlighted((h) => (h + 1) % suggestions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlighted((h) => (h - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        acceptSuggestion(suggestions[highlighted].handle);
        return;
      }
      if (e.key === "Escape") {
        setCursor(-1); // force mention lookup to miss until the user moves the caret again
        return;
      }
    }
    if (e.key === "Enter") submit();
  };

  const isErrorLine = (text: string) => text.startsWith("error: ");
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
          const author = agentById.get(m.authorId);
          const text = isToolUse(m.text) ? m.text.slice(6, -1) : m.text;
          const showModel = !isUser && !isToolUse(m.text) && !isErrorLine(m.text);
          const modelLabel =
            m.model || (author ? modelCatalog.find((c) => c.provider === author.provider)?.currentDefaultModel : undefined);
          return (
            <div key={m.id} className={`message-row ${isUser ? "from-user" : ""}`}>
              {!isUser && (author ? <ProviderIcon provider={author.provider} /> : <span className="user-avatar">?</span>)}
              <div className="message">
                <div className="meta">
                  <span className="meta-author">{m.authorHandle}</span>
                  {showModel && modelLabel && <span className="meta-model">{modelLabel}</span>}
                  <span>·</span>
                  <span>{formatTime(m.createdAt)}</span>
                  {m.mentions.map((h) => (
                    <span key={h} className="mention">
                      @{h}
                    </span>
                  ))}
                </div>
                <div
                  className={`body ${isToolUse(m.text) ? "tool-use" : ""} ${isErrorLine(m.text) ? "error-line" : ""}`}
                >
                  {text}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="composer-wrap">
        {mention && suggestions.length > 0 && (
          <div className="mention-menu">
            {suggestions.map((a, i) => (
              <button
                key={a.id}
                className={`mention-option ${i === highlighted ? "active" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  acceptSuggestion(a.handle);
                }}
              >
                <ProviderIcon provider={a.provider} size={18} />
                <span>{a.handle}</span>
              </button>
            ))}
          </div>
        )}
        <div className="composer">
          <input
            ref={inputRef}
            value={draft}
            placeholder="Message the group chat. Use @handle to target a specific agent."
            onChange={(e) => {
              setDraft(e.target.value);
              setCursor(e.target.selectionStart ?? e.target.value.length);
              setHighlighted(0);
            }}
            onKeyUp={(e) => setCursor(e.currentTarget.selectionStart ?? 0)}
            onClick={(e) => setCursor(e.currentTarget.selectionStart ?? 0)}
            onKeyDown={onKeyDown}
          />
          <button onClick={submit} disabled={!draft.trim()}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

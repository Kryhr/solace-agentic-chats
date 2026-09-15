import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentConfig, AgentStatus, ChatMessage, ProviderModelInfo } from "@solace/shared";
import { ProviderIcon, UserAvatar } from "./ProviderIcon";
import { SendIcon } from "./SendIcon";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { useEntranceTracker } from "../lib/useEntranceTracker";

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

const SLASH_COMMANDS = [
  { name: "task", hint: "@handle <description>" },
  { name: "status", hint: "" },
  { name: "github", hint: "status | init <repo-name>" },
  { name: "clear", hint: "" },
  { name: "model", hint: "<value> (from an agent's hub)" },
  { name: "effort", hint: "<value> (from an agent's hub)" },
  { name: "help", hint: "" },
];

/** Only offered while typing the very first token of the message and it starts with "/". */
function findSlashQuery(text: string, cursor: number): string | null {
  if (!text.startsWith("/")) return null;
  const upToCursor = text.slice(0, cursor);
  if (/\s/.test(upToCursor)) return null;
  return upToCursor.slice(1);
}

const MAX_COMPOSER_HEIGHT = 160;

export function ChatPanel({
  history,
  agents,
  statuses,
  modelCatalog,
  onSend,
}: {
  history: ChatMessage[];
  agents: AgentConfig[];
  statuses: Record<string, AgentStatus>;
  modelCatalog: ProviderModelInfo[];
  onSend: (text: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [cursor, setCursor] = useState(0);
  const [highlighted, setHighlighted] = useState(0);
  const [sendError, setSendError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const mention = findMentionQuery(draft, cursor);
  const mentionSuggestions = mention
    ? agents.filter((a) => a.handle.toLowerCase().startsWith(mention.query.toLowerCase()))
    : [];
  const slashQuery = mention ? null : findSlashQuery(draft, cursor);
  const slashSuggestions =
    slashQuery !== null ? SLASH_COMMANDS.filter((c) => c.name.startsWith(slashQuery.toLowerCase())) : [];
  const hasSuggestions = mentionSuggestions.length > 0 || slashSuggestions.length > 0;

  const thinkingAgents = agents.filter((a) => statuses[a.id]?.state === "thinking");
  const trackEntrance = useEntranceTracker();

  // Auto-scroll to the newest message, but only when the reader was already near the
  // bottom - so it doesn't yank them away mid-scroll while reviewing earlier history.
  useEffect(() => {
    const el = historyRef.current;
    if (el && stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [history.length, thinkingAgents.length]);

  const onHistoryScroll = () => {
    const el = historyRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const resizeComposer = () => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_COMPOSER_HEIGHT)}px`;
  };

  const acceptMention = (handle: string) => {
    if (!mention) return;
    const before = draft.slice(0, mention.start);
    const after = draft.slice(cursor);
    const next = `${before}@${handle} ${after}`;
    setDraft(next);
    const nextCursor = before.length + handle.length + 2;
    requestAnimationFrame(() => {
      inputRef.current?.setSelectionRange(nextCursor, nextCursor);
      inputRef.current?.focus();
      resizeComposer();
    });
    setCursor(nextCursor);
    setHighlighted(0);
  };

  const acceptSlashCommand = (name: string) => {
    const next = `/${name} `;
    setDraft(next);
    requestAnimationFrame(() => {
      inputRef.current?.setSelectionRange(next.length, next.length);
      inputRef.current?.focus();
      resizeComposer();
    });
    setCursor(next.length);
    setHighlighted(0);
  };

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    setSendError(null);
    // Clear optimistically so typing feels instant - but if the request actually fails (most
    // commonly: the dev server just hot-reloaded and the WS/HTTP layer hasn't reconnected yet),
    // put the text back instead of letting it silently vanish with no trace anything went
    // wrong. Only restore into an empty box, so it doesn't clobber something new the user
    // already started typing while the failed request was in flight.
    onSend(text).catch(() => {
      setSendError("Couldn't send - the connection may have dropped. Your message is back in the box.");
      setDraft((current) => (current === "" ? text : current));
    });
    setDraft("");
    setCursor(0);
    // Sending a message is a deliberate "I'm back in this conversation" signal, even if the
    // reader had scrolled up to review earlier history - snap back to the bottom so the
    // message they just sent (and the reply that follows) is visible without a manual scroll.
    stickToBottom.current = true;
    requestAnimationFrame(() => {
      resizeComposer();
      if (historyRef.current) historyRef.current.scrollTop = historyRef.current.scrollHeight;
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (hasSuggestions) {
      const count = mentionSuggestions.length || slashSuggestions.length;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlighted((h) => (h + 1) % count);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlighted((h) => (h - 1 + count) % count);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        if (mentionSuggestions.length > 0) acceptMention(mentionSuggestions[highlighted].handle);
        else acceptSlashCommand(slashSuggestions[highlighted].name);
        return;
      }
      if (e.key === "Escape") {
        setCursor(-1); // force both lookups to miss until the user moves the caret again
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const isErrorLine = (text: string) => text.startsWith("error: ");
  const isToolUse = (text: string) => text.startsWith("_used ") && text.endsWith("_");

  const shouldAnimate = trackEntrance(history.map((m) => m.id));

  return (
    <div className="chat">
      <div className="chat-history" ref={historyRef} onScroll={onHistoryScroll}>
        {history.length === 0 && (
          <div className="chat-empty">
            <div className="chat-empty-title">{agents.length === 0 ? "No agents yet" : "Nothing sent yet"}</div>
            <div className="chat-empty-body">
              {agents.length === 0 ? (
                <>Add an agent from the sidebar to start a shared session. Every agent you add joins this group chat.</>
              ) : (
                <>
                  Type <kbd>@</kbd> to direct a message at one agent, or <kbd>/</kbd> for commands. Plain messages go to
                  everyone.
                </>
              )}
            </div>
          </div>
        )}
        {history.map((m) => {
          const isUser = m.authorId === "user";
          const isSystem = m.authorId === "system";
          const author = agentById.get(m.authorId);
          const text = isToolUse(m.text) ? m.text.slice(6, -1) : m.text;
          const showModel = !isUser && !isSystem && !isToolUse(m.text) && !isErrorLine(m.text);
          const modelLabel =
            m.model || (author ? modelCatalog.find((c) => c.provider === author.provider)?.currentDefaultModel : undefined);
          const enter = shouldAnimate(m.id) ? "message-enter" : "";
          if (isSystem) {
            return (
              <div key={m.id} className={`message-row system-row ${enter}`}>
                <div className="body system-body">{m.text}</div>
              </div>
            );
          }
          return (
            <div key={m.id} className={`message-row ${isUser ? "from-user" : ""} ${enter}`}>
              {isUser ? <UserAvatar /> : author ? <ProviderIcon provider={author.provider} /> : <UserAvatar />}
              <div className="message">
                <div className="meta">
                  <span className="meta-author">{m.authorHandle}</span>
                  {showModel && modelLabel && <span className="meta-model">{modelLabel}</span>}
                  {m.mentions.map((h) => (
                    <span key={h} className="mention">
                      @{h}
                    </span>
                  ))}
                  <span className="meta-time">{formatTime(m.createdAt)}</span>
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
        {thinkingAgents.map((a) => (
          <ThinkingIndicator key={a.id} label={`${a.handle} is working…`} />
        ))}
      </div>
      <div className="composer-wrap">
        {mentionSuggestions.length > 0 && (
          <div className="mention-menu">
            {mentionSuggestions.map((a, i) => (
              <button
                key={a.id}
                className={`mention-option ${i === highlighted ? "active" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  acceptMention(a.handle);
                }}
              >
                <ProviderIcon provider={a.provider} size={18} />
                <span>{a.handle}</span>
              </button>
            ))}
          </div>
        )}
        {slashSuggestions.length > 0 && (
          <div className="mention-menu">
            {slashSuggestions.map((c, i) => (
              <button
                key={c.name}
                className={`mention-option ${i === highlighted ? "active" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  acceptSlashCommand(c.name);
                }}
              >
                <span className="slash-command-name">/{c.name}</span>
                {c.hint && <span className="slash-command-hint">{c.hint}</span>}
              </button>
            ))}
          </div>
        )}
        <div className="composer">
          {sendError && <div className="composer-error">{sendError}</div>}
          <div className="composer-field">
            <textarea
              ref={inputRef}
              rows={1}
              value={draft}
              aria-label="Message the group chat"
              placeholder="Message the group…"
              onChange={(e) => {
                setDraft(e.target.value);
                setCursor(e.target.selectionStart ?? e.target.value.length);
                setHighlighted(0);
                if (sendError) setSendError(null);
                resizeComposer();
              }}
              onKeyUp={(e) => setCursor(e.currentTarget.selectionStart ?? 0)}
              onClick={(e) => setCursor(e.currentTarget.selectionStart ?? 0)}
              onKeyDown={onKeyDown}
            />
            <button className="send-btn" onClick={submit} disabled={!draft.trim()} aria-label="Send message" title="Send · Enter">
              <SendIcon />
            </button>
          </div>
          <div className="composer-hint">
            <span>
              <code>@</code> mention an agent
            </span>
            <span>
              <code>/</code> commands
            </span>
            <span>
              <code>Shift</code> + <code>Enter</code> for a new line
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

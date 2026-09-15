import { useEffect, useMemo, useRef } from "react";
import type { AgentConfig, AgentStatus, ChatMessage, ProviderModelInfo, ProviderRateLimit } from "@solace/shared";
import { ProviderIcon, UserAvatar } from "./ProviderIcon";
import { Composer } from "./Composer";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { useEntranceTracker } from "../lib/useEntranceTracker";
import { displayText, isErrorLine, isToolUse } from "../lib/messageKind";

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function ChatPanel({
  history,
  agents,
  statuses,
  modelCatalog,
  rateLimits,
  connected,
  onSend,
}: {
  history: ChatMessage[];
  agents: AgentConfig[];
  statuses: Record<string, AgentStatus>;
  modelCatalog: ProviderModelInfo[];
  rateLimits: ProviderRateLimit[];
  connected: boolean;
  onSend: (text: string) => Promise<void>;
}) {
  const historyRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const thinkingAgents = agents.filter((a) => statuses[a.id]?.state === "thinking");
  const erroredAgents = agents.filter((a) => statuses[a.id]?.state === "error");
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

  const shouldAnimate = trackEntrance(history.map((m) => m.id));

  return (
    <div className="chat">
      {/* The group view had no header at all while the hub had one, so the two halves of the
          app disagreed about where controls live and there was nowhere to put a view-level
          action. Mirrors .hub-page-header's structure so both read as the same page chrome. */}
      <div className="hub-page-header chat-header">
        <div className="hub-page-identity">
          <h2>Group chat</h2>
          <span className="hub-subtitle">
            {agents.length === 0
              ? "no agents yet"
              : `${agents.length} agent${agents.length === 1 ? "" : "s"}`}
            {thinkingAgents.length > 0 && (
              <>
                <span className="sep">·</span>
                {thinkingAgents.length} working
              </>
            )}
            {erroredAgents.length > 0 && (
              <>
                <span className="sep">·</span>
                <span className="hub-subtitle-error">
                  {erroredAgents.length} errored
                </span>
              </>
            )}
          </span>
        </div>

        {/* Slot for the group-chat action row. The "Save chat" button lands here in a later
            phase; the container exists now so it has a home that matches the hub's. */}
        <div className="hub-page-actions chat-header-actions" />
      </div>

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
          const toolUse = isToolUse(m.text);
          const errorLine = isErrorLine(m.text);
          const text = displayText(m.text);
          const showModel = !isUser && !isSystem && !toolUse && !errorLine;
          const modelLabel =
            m.model || (author ? modelCatalog.find((c) => c.provider === author.provider)?.currentDefaultModel : undefined);
          const enter = shouldAnimate(m.id) ? "message-enter" : "";
          if (isSystem) {
            // A verification notice contradicts something an agent just asserted, so it reads
            // as a labelled callout rather than the faint centered bookkeeping used for
            // "task updated" - see ChatMessage.systemKind.
            if (m.systemKind === "verification") {
              return (
                <div key={m.id} className={`message-row system-row system-row-verify ${enter}`}>
                  <div className="system-verify">
                    <span className="system-verify-label">Unverified claim</span>
                    <span className="system-verify-text">{m.text}</span>
                  </div>
                </div>
              );
            }
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
                <div className={`body ${toolUse ? "tool-use" : ""} ${errorLine ? "error-line" : ""}`}>{text}</div>
              </div>
            </div>
          );
        })}
        {thinkingAgents.map((a) => (
          <ThinkingIndicator key={a.id} label={`${a.handle} is working…`} />
        ))}
      </div>

      <Composer
        placeholder={connected ? "Message the group…" : "Reconnecting…"}
        ariaLabel="Message the group chat"
        mentionAgents={agents}
        usage={{ rateLimits, providersInUse: [...new Set(agents.map((a) => a.provider))] }}
        onSend={onSend}
        onSubmitted={() => {
          // Sending a message is a deliberate "I'm back in this conversation" signal, even if
          // the reader had scrolled up to review earlier history - snap back to the bottom so
          // the message they just sent (and the reply that follows) is visible.
          stickToBottom.current = true;
          requestAnimationFrame(() => {
            if (historyRef.current) historyRef.current.scrollTop = historyRef.current.scrollHeight;
          });
        }}
      />
    </div>
  );
}

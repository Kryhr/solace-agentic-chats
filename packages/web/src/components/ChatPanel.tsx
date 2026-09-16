import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentConfig,
  AgentStatus,
  ChatMessage,
  ChatMeta,
  ProjectMeta,
  ProviderModelInfo,
  ProviderRateLimit,
} from "@solace/shared";
import { ProviderIcon, UserAvatar } from "./ProviderIcon";
import { Composer } from "./Composer";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { useEntranceTracker } from "../lib/useEntranceTracker";
import { displayText, renderKind } from "../lib/messageKind";

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function ChatPanel({
  chat,
  project,
  history,
  agents,
  statuses,
  modelCatalog,
  rateLimits,
  connected,
  onNewChat,
  onSend,
}: {
  /** Undefined when there is no chat at all - every one has been archived. */
  chat: ChatMeta | undefined;
  /** The project this chat is filed under, if any. */
  project: ProjectMeta | undefined;
  history: ChatMessage[];
  agents: AgentConfig[];
  statuses: Record<string, AgentStatus>;
  modelCatalog: ProviderModelInfo[];
  rateLimits: ProviderRateLimit[];
  connected: boolean;
  onNewChat: () => void;
  onSend: (text: string) => Promise<void>;
}) {
  const historyRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  /** Shown once the reader has scrolled far enough up that new messages are arriving off-screen.
   * A ref alone cannot drive this - it has to be state for the button to appear and disappear. */
  const [scrolledUp, setScrolledUp] = useState(false);

  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  // Scoped to THIS chat. "Is this agent busy?" and "is this agent busy here?" are different
  // questions, and answering the first one meant a second open chat showed both agents as
  // working on a turn that had nothing to do with it.
  const thinkingAgents = agents.filter(
    (a) => statuses[a.id]?.state === "thinking" && statuses[a.id]?.activeChatId === chat?.id,
  );
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
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottom.current = fromBottom < 80;
    // Deliberately a longer distance than the stick threshold: between 80px and a screenful the
    // reader can still see the newest message, so offering to scroll them somewhere they are
    // already looking would be noise.
    setScrolledUp(fromBottom > el.clientHeight * 0.5);
  };

  const jumpToBottom = () => {
    const el = historyRef.current;
    if (!el) return;
    stickToBottom.current = true;
    setScrolledUp(false);
    // Instant, not smooth. A long transcript is tens of thousands of pixels tall - a smooth
    // scroll over that distance takes many seconds and was still at the top when the button had
    // already disappeared, so it read as a dead button. This is a "take me to the newest
    // message" control, and arriving there immediately is the whole point.
    el.scrollTop = el.scrollHeight;
  };

  const shouldAnimate = trackEntrance(history.map((m) => m.id));

  // Every chat can be archived, and the app must still say something useful when they all have
  // been - an empty transcript with a live composer pointed at nothing would be a dead end.
  if (!chat) {
    return (
      <div className="chat">
        <div className="chat-history">
          <div className="chat-empty">
            <div className="chat-empty-title">No chats</div>
            <div className="chat-empty-body">
              Every chat has been archived. Their transcripts are still in Saved chats.
              <div className="chat-empty-action">
                <button className="btn-primary" onClick={onNewChat}>
                  New chat
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="chat">
      {/* The group view had no header at all while the hub had one, so the two halves of the
          app disagreed about where controls live and there was nowhere to put a view-level
          action. Mirrors .hub-page-header's structure so both read as the same page chrome. */}
      <div className="hub-page-header chat-header">
        <div className="hub-page-identity">
          <h2>{chat.title}</h2>
          <span className="hub-subtitle">
            {/* Named before the agent count, because which project a chat is filed under is what
                decides which agents it reaches at all. */}
            {project && (
              <>
                {project.name}
                <span className="sep">·</span>
              </>
            )}
            {agents.length === 0
              ? project
                ? "no agents in this project"
                : "no agents yet"
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
            <div className="chat-empty-title">{agents.length === 0 ? "No agents here" : "Nothing sent yet"}</div>
            <div className="chat-empty-body">
              {agents.length === 0 ? (
                project ? (
                  <>
                    This chat is filed under <strong>{project.name}</strong>, so it reaches only agents working in that
                    folder. Add one pointed at <code>{project.path}</code>.
                  </>
                ) : (
                  <>Add an agent from the sidebar to start a shared session. This chat is unfiled, so every agent joins it.</>
                )
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
          // Group chat only ever receives completed answers (AgentManager posts every
          // intermediate line to the agent's own hub channel instead), so in practice this is
          // "answer" for every agent row. It goes through the same classifier as the hub anyway,
          // so history written before that rule - which does contain tool lines - still renders
          // as what it is, and the two views can never disagree about what a message is again.
          const kind = renderKind(m);
          const isUser = kind === "user";
          const isSystem = kind === "system";
          const author = agentById.get(m.authorId);
          const toolUse = kind === "tool" || kind === "reasoning";
          const errorLine = kind === "error";
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

      {/* Sits just above the composer, centred on the transcript, and only exists while the
          reader is far enough up that new messages are landing off-screen. */}
      {scrolledUp && (
        <button className="jump-to-bottom" onClick={jumpToBottom} aria-label="Jump to the newest message">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 5v14M19 12l-7 7-7-7" />
          </svg>
        </button>
      )}

      <Composer
        surface="chat"
        placeholder={connected ? `Message ${chat.title}…` : "Reconnecting…"}
        ariaLabel={`Message ${chat.title}`}
        mentionAgents={agents}
        usage={{ rateLimits, providersInUse: [...new Set(agents.map((a) => a.provider))] }}
        onSend={onSend}
        onSubmitted={() => {
          // Sending a message is a deliberate "I'm back in this conversation" signal, even if
          // the reader had scrolled up to review earlier history - snap back to the bottom so
          // the message they just sent (and the reply that follows) is visible.
          stickToBottom.current = true;
          setScrolledUp(false);
          requestAnimationFrame(() => {
            if (historyRef.current) historyRef.current.scrollTop = historyRef.current.scrollHeight;
          });
        }}
      />
    </div>
  );
}

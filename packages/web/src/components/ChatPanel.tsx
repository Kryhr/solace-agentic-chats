import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AccountUsage,
  AgentConfig,
  AgentStatus,
  ChatMessage,
  ChatMeta,
  ProjectMeta,
  ProviderModelInfo,
  ProviderRateLimit,
  Task,
} from "@solace/shared";
import { ProviderIcon, UserAvatar } from "./ProviderIcon";
import { Composer } from "./Composer";
import { stopAgent } from "../api";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { useEntranceTracker } from "../lib/useEntranceTracker";
import { displayText, renderKind } from "../lib/messageKind";
import { buildGroupStream, chipFor, fullTextInHubOf, messageClassOf } from "../lib/messageClass";
import { operatorScope, queueNoticeFor, rateLimitedUntil } from "../lib/chatScope";
import { StatusRun } from "./StatusRun";
import { MessageText } from "./MessageText";
import { TaskBoardPanel } from "./TaskBoardPanel";
import { UrlBadges } from "./UrlBadges";

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function ChatPanel({
  chat,
  project,
  history,
  agents,
  statuses,
  tasks,
  modelCatalog,
  usage,
  onOpenHub,
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
  /** This chat's task board. Empty is the normal state for a chat whose agents have not put
   * anything on it yet, and renders as no toggle at all rather than as an empty control. */
  tasks: Task[];
  modelCatalog: ProviderModelInfo[];
  /** One row per account, from GET /api/usage. */
  usage: AccountUsage[];
  /** Open an agent's hub, at a specific turn when the caller knows which one. Supplied by App,
   * which owns routing; absent in any context with nowhere to navigate to, in which case the
   * "full detail in hub" link is not offered rather than being offered and doing nothing. */
  onOpenHub?: (agentId: string, turnId?: string) => void;
  connected: boolean;
  onNewChat: () => void;
  onSend: (text: string) => Promise<void>;
}) {
  const historyRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  /** Shown once the reader has scrolled far enough up that new messages are arriving off-screen.
   * A ref alone cannot drive this - it has to be state for the button to appear and disappear. */
  const [scrolledUp, setScrolledUp] = useState(false);
  /** The board starts collapsed: the transcript is what is being read, and a board that pushed
   * it down on every chat would cost more than it gives. Per tab and per session on purpose -
   * remembering it would mean deciding whose preference wins between two open tabs. */
  const [showTasks, setShowTasks] = useState(false);
  /** What is actually still waiting for somebody. A count of every task ever created would
   * climb forever and stop meaning anything. */
  const openTaskCount = tasks.filter((t) => t.status !== "done").length;

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

  /**
   * What the group actually shows: acknowledgements removed, consecutive status lines folded.
   *
   * Both are reversible views of a complete record - every message is still in the agent's own
   * hub, in full, in order. This drops nothing from the transcript, only from this rendering of
   * it. See lib/messageClass.ts for the class names this depends on and what happens before the
   * branch that produces them lands.
   */
  const stream = useMemo(() => buildGroupStream(history), [history]);

  /** Re-derived from history with the server's own rule - see lib/chatScope.operatorScope. */
  const scopedTo = useMemo(
    () => operatorScope(history, new Set(agents.map((a) => a.id))),
    [history, agents],
  );

  /**
   * One line per agent that cannot answer immediately.
   *
   * Scoped to the agents this message would actually REACH: while the chat is scoped, telling
   * the operator that an agent they are not talking to is busy is noise about somebody else's
   * work. Unscoped, a plain message goes to everyone, so everyone busy is worth saying.
   */
  const queueNotices = useMemo(() => {
    const reached = scopedTo.length > 0 ? agents.filter((a) => scopedTo.includes(a.handle)) : agents;
    return reached.map((a) => queueNoticeFor(a, statuses[a.id])).filter((n): n is string => n !== undefined);
  }, [agents, statuses, scopedTo]);

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

        {/* The group-chat action row. The "Save chat" button lands here in a later phase. */}
        <div className="hub-page-actions chat-header-actions">
          {tasks.length > 0 && (
            <button
              className={`task-board-toggle ${showTasks ? "is-open" : ""}`}
              onClick={() => setShowTasks((v) => !v)}
              aria-expanded={showTasks}
            >
              Tasks
              <span className="count">
                {openTaskCount === 0 ? "all done" : `${openTaskCount} open`}
              </span>
              <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 6.5 8 10.5l4-4" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Between the header and the transcript, on the same rail as both, so opening it reads
          as the page telling you more rather than as a panel arriving from somewhere else. */}
      <TaskBoardPanel tasks={tasks} agents={agents} open={showTasks} />
      {/* One line per agent that has something true to say about itself right now: what tool it
          is running, or when its account can work again. An agent that is simply idle says
          nothing - a permanent roster strip repeating "idle · idle · idle" is chrome, and the
          sidebar already answers "who is in this chat". */}
      {agents.some((a) => statuses[a.id]?.workingOn || rateLimitedUntil(statuses[a.id])) && (
        <div className="chat-roster-strip">
          {agents.map((a) => {
            const status = statuses[a.id];
            const limitedUntil = rateLimitedUntil(status);
            const working = status?.workingOn;
            if (!working && !limitedUntil) return null;
            return (
              <div key={a.id} className="chat-roster-line">
                <ProviderIcon provider={a.provider} size={14} />
                <span className="chat-roster-handle">@{a.handle}</span>
                {limitedUntil ? (
                  <span className="chat-roster-limited">rate-limited until {formatTime(limitedUntil)}</span>
                ) : (
                  <span className="chat-roster-working">
                    {/* The provider's own tool name through the fixed label table - never a
                        description of what the agent is trying to achieve. */}
                    working on: <span className="chat-roster-tool">{working}</span>
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

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
        {stream.map((item) => {
          if (item.kind === "status-run") return <StatusRun key={item.id} messages={item.messages} />;
          const m = item.message;
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
          // What the routing layer classified this as, if anything. Undefined for every message
          // today and for every message ever persisted - see lib/messageClass.ts.
          const messageClass = messageClassOf(m);
          const chip = chipFor(messageClass);
          // Only when the reply budget ACTUALLY cut this message. Recomputing it from the text
          // length here would put the link on any message that merely happened to be long.
          const cut = fullTextInHubOf(m);
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
            <div
              key={m.id}
              className={`message-row ${isUser ? "from-user" : ""} ${enter} ${
                messageClass ? `is-class-${messageClass}` : ""
              }`}
            >
              {isUser ? <UserAvatar /> : author ? <ProviderIcon provider={author.provider} /> : <UserAvatar />}
              <div className="message">
                <div className="meta">
                  <span className="meta-author">{m.authorHandle}</span>
                  {/* Before the model and the mentions, because what a message IS changes how
                      you read the rest of the line. */}
                  {chip && <span className={`class-chip class-chip-${chip.tone}`}>{chip.label}</span>}
                  {showModel && modelLabel && <span className="meta-model">{modelLabel}</span>}
                  {m.mentions.map((h) => (
                    <span key={h} className="mention">
                      @{h}
                    </span>
                  ))}
                  <span className="meta-time">{formatTime(m.createdAt)}</span>
                </div>
                <div className={`body ${toolUse ? "tool-use" : ""} ${errorLine ? "error-line" : ""}`}>
                  <MessageText text={text} />
                </div>
                {/* Any localhost URL in this message, with what really answered on it. Renders
                    nothing at all when no check ran - see UrlBadges. */}
                <UrlBadges checks={m.urlChecks} />
                {/* The room gets the head; the hub keeps the whole thing. The link says how much
                    more there is, from the length the server recorded when it cut - never an
                    estimate, and never a promise of detail that turns out not to exist. */}
                {cut && onOpenHub && (
                  <button
                    type="button"
                    className="hub-link"
                    onClick={() => onOpenHub(m.authorId, cut.turnId)}
                  >
                    full detail in hub
                    <span className="hub-link-size">{cut.chars.toLocaleString()} chars</span>
                    <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M6 3.5l4.5 4.5L6 12.5" />
                    </svg>
                  </button>
                )}
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
        busyAgents={thinkingAgents}
        onStopAgents={(list) => {
          // Fire-and-forget per agent: stopping is best-effort by nature (the turn may finish
          // on its own between the click and the request arriving), and one failure must not
          // prevent the others from being stopped.
          for (const a of list) void stopAgent(a.id);
        }}
        usage={usage}
        scopedTo={scopedTo}
        queueNotices={queueNotices}
        // Sends the command rather than clearing anything locally: the scope lives in the
        // history the server reads, so the only way to actually clear it is to post a message
        // that mentions nobody, which is exactly what /all does.
        onClearScope={() => void onSend("/all")}
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

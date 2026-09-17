import { useRef, useState } from "react";
import { COMMAND_DEFINITIONS } from "@solace/shared";
import type { AccountUsage, AgentConfig } from "@solace/shared";
import { ProviderIcon } from "./ProviderIcon";
import { SendIcon } from "./SendIcon";
import { UsageMeter } from "./UsageMeter";

/**
 * The one composer, used by both the group chat and an agent's hub.
 *
 * These were two near-identical copies that had already drifted: the hub's had no mention or
 * slash autocomplete, no usage meter, a hard-coded 160px max height instead of the shared
 * constant, and - the reason the drift actually bit - no `.composer-wrap` around it, so the
 * autocomplete menu had nothing to anchor to and could not have been added there without
 * first fixing the markup. Everything optional is a prop; nothing is duplicated.
 */

/** Matches the textarea's own `max-height` in styles.css. */
const MAX_COMPOSER_HEIGHT = 160;



/** Finds the "@partial" token touching the cursor, so we know what to autocomplete. */
function findMentionQuery(text: string, cursor: number): { start: number; query: string } | null {
  const upToCursor = text.slice(0, cursor);
  const at = upToCursor.lastIndexOf("@");
  if (at === -1) return null;
  const between = upToCursor.slice(at + 1);
  if (/\s/.test(between)) return null; // the "@" isn't part of the token under the cursor anymore
  return { start: at, query: between };
}

/** Only offered while typing the very first token of the message and it starts with "/". */
function findSlashQuery(text: string, cursor: number): string | null {
  if (!text.startsWith("/")) return null;
  const upToCursor = text.slice(0, cursor);
  if (/\s/.test(upToCursor)) return null;
  return upToCursor.slice(1);
}

export function Composer({
  placeholder,
  ariaLabel,
  onSend,
  onSubmitted,
  mentionAgents,
  scopedTo,
  onClearScope,
  queueNotices,
  surface,
  busyAgents,
  onStopAgents,
  usage,
}: {
  placeholder: string;
  ariaLabel: string;
  onSend: (text: string) => Promise<void>;
  /** Called the moment a send is dispatched, so the caller can snap its transcript to the bottom. */
  onSubmitted?: () => void;
  /** Supplying agents turns on "@handle" autocomplete; the hub has no one to mention. */
  mentionAgents?: AgentConfig[];
  /** Where this composer is. Chat-only commands are not offered on a hub page and vice versa -
   * offering one that can only answer "that doesn't work here" is worse than not listing it. */
  surface?: "chat" | "hub";
  /** Agents currently mid-turn in THIS chat. Supplying them turns on the stop control - an
   * agent can run for minutes, and until now the only way to call one off was the /stop command
   * or its own hub page. */
  busyAgents?: AgentConfig[];
  onStopAgents?: (agents: AgentConfig[]) => void;
  /** One row per ACCOUNT, already resolved by the server (GET /api/usage). The composer does
   * not join limits to accounts itself: which login a figure belongs to is a server-side fact
   * and getting it wrong here would show one subscription's quota against another. */
  usage?: AccountUsage[];
  /**
   * Which agents this chat's work is currently scoped to, and how to clear it.
   *
   * The scope was already being ENFORCED - an agent's reply cannot widen the roster past the
   * agents the operator named - while being completely invisible. The chip is the missing half:
   * from the operator's side, routing that silently ignores an agent is indistinguishable from
   * the app ignoring their addressing. Empty means unscoped, and the chip is not rendered.
   */
  scopedTo?: string[];
  onClearScope?: () => void;
  /**
   * One line per agent that cannot answer straight away, as the server reported it. Written by
   * the caller (lib/chatScope.queueNoticeFor) rather than derived here, because whether an
   * estimate may be quoted at all depends on how many turns that agent has actually finished.
   */
  queueNotices?: string[];
}) {
  const [draft, setDraft] = useState("");
  const [cursor, setCursor] = useState(0);
  const [highlighted, setHighlighted] = useState(0);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const mention = mentionAgents ? findMentionQuery(draft, cursor) : null;
  const mentionSuggestions = mention
    ? (mentionAgents ?? []).filter((a) => a.handle.toLowerCase().startsWith(mention.query.toLowerCase()))
    : [];
  const slashQuery = mention ? null : findSlashQuery(draft, cursor);
  // Filtered from the SHARED definitions, not a copy kept here. The copy had drifted: /trust,
  // /agents, /save, /vault and /deploy all worked on the server and were missing from it, so
  // typing "/trust" matched nothing and no menu appeared at all.
  const slashSuggestions =
    slashQuery !== null
      ? COMMAND_DEFINITIONS.filter(
          (c) =>
            c.name.startsWith(slashQuery.toLowerCase()) &&
            (c.scope === "both" || c.scope === (surface ?? "chat")),
        )
      : [];
  const hasSuggestions = mentionSuggestions.length > 0 || slashSuggestions.length > 0;

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
    setSending(true);
    // Clear optimistically so typing feels instant - but if the request actually fails (most
    // commonly: the dev server just hot-reloaded and the WS/HTTP layer hasn't reconnected yet),
    // put the text back instead of letting it silently vanish with no trace anything went
    // wrong. Only restore into an empty box, so it doesn't clobber something new the user
    // already started typing while the failed request was in flight.
    onSend(text)
      .catch(() => {
        setSendError("Couldn't send - the connection may have dropped. Your message is back in the box.");
        setDraft((current) => (current === "" ? text : current));
      })
      .finally(() => setSending(false));
    setDraft("");
    setCursor(0);
    onSubmitted?.();
    requestAnimationFrame(resizeComposer);
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

  return (
    <div className="composer-wrap">
      {mentionSuggestions.length > 0 && (
        <div className="mention-menu" role="listbox" aria-label="Agents">
          {mentionSuggestions.map((a, i) => (
            <button
              key={a.id}
              type="button"
              role="option"
              aria-selected={i === highlighted}
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
        <div className="mention-menu" role="listbox" aria-label="Commands">
          {slashSuggestions.map((c, i) => (
            <button
              key={c.name}
              type="button"
              role="option"
              aria-selected={i === highlighted}
              className={`mention-option ${i === highlighted ? "active" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                acceptSlashCommand(c.name);
              }}
            >
              <span className="slash-command-name">/{c.name}</span>
              {c.hint && <span className="slash-command-hint">{c.hint}</span>}
              <span className="slash-command-help">{c.help}</span>
            </button>
          ))}
        </div>
      )}
      {/* Above the composer, not inside it: this describes where the next message will GO, so it
          belongs between the transcript and the box rather than among the box's own controls. */}
      {scopedTo && scopedTo.length > 0 && (
        <div className="scope-chip">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="8" cy="8" r="5.5" />
            <path d="M8 5.5v2.8l1.8 1.1" />
          </svg>
          <span className="scope-chip-text">
            Scoped to {scopedTo.map((h) => `@${h}`).join(" ")}
          </span>
          {onClearScope && (
            <button type="button" className="scope-chip-clear" onClick={onClearScope}>
              /all to clear
            </button>
          )}
        </div>
      )}

      <div className="composer">
        {/* Polite, not assertive: this appears as a side effect of an agent becoming busy, which
            is not an interruption worth cutting across whatever a screen reader is reading. */}
        {queueNotices && queueNotices.length > 0 && (
          <div className="composer-queue" aria-live="polite">
            {queueNotices.map((notice) => (
              <span key={notice} className="composer-queue-line">
                {notice}
              </span>
            ))}
          </div>
        )}
        {sendError && (
          <div className="composer-error" role="alert">
            {sendError}
          </div>
        )}
        <div className="composer-field">
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            aria-label={ariaLabel}
            placeholder={placeholder}
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
          {usage && <UsageMeter accounts={usage} />}
          {/* Sits beside Send rather than replacing it: a turn running is not a reason you
              cannot say something else, and swapping the button under the cursor mid-thought is
              how people stop the wrong thing. Only rendered while something is actually
              running, so the resting composer is unchanged. */}
          {busyAgents && busyAgents.length > 0 && onStopAgents && (
            <button
              type="button"
              className="stop-btn"
              onClick={() => onStopAgents(busyAgents)}
              aria-label={
                busyAgents.length === 1 ? `Stop ${busyAgents[0].handle}` : `Stop ${busyAgents.length} working agents`
              }
              title={`Stop ${busyAgents.map((a) => a.handle).join(", ")} - the work it has already done is kept`}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            </button>
          )}
          <button
            type="button"
            className={`send-btn ${sending ? "is-sending" : ""}`}
            onClick={submit}
            disabled={!draft.trim() || sending}
            aria-label="Send message"
            aria-busy={sending}
            title="Send · Enter"
          >
            <SendIcon />
          </button>
        </div>
        <div className="composer-hint">
          {mentionAgents && (
            <span>
              No <code>@</code> → everyone replies · <code>@handle</code> → just them
            </span>
          )}
          <span>
            <code>/</code> commands
          </span>
          <span>
            <code>Shift</code> + <code>Enter</code> for a new line
          </span>
        </div>
      </div>
    </div>
  );
}

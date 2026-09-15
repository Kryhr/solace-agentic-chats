import { useRef, useState } from "react";
import type { AgentConfig, ProviderId, ProviderRateLimit } from "@solace/shared";
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

const SLASH_COMMANDS = [
  { name: "task", hint: "@handle <description>" },
  { name: "status", hint: "" },
  { name: "usage", hint: "" },
  { name: "reset", hint: "(from an agent's hub)" },
  { name: "github", hint: "status | init <repo-name>" },
  { name: "clear", hint: "" },
  { name: "model", hint: "<value> (from an agent's hub)" },
  { name: "effort", hint: "<value> (from an agent's hub)" },
  { name: "help", hint: "" },
];

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
  usage,
}: {
  placeholder: string;
  ariaLabel: string;
  onSend: (text: string) => Promise<void>;
  /** Called the moment a send is dispatched, so the caller can snap its transcript to the bottom. */
  onSubmitted?: () => void;
  /** Supplying agents turns on "@handle" autocomplete; the hub has no one to mention. */
  mentionAgents?: AgentConfig[];
  usage?: { rateLimits: ProviderRateLimit[]; providersInUse: ProviderId[] };
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
  const slashSuggestions =
    slashQuery !== null ? SLASH_COMMANDS.filter((c) => c.name.startsWith(slashQuery.toLowerCase())) : [];
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
            </button>
          ))}
        </div>
      )}
      <div className="composer">
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
          {usage && <UsageMeter rateLimits={usage.rateLimits} providersInUse={usage.providersInUse} />}
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

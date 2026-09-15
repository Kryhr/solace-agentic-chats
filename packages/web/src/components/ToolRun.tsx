import { useState } from "react";
import type { ChatMessage } from "@solace/shared";
import { displayText } from "../lib/messageKind";

/**
 * A collapsed run of tool-use lines.
 *
 * The hub used to render every `_used …_` line inline, so an agent that read ten files buried
 * its own answer under ten lines of bookkeeping - the detail is worth keeping, it just isn't
 * what you are looking at the page to read.
 *
 * The disclosure deliberately reuses the `.archive-entry` markup and classes from Saved chats
 * rather than introducing a second disclosure idiom: the app should have one of these, not two.
 * The one thing it does not reuse is that page's single-`openId` accordion state, which would
 * force a reader comparing two runs to keep closing one to see the other. State is per-group
 * and local, so any number can be open at once.
 */
export function ToolRun({ messages }: { messages: ChatMessage[] }) {
  const [open, setOpen] = useState(false);
  const count = messages.length;
  // The most recent call is the useful one to show closed: it's what the agent is doing now.
  const latest = displayText(messages[count - 1].text);

  return (
    <div className={`archive-entry tool-run ${open ? "is-open" : ""}`}>
      <button
        type="button"
        className="archive-entry-header tool-run-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="archive-entry-title tool-run-title">
          <svg
            className="archive-chevron"
            viewBox="0 0 16 16"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M6 3.5 10.5 8 6 12.5" />
          </svg>
          {count === 1 ? "1 tool call" : `${count} tool calls`}
        </span>
        {!open && (
          <span className="archive-entry-meta tool-run-latest" title={latest}>
            {latest}
          </span>
        )}
      </button>
      {open && (
        <div className="archive-entry-body tool-run-body">
          {messages.map((m) => (
            <div key={m.id} className="tool-run-line">
              {displayText(m.text)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

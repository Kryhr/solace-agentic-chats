import { useState } from "react";
import type { ChatMessage } from "@solace/shared";
import { displayText } from "../lib/messageKind";

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * A run of status messages, collapsed to one row.
 *
 * Closed by default and closed is the honest resting state: these are reports nobody in the room
 * asked for, and the roadmap measured nineteen of them in a single session, each landing at the
 * same weight as a message somebody actually wrote to somebody. The row still names WHO reported
 * and how many, because "3 updates" from nobody in particular is not information.
 *
 * Nothing is summarised. Opening it shows each line exactly as it was posted - the house rule is
 * that the app never generates a description of what agents said, and a status row is the most
 * tempting place in the app to break it.
 */
export function StatusRun({ messages }: { messages: ChatMessage[] }) {
  const [open, setOpen] = useState(false);
  const who = [...new Set(messages.map((m) => m.authorHandle))];
  const label =
    messages.length === 1
      ? `1 update from @${who[0]}`
      : `${messages.length} updates from ${who.map((h) => `@${h}`).join(", ")}`;

  return (
    <div className="message-row status-run-row">
      <div className={`status-run ${open ? "is-open" : ""}`}>
        <button
          type="button"
          className="status-run-toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <svg
            className="status-run-chevron"
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
            <path d="M6 4l4 4-4 4" />
          </svg>
          <span className="status-run-label">{label}</span>
          <span className="status-run-time">{formatTime(messages[messages.length - 1].createdAt)}</span>
        </button>
        {open && (
          <ul className="status-run-list">
            {messages.map((m) => (
              <li key={m.id} className="status-run-item">
                <span className="status-run-author">@{m.authorHandle}</span>
                <span className="status-run-text">{displayText(m.text)}</span>
                <span className="status-run-time">{formatTime(m.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

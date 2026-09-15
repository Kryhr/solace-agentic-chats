import { useState } from "react";
import type { ChatMessage } from "@solace/shared";
import {
  activityIcon,
  activityLabel,
  displayText,
  isFailedCall,
  renderKind,
  toolSummaryOf,
  type ActivityIcon,
} from "../lib/messageKind";

/**
 * One calm status line standing in for a run of tool calls and reasoning.
 *
 * The hub used to render every call as its own chat message - `_used Read({"file_path":"…"})_`,
 * one per file - so an agent that read ten files buried its own answer under ten lines of JSON.
 * Closed, this says one thing: what the agent is doing right now, in words derived from the real
 * tool name and arguments (see server/core/toolLabel.ts). Open, it is the whole run, unabridged.
 *
 * Nothing is dropped and nothing is summarised. The closed label is the latest entry's own
 * label, not a description of the run, because a sentence about what a turn accomplished is
 * exactly the kind of thing this app must not invent. Errors never reach this component at all -
 * they are their own transcript rows - and a call that exited non-zero marks the closed header
 * so a failure inside a run can't sit here looking as quiet as a success.
 *
 * The disclosure reuses the `.archive-entry` markup from Saved chats rather than introducing a
 * second disclosure idiom, minus that page's single-`openId` accordion state, which would force
 * a reader comparing two runs to keep closing one to see the other.
 */
function Glyph({ icon }: { icon: ActivityIcon }) {
  const common = {
    viewBox: "0 0 16 16",
    width: 13,
    height: 13,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (icon) {
    case "file":
      return (
        <svg {...common}>
          <path d="M9 1.75H4.25a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1V5.5z" />
          <path d="M9 1.75V5.5h3.75" />
        </svg>
      );
    case "edit":
      return (
        <svg {...common}>
          <path d="M11.2 2.3a1.6 1.6 0 0 1 2.3 2.3L5.9 12.2l-3 .7.7-3z" />
          <path d="M10.2 3.4 12.4 5.6" />
        </svg>
      );
    case "terminal":
      return (
        <svg {...common}>
          <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1" />
          <path d="M4.75 6.25 6.75 8l-2 1.75M8.75 10h3" />
        </svg>
      );
    case "search":
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="4.25" />
          <path d="M10.2 10.2 13.5 13.5" />
        </svg>
      );
    case "globe":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.25" />
          <path d="M1.75 8h12.5M8 1.75c3 3.4 3 9.1 0 12.5-3-3.4-3-9.1 0-12.5" />
        </svg>
      );
    case "think":
      return (
        <svg {...common}>
          <path d="M8 1.75v2M8 12.25v2M1.75 8h2M12.25 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6 11 5M5 11l-1.4 1.4" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="2.75" />
        </svg>
      );
  }
}

export function ActivityRun({
  messages,
  live,
  failed,
}: {
  messages: ChatMessage[];
  /** This run is the tail of a turn still in flight, so the indicator pulses. Purely a
   * restatement of the agent's real status - it is not a claim that anything finished. */
  live: boolean;
  failed: boolean;
}) {
  const [open, setOpen] = useState(false);
  const count = messages.length;
  const label = activityLabel(messages);
  const icon = activityIcon(messages);
  const steps = count === 1 ? "1 step" : `${count} steps`;

  return (
    <div className={`archive-entry activity-run ${open ? "is-open" : ""} ${failed ? "is-failed" : ""}`}>
      <button
        type="button"
        className="archive-entry-header activity-run-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={`activity-glyph ${live ? "is-live" : ""}`}>
          <Glyph icon={icon} />
        </span>
        <span className="activity-run-label">{label}</span>
        {failed && <span className="activity-run-failed">a step failed</span>}
        <span className="activity-run-count">
          {steps}
          <svg
            className="archive-chevron activity-chevron"
            viewBox="0 0 16 16"
            width="11"
            height="11"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M6 3.5 10.5 8 6 12.5" />
          </svg>
        </span>
      </button>
      {open && (
        <div className="archive-entry-body activity-run-body">
          {messages.map((m) => {
            if (renderKind(m) === "reasoning") {
              return (
                <div key={m.id} className="activity-step activity-step-reasoning">
                  <span className="activity-step-kind">Thinking</span>
                  <div className="activity-step-text">{m.text}</div>
                </div>
              );
            }
            const summary = toolSummaryOf(m);
            return (
              <div key={m.id} className={`activity-step ${isFailedCall(summary) ? "is-failed" : ""}`}>
                <span className="activity-step-kind">
                  {summary.label}
                  {summary.exitCode !== undefined && (
                    <span className="activity-step-exit">exit {summary.exitCode}</span>
                  )}
                </span>
                {/* The verbatim call. `detail` for anything the server classified, and the raw
                    `_used …_` body for history written before it did - either way it is the
                    provider's own words, which is the whole reason this disclosure exists. */}
                <div className="activity-step-text">{summary.detail || displayText(m.text)}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

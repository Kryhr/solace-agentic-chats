import { useEffect, useRef, useState } from "react";
import type { AgentConfig, AgentStatus, ChatMessage, ProviderModelInfo, ProviderPermissionInfo, TrustLevel } from "@solace/shared";
import { ProviderIcon, providerLabel, UserAvatar } from "./ProviderIcon";
import { Composer } from "./Composer";
import { ActivityRun } from "./ActivityRun";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { useEntranceTracker } from "../lib/useEntranceTracker";
import { effortOptionsFor } from "../lib/modelOptions";
import { ModelPicker, ModelSourceNote, ResolvedModelNote } from "./ModelPicker";
import { permissionOptionsFor, TRUST_LABELS } from "../lib/permissionOptions";
import { formatProviderError } from "../lib/errorFormat";
import { buildTranscript, displayText, renderKind } from "../lib/messageKind";
import { MessageText } from "./MessageText";
import { UrlBadges } from "./UrlBadges";
import { TokenUsageBar } from "./TokenUsageBar";

export function AgentHubPage({
  agent,
  status,
  modelInfo,
  permissionInfo,
  directHistory,
  focusTurnId,
  onBack,
  backLabel,
  onSave,
  onSendDirect,
  onClearHistory,
  onRemoveAgent,
  onStop,
  onRetry,
}: {
  agent: AgentConfig;
  status?: AgentStatus;
  modelInfo?: ProviderModelInfo;
  permissionInfo?: ProviderPermissionInfo;
  directHistory: ChatMessage[];
  /** The turn the reader came here to read in full, from a "full detail in hub" link. Absent for
   * every other way of arriving, which keeps the normal case - open the hub, land at the newest
   * message - exactly as it was. */
  focusTurnId?: string;
  onBack: () => void;
  /** The chat this returns to. Hardcoding "Group chat" was fine when there was only one; with
   * several it named a chat you were often not going back to. */
  backLabel: string;
  onSave: (patch: Partial<Pick<AgentConfig, "trustLevel" | "model" | "effort">>) => void;
  onSendDirect: (text: string) => Promise<void>;
  onClearHistory: () => void;
  onRemoveAgent: () => void;
  onStop: () => void;
  onRetry: () => void;
}) {
  const historyRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const state = status?.state ?? "offline";
  const effortOptions = effortOptionsFor(modelInfo, agent.model);
  const trustOptions = permissionOptionsFor(permissionInfo);
  const error = status?.lastError ? formatProviderError(status.lastError) : null;
  // Collapsed by default: the hub is a conversation, and a wall of pickers plus provenance
  // text above the first message made you scroll past the settings to read it.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const trackEntrance = useEntranceTracker();

  useEffect(() => {
    const el = historyRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [directHistory.length, state]);

  const onHistoryScroll = () => {
    const el = historyRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const shouldAnimate = trackEntrance(directHistory.map((m) => m.id));
  const transcript = buildTranscript(directHistory);

  /**
   * Land on the turn the reader came here to read, rather than at the bottom of the transcript.
   *
   * The whole promise of "full detail in hub" is that the rest of a capped answer is one click
   * away. Dropping someone at the newest message of a long hub and leaving them to find it
   * themselves keeps the letter of that and none of the point.
   *
   * It also stands the auto-scroll down for this arrival - otherwise the effect above would
   * yank them straight back to the bottom. Guarded on actually FINDING the turn: a hub whose
   * history has since been cleared, or a stale pasted link, scrolls nowhere and behaves exactly
   * as it did before rather than jumping somewhere arbitrary.
   */
  useEffect(() => {
    if (!focusTurnId) return;
    const first = directHistory.find((m) => m.turnId === focusTurnId);
    if (!first) return;
    const el = historyRef.current?.querySelector(`[data-message-id="${CSS.escape(first.id)}"]`);
    if (!el) return;
    stickToBottom.current = false;
    el.scrollIntoView({ block: "center" });
  }, [focusTurnId, directHistory]);

  return (
    <div className="hub-page">
      <div className="hub-page-header">
        <button className="back-btn" onClick={onBack}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          {backLabel}
        </button>
        <div className="hub-page-identity">
          <ProviderIcon provider={agent.provider} size={30} />
          <div>
            <h2>{agent.handle}</h2>
            <span className="hub-subtitle">
              <span className={`status-dot status-${state}`} /> {providerLabel(agent.provider)}
              <span className="sep">·</span> {state}
              {/* Which concrete model answered - the question an alias raises. Only rendered
                  when the provider itself reported one, and only when it differs from the
                  alias that was asked for. */}
              <ResolvedModelNote configured={agent.model} resolved={status?.resolvedModel} />
            </span>
          </div>
        </div>

        <div className="hub-page-live-actions">
          {state === "thinking" && (
            <button className="btn-secondary btn-xs" onClick={onStop} title="Cancel this turn without removing the agent">
              Stop
            </button>
          )}
          {status?.canRetry && (
            <button className="btn-secondary btn-xs" onClick={onRetry} title="Re-send the last message that failed">
              Retry
            </button>
          )}
          <button
            className="hub-settings-toggle"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen((v) => !v)}
            title="Model, effort, trust and agent actions"
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4" />
            </svg>
            Settings
          </button>
        </div>
      </div>

      {settingsOpen && (
        <div className="hub-settings-panel">
        <div className="hub-page-settings">
          {/* Model picking belongs here as much as at creation: switching an existing agent
              between two Opus variants is the whole point of listing them separately. */}
          <ModelPicker info={modelInfo} value={agent.model ?? ""} onChange={(model) => onSave({ model })} />
          {effortOptions.length > 0 && (
            <label>
              Effort
              <select
                className="select"
                value={agent.effort && effortOptions.includes(agent.effort) ? agent.effort : effortOptions[0]}
                onChange={(e) => onSave({ effort: e.target.value })}
              >
                {effortOptions.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Trust
            <select className="select" value={agent.trustLevel} onChange={(e) => onSave({ trustLevel: e.target.value as TrustLevel })}>
              {trustOptions.map((level) => (
                <option key={level} value={level}>
                  {TRUST_LABELS[level]}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="hub-page-sources">
          <ModelSourceNote info={modelInfo} />
        </div>

        <div className="hub-page-actions">
          <button
            className="btn-secondary btn-xs"
            onClick={() => {
              if (confirm(`Clear ${agent.handle}'s history? It'll be moved to Saved Chats, not deleted.`)) onClearHistory();
            }}
          >
            Clear history
          </button>
          <button
            className="btn-secondary danger btn-xs"
            onClick={() => {
              if (confirm(`Remove ${agent.handle}? This can't be undone (its chat history stays in Saved Chats).`)) {
                onRemoveAgent();
                onBack();
              }
            }}
          >
            Remove agent
          </button>
        </div>
        </div>
      )}

      {/* Renders only what the provider reported, and renders an unreported figure as an em
          dash rather than a zero - see TokenUsageBar. */}
      <TokenUsageBar usage={status?.totalUsage} authMode={agent.authMode} />
      {error && (
        <div className="hub-error-banner" title={error.full} role="alert">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <circle cx="8" cy="8" r="6.25" />
            <path d="M8 5v3.5M8 11h.01" />
          </svg>
          {error.headline}
          {status?.retryAt && ` · retrying at ${new Date(status.retryAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
        </div>
      )}

      <div className="hub-page-chat" ref={historyRef} onScroll={onHistoryScroll}>
        {directHistory.length === 0 && state !== "thinking" && (
          <div className="chat-empty">
            <div className="chat-empty-title">Direct line to {agent.handle}</div>
            <div className="chat-empty-body">
              Messages here stay between you and this agent — they don't appear in the group chat. Try{" "}
              <kbd>/help</kbd> to see what it accepts.
            </div>
            {/* An offline agent looks identical to an idle one once the transcript is empty, so
                the empty state is the only place left to say why nothing is happening. */}
            {state === "offline" && (
              <div className="chat-empty-note">
                {providerLabel(agent.provider)} hasn't started yet. It starts on your first message.
              </div>
            )}
          </div>
        )}
        {transcript.map((item, index) => {
          const isLast = index === transcript.length - 1;
          // Tool calls and reasoning collapse into one status line so the agent's actual output
          // is what the page shows. See ActivityRun for what stays reachable inside it.
          if (item.kind === "activity") {
            const enter = shouldAnimate(item.id) ? "message-enter" : "";
            return (
              <div key={item.id} className={`message-row hub-message activity-run-row ${enter}`}>
                <ActivityRun messages={item.messages} failed={item.failed} live={isLast && state === "thinking"} />
              </div>
            );
          }
          const m = item.message;
          const enter = shouldAnimate(m.id) ? "message-enter" : "";
          const kind = renderKind(m);
          if (kind === "system") {
            return (
              <div key={m.id} className={`message-row hub-message system-row ${enter}`}>
                <div className="body system-body">{m.text}</div>
              </div>
            );
          }
          // Narration the agent produced part-way through a turn is demoted, not hidden: smaller
          // type, no avatar, a quiet rail instead. It stays full text, selectable and in order -
          // folding it into the disclosure would have buried the agent's own words behind a
          // click, and this is the one thing on the page that is genuinely the agent speaking.
          //
          // The answer is the SAME message, promoted server-side once the turn actually ended
          // (AgentManager.drainQueue). Nothing here rewrites or summarises it, which is why
          // "all resolved" can only ever appear as the answer if the agent itself said it.
          const isProgress = kind === "progress";
          return (
            <div
              key={m.id}
              // So a "full detail in hub" link can scroll to the turn it names - see focusTurnId.
              data-message-id={m.id}
              className={`message-row hub-message ${kind === "user" ? "from-user" : ""} ${
                isProgress ? "is-progress" : ""
              } ${kind === "answer" ? "is-answer" : ""} ${enter}`}
            >
              {isProgress ? (
                <span className="progress-rail" aria-hidden="true" />
              ) : kind === "user" ? (
                <UserAvatar />
              ) : (
                <ProviderIcon provider={agent.provider} size={22} />
              )}
              <div className="message">
                <div className={`body ${kind === "error" ? "error-line" : ""}`}>
                  <MessageText text={displayText(m.text)} />
                </div>
                {/* The same verified badge the group chat shows. A hub is where an agent says
                    "the preview is at localhost:4321" most often, so leaving it unbadged here
                    would be leaving the claim unchecked exactly where it is most made. */}
                <UrlBadges checks={m.urlChecks} />
              </div>
            </div>
          );
        })}
        {/* Suppressed when the tail of the transcript is already a live activity run, which
            carries its own pulse - otherwise the page says the agent is working in two places. */}
        {state === "thinking" && transcript[transcript.length - 1]?.kind !== "activity" && (
          <ThinkingIndicator label={`${agent.handle} is working…`} />
        )}
      </div>

      <Composer
        surface="hub"
        placeholder={`Message ${agent.handle}…`}
        ariaLabel={`Message ${agent.handle} directly`}
        onSend={onSendDirect}
        onSubmitted={() => {
          stickToBottom.current = true;
          requestAnimationFrame(() => {
            if (historyRef.current) historyRef.current.scrollTop = historyRef.current.scrollHeight;
          });
        }}
      />
    </div>
  );
}

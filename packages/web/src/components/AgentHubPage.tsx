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

function formatTokens(n?: number): string {
  if (n === undefined) return "–";
  return n.toLocaleString();
}

export function AgentHubPage({
  agent,
  status,
  modelInfo,
  permissionInfo,
  directHistory,
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
  const totalIn = status?.totalUsage?.inputTokens ?? 0;
  const totalOut = status?.totalUsage?.outputTokens ?? 0;
  const totalTokens = totalIn + totalOut;
  const inPct = totalTokens > 0 ? Math.round((totalIn / totalTokens) * 100) : 50;
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

      {totalTokens > 0 && (
        <div className="hub-usage-bar">
          <div className="usage-meter" title={`${formatTokens(totalIn)} in / ${formatTokens(totalOut)} out this session`}>
            <div className="usage-meter-in" style={{ width: `${inPct}%` }} />
          </div>
          <span className="usage-meter-label">
            {formatTokens(totalIn)} in · {formatTokens(totalOut)} out this session
            {status?.totalUsage?.totalCostUsd !== undefined
              ? ` · $${status.totalUsage.totalCostUsd.toFixed(4)}${
                  agent.authMode === "api-key" ? " (actual)" : " (≈ API-equivalent, you're not billed per-token)"
                }`
              : ""}
          </span>
        </div>
      )}
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
                <div className={`body ${kind === "error" ? "error-line" : ""}`}>{displayText(m.text)}</div>
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

import { useEffect, useRef, useState } from "react";
import type { AgentConfig, AgentStatus, ChatMessage, ProviderModelInfo, ProviderPermissionInfo, TrustLevel } from "@solace/shared";
import { ProviderIcon, providerLabel, UserAvatar } from "./ProviderIcon";
import { SendIcon } from "./SendIcon";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { useEntranceTracker } from "../lib/useEntranceTracker";
import { effortOptionsFor, modelOptionsFor } from "../lib/modelOptions";
import { permissionOptionsFor, TRUST_LABELS } from "../lib/permissionOptions";
import { formatProviderError } from "../lib/errorFormat";

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
  onSave,
  onSendDirect,
  onClearHistory,
  onRemoveAgent,
}: {
  agent: AgentConfig;
  status?: AgentStatus;
  modelInfo?: ProviderModelInfo;
  permissionInfo?: ProviderPermissionInfo;
  directHistory: ChatMessage[];
  onBack: () => void;
  onSave: (patch: Partial<Pick<AgentConfig, "trustLevel" | "model" | "effort">>) => void;
  onSendDirect: (text: string) => void;
  onClearHistory: () => void;
  onRemoveAgent: () => void;
}) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const state = status?.state ?? "offline";
  const modelOptions = modelOptionsFor(modelInfo);
  const effortOptions = effortOptionsFor(modelInfo);
  const trustOptions = permissionOptionsFor(permissionInfo);
  const error = status?.lastError ? formatProviderError(status.lastError) : null;
  const totalIn = status?.totalUsage?.inputTokens ?? 0;
  const totalOut = status?.totalUsage?.outputTokens ?? 0;
  const totalTokens = totalIn + totalOut;
  const inPct = totalTokens > 0 ? Math.round((totalIn / totalTokens) * 100) : 50;
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

  const resizeComposer = () => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  const submitDirect = () => {
    if (!draft.trim()) return;
    onSendDirect(draft.trim());
    setDraft("");
    stickToBottom.current = true;
    requestAnimationFrame(() => {
      resizeComposer();
      if (historyRef.current) historyRef.current.scrollTop = historyRef.current.scrollHeight;
    });
  };

  const isToolUse = (text: string) => text.startsWith("_used ") && text.endsWith("_");
  const isErrorLine = (text: string) => text.startsWith("error: ");

  const shouldAnimate = trackEntrance(directHistory.map((m) => m.id));

  return (
    <div className="hub-page">
      <div className="hub-page-header">
        <button className="back-btn" onClick={onBack}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          Group chat
        </button>
        <div className="hub-page-identity">
          <ProviderIcon provider={agent.provider} size={30} />
          <div>
            <h2>{agent.handle}</h2>
            <span className="hub-subtitle">
              <span className={`status-dot status-${state}`} /> {providerLabel(agent.provider)}
              <span className="sep">·</span> {state}
            </span>
          </div>
        </div>

        <div className="hub-page-settings">
          {modelOptions.length > 0 && (
            <label>
              Model
              <select className="select" value={agent.model ?? modelOptions[0]} onChange={(e) => onSave({ model: e.target.value })}>
                {modelOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          )}
          {effortOptions.length > 0 && (
            <label>
              Effort
              <select className="select" value={agent.effort ?? effortOptions[0]} onChange={(e) => onSave({ effort: e.target.value })}>
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
          </div>
        )}
        {directHistory.map((m) => {
          const enter = shouldAnimate(m.id) ? "message-enter" : "";
          if (m.authorId === "system") {
            return (
              <div key={m.id} className={`message-row hub-message system-row ${enter}`}>
                <div className="body system-body">{m.text}</div>
              </div>
            );
          }
          const toolUse = isToolUse(m.text);
          const text = toolUse ? m.text.slice(6, -1) : m.text;
          const isUser = m.authorId === "user";
          return (
            <div key={m.id} className={`message-row hub-message ${isUser ? "from-user" : ""} ${enter}`}>
              {isUser ? <UserAvatar /> : <ProviderIcon provider={agent.provider} size={22} />}
              <div className="message">
                <div className={`body ${toolUse ? "tool-use" : ""} ${isErrorLine(m.text) ? "error-line" : ""}`}>{text}</div>
              </div>
            </div>
          );
        })}
        {state === "thinking" && <ThinkingIndicator label={`${agent.handle} is working…`} />}
      </div>

      <div className="composer">
        <div className="composer-field">
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            aria-label={`Message ${agent.handle} directly`}
            placeholder={`Message ${agent.handle}…`}
            onChange={(e) => {
              setDraft(e.target.value);
              resizeComposer();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submitDirect();
              }
            }}
          />
          <button
            className="send-btn"
            onClick={submitDirect}
            disabled={!draft.trim()}
            aria-label="Send message"
            title="Send · Enter"
          >
            <SendIcon />
          </button>
        </div>
        <div className="composer-hint">
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

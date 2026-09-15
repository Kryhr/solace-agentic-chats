import { useEffect, useRef, useState } from "react";
import type { AgentConfig, AgentStatus, ChatMessage, ProviderModelInfo, ProviderPermissionInfo, TrustLevel } from "@solace/shared";
import { ProviderIcon, providerLabel } from "./ProviderIcon";
import { ThinkingIndicator } from "./ThinkingIndicator";
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
}: {
  agent: AgentConfig;
  status?: AgentStatus;
  modelInfo?: ProviderModelInfo;
  permissionInfo?: ProviderPermissionInfo;
  directHistory: ChatMessage[];
  onBack: () => void;
  onSave: (patch: Partial<Pick<AgentConfig, "trustLevel" | "model" | "effort">>) => void;
  onSendDirect: (text: string) => void;
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
    requestAnimationFrame(resizeComposer);
  };

  const isToolUse = (text: string) => text.startsWith("_used ") && text.endsWith("_");
  const isErrorLine = (text: string) => text.startsWith("error: ");

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
              <span className={`status-dot status-${state}`} /> {providerLabel(agent.provider)} · {state}
            </span>
          </div>
        </div>

        <div className="hub-page-settings">
          {modelOptions.length > 0 && (
            <label>
              Model
              <select value={agent.model ?? modelOptions[0]} onChange={(e) => onSave({ model: e.target.value })}>
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
              <select value={agent.effort ?? effortOptions[0]} onChange={(e) => onSave({ effort: e.target.value })}>
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
            <select value={agent.trustLevel} onChange={(e) => onSave({ trustLevel: e.target.value as TrustLevel })}>
              {trustOptions.map((level) => (
                <option key={level} value={level}>
                  {TRUST_LABELS[level]}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {totalTokens > 0 && (
        <div className="hub-usage-bar">
          <div className="usage-meter" title={`${formatTokens(totalIn)} in / ${formatTokens(totalOut)} out this session`}>
            <div className="usage-meter-in" style={{ width: `${inPct}%` }} />
          </div>
          <span className="usage-meter-label">
            {formatTokens(totalIn)} in · {formatTokens(totalOut)} out this session
            {status?.totalUsage?.totalCostUsd !== undefined ? ` · $${status.totalUsage.totalCostUsd.toFixed(4)}` : ""}
          </span>
        </div>
      )}
      {error && (
        <div className="hub-error-banner" title={error.full}>
          {error.headline}
        </div>
      )}

      <div className="hub-page-chat" ref={historyRef} onScroll={onHistoryScroll}>
        {directHistory.length === 0 && state !== "thinking" && (
          <div className="chat-empty">Nothing here yet. Message {agent.handle} directly below.</div>
        )}
        {directHistory.map((m) => {
          if (m.authorId === "system") {
            return (
              <div key={m.id} className="message-row hub-message fade-in system-row">
                <div className="body system-body">{m.text}</div>
              </div>
            );
          }
          const toolUse = isToolUse(m.text);
          const text = toolUse ? m.text.slice(6, -1) : m.text;
          return (
            <div key={m.id} className={`message-row hub-message fade-in ${m.authorId === "user" ? "from-user" : ""}`}>
              {m.authorId !== "user" && <ProviderIcon provider={agent.provider} size={22} />}
              <div className="message">
                <div className={`body ${toolUse ? "tool-use" : ""} ${isErrorLine(m.text) ? "error-line" : ""}`}>{text}</div>
              </div>
            </div>
          );
        })}
        {state === "thinking" && <ThinkingIndicator label={`${agent.handle} is working…`} />}
      </div>

      <div className="composer">
        <textarea
          ref={inputRef}
          rows={1}
          value={draft}
          placeholder={`Message ${agent.handle} directly, or /help for commands…`}
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
        <button onClick={submitDirect} disabled={!draft.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}

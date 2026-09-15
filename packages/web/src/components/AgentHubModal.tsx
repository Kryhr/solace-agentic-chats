import { useEffect, useState } from "react";
import type { AgentConfig, AgentStatus, ChatMessage, ProviderModelInfo, TrustLevel } from "@solace/shared";
import { ProviderIcon, providerLabel } from "./ProviderIcon";

const TRUST_LABELS: Record<TrustLevel, string> = {
  "confirm-all": "Read-only",
  "confirm-risky": "Can edit files",
  "auto-approve": "Full auto",
};

function formatTokens(n?: number): string {
  if (n === undefined) return "–";
  return n.toLocaleString();
}

function UsageLine({ label, usage }: { label: string; usage?: { inputTokens?: number; outputTokens?: number; totalCostUsd?: number } }) {
  if (!usage || (usage.inputTokens === undefined && usage.outputTokens === undefined)) return null;
  return (
    <div className="usage-line">
      <span className="usage-label">{label}</span>
      <span>
        {formatTokens(usage.inputTokens)} in / {formatTokens(usage.outputTokens)} out
        {usage.totalCostUsd !== undefined ? ` · $${usage.totalCostUsd.toFixed(4)}` : ""}
      </span>
    </div>
  );
}

export function AgentHubModal({
  agent,
  status,
  modelInfo,
  directHistory,
  onClose,
  onSave,
  onSendDirect,
}: {
  agent: AgentConfig;
  status?: AgentStatus;
  modelInfo?: ProviderModelInfo;
  directHistory: ChatMessage[];
  onClose: () => void;
  onSave: (patch: Partial<Pick<AgentConfig, "trustLevel" | "model" | "effort">>) => void;
  onSendDirect: (text: string) => void;
}) {
  const [modelDraft, setModelDraft] = useState(agent.model ?? "");
  const [draft, setDraft] = useState("");

  useEffect(() => setModelDraft(agent.model ?? ""), [agent.id, agent.model]);

  const commitModel = () => {
    if (modelDraft !== (agent.model ?? "")) onSave({ model: modelDraft.trim() || undefined });
  };

  const submitDirect = () => {
    if (!draft.trim()) return;
    onSendDirect(draft.trim());
    setDraft("");
  };

  const state = status?.state ?? "offline";
  const datalistId = `model-suggestions-${agent.id}`;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal hub-modal" onClick={(e) => e.stopPropagation()}>
        <div className="hub-header">
          <ProviderIcon provider={agent.provider} size={26} />
          <div>
            <h3 style={{ margin: 0 }}>{agent.handle}</h3>
            <span className="hub-subtitle">
              <span className={`status-dot status-${state}`} /> {providerLabel(agent.provider)} · {state}
            </span>
          </div>
          <button className="btn-secondary" style={{ marginLeft: "auto" }} onClick={onClose}>
            Close
          </button>
        </div>

        <div className="hub-settings">
          <label>
            Model
            <input
              value={modelDraft}
              list={modelInfo?.modelExamples.length ? datalistId : undefined}
              placeholder={modelInfo?.currentDefaultModel ?? (modelInfo?.modelExamples.length ? modelInfo.modelExamples[0] : "provider default")}
              onChange={(e) => setModelDraft(e.target.value)}
              onBlur={commitModel}
              onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
            />
            {modelInfo?.modelExamples.length ? (
              <datalist id={datalistId}>
                {modelInfo.modelExamples.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            ) : null}
            {!agent.model && modelInfo?.currentDefaultModel && (
              <span className="field-hint">using your CLI's current default: {modelInfo.currentDefaultModel}</span>
            )}
          </label>

          {modelInfo?.effortLevels.length ? (
            <label>
              Thinking effort
              <select value={agent.effort ?? ""} onChange={(e) => onSave({ effort: e.target.value || undefined })}>
                <option value="">
                  Provider default{modelInfo.currentDefaultEffort ? ` (${modelInfo.currentDefaultEffort})` : ""}
                </option>
                {modelInfo.effortLevels.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <label>
            Trust level
            <select value={agent.trustLevel} onChange={(e) => onSave({ trustLevel: e.target.value as TrustLevel })}>
              {(Object.keys(TRUST_LABELS) as TrustLevel[]).map((level) => (
                <option key={level} value={level}>
                  {TRUST_LABELS[level]}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="hub-usage">
          <UsageLine label="Last turn" usage={status?.lastUsage} />
          <UsageLine label="Total this session" usage={status?.totalUsage} />
          {status?.lastError && <div className="usage-error">Last error: {status.lastError}</div>}
        </div>

        <div className="hub-chat">
          <div className="hub-chat-label">Direct chat with {agent.handle}</div>
          <div className="hub-chat-history">
            {directHistory.length === 0 && <div className="chat-empty">No direct messages yet.</div>}
            {directHistory.map((m) => {
              const isToolUse = m.text.startsWith("_used ") && m.text.endsWith("_");
              const isErrorLine = m.text.startsWith("error: ");
              const text = isToolUse ? m.text.slice(6, -1) : m.text;
              return (
                <div key={m.id} className={`message-row ${m.authorId === "user" ? "from-user" : ""}`}>
                  {m.authorId !== "user" && <ProviderIcon provider={agent.provider} size={20} />}
                  <div className="message">
                    <div className={`body ${isToolUse ? "tool-use" : ""} ${isErrorLine ? "error-line" : ""}`}>{text}</div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="composer" style={{ padding: 0, border: "none", background: "transparent" }}>
            <input
              value={draft}
              placeholder={`Message ${agent.handle} directly…`}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitDirect()}
            />
            <button onClick={submitDirect} disabled={!draft.trim()}>
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

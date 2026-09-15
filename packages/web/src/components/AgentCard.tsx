import type { AgentConfig, AgentStatus, ProviderModelInfo, TrustLevel } from "@solace/shared";
import { ProviderIcon } from "./ProviderIcon";

const TRUST_LABELS: Record<TrustLevel, string> = {
  "confirm-all": "Read-only",
  "confirm-risky": "Can edit files",
  "auto-approve": "Full auto",
};

export function AgentCard({
  agent,
  status,
  modelInfo,
  onTrustChange,
  onOpen,
}: {
  agent: AgentConfig;
  status?: AgentStatus;
  modelInfo?: ProviderModelInfo;
  onTrustChange: (level: TrustLevel) => void;
  onOpen: () => void;
}) {
  const state = status?.state ?? "offline";
  const task = agent.currentTask ?? status?.currentTask;
  const modelLabel = agent.model || modelInfo?.currentDefaultModel || "provider default";

  return (
    <div className="agent-card" onClick={onOpen} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onOpen()}>
      <div className="row">
        <div className="agent-identity">
          <ProviderIcon provider={agent.provider} />
          <span className="agent-handle" title={agent.handle}>
            {agent.handle}
          </span>
        </div>
        <span className="agent-model-tag" title={modelLabel}>
          {modelLabel}
        </span>
      </div>
      <div className="row" style={{ gap: 6 }}>
        <span className={`status-dot status-${state}`} title={state} />
        <span className={`task-line ${task ? "" : "empty"}`}>{task ?? "no task assigned"}</span>
      </div>
      <select
        className="trust-select"
        value={agent.trustLevel}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => onTrustChange(e.target.value as TrustLevel)}
      >
        {(Object.keys(TRUST_LABELS) as TrustLevel[]).map((level) => (
          <option key={level} value={level}>
            {TRUST_LABELS[level]}
          </option>
        ))}
      </select>
    </div>
  );
}

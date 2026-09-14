import type { AgentConfig, AgentStatus, TrustLevel } from "@solace/shared";
import { ProviderIcon } from "./ProviderIcon";

const TRUST_LABELS: Record<TrustLevel, string> = {
  "confirm-all": "Read-only",
  "confirm-risky": "Can edit files",
  "auto-approve": "Full auto",
};

export function AgentCard({
  agent,
  status,
  onTrustChange,
}: {
  agent: AgentConfig;
  status?: AgentStatus;
  onTrustChange: (level: TrustLevel) => void;
}) {
  const state = status?.state ?? "offline";
  const task = agent.currentTask ?? status?.currentTask;

  return (
    <div className="agent-card">
      <div className="row">
        <div className="agent-identity">
          <ProviderIcon provider={agent.provider} />
          <span className="agent-handle" title={agent.handle}>
            {agent.handle}
          </span>
        </div>
      </div>
      <div className="row" style={{ gap: 6 }}>
        <span className={`status-dot status-${state}`} title={state} />
        <span className={`task-line ${task ? "" : "empty"}`}>{task ?? "no task assigned"}</span>
      </div>
      <select
        className="trust-select"
        value={agent.trustLevel}
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

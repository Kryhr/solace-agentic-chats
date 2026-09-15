import type { AgentConfig, AgentStatus, ProviderModelInfo, ProviderPermissionInfo, TrustLevel } from "@solace/shared";
import { ProviderIcon, providerColor } from "./ProviderIcon";
import { permissionOptionsFor, TRUST_LABELS } from "../lib/permissionOptions";

export function AgentCard({
  agent,
  status,
  modelInfo,
  permissionInfo,
  onTrustChange,
  onOpen,
}: {
  agent: AgentConfig;
  status?: AgentStatus;
  modelInfo?: ProviderModelInfo;
  permissionInfo?: ProviderPermissionInfo;
  onTrustChange: (level: TrustLevel) => void;
  onOpen: () => void;
}) {
  const state = status?.state ?? "offline";
  const task = agent.currentTask ?? status?.currentTask;
  const modelLabel = agent.model || modelInfo?.currentDefaultModel;
  const modes = permissionOptionsFor(permissionInfo);

  return (
    <div
      className="agent-card"
      style={{ ["--accent-card-color" as string]: providerColor(agent.provider) }}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
    >
      <div className="row">
        <div className="agent-identity">
          <ProviderIcon provider={agent.provider} />
          <span className="agent-handle" title={agent.handle}>
            {agent.handle}
          </span>
        </div>
        {modelLabel && (
          <span className="agent-model-tag" title={modelLabel}>
            {modelLabel}
          </span>
        )}
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
        {modes.map((level) => (
          <option key={level} value={level}>
            {TRUST_LABELS[level]}
          </option>
        ))}
      </select>
    </div>
  );
}

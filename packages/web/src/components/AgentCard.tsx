import type { AgentConfig, AgentStatus, ProviderModelInfo, ProviderPermissionInfo, TrustLevel } from "@solace/shared";
import { ProviderIcon } from "./ProviderIcon";
import { permissionOptionsFor, TRUST_DESCRIPTIONS, TRUST_LABELS } from "../lib/permissionOptions";

const STATE_LABELS: Record<string, string> = {
  idle: "Idle",
  thinking: "Working",
  "waiting-approval": "Waiting on you",
  error: "Error",
  offline: "Offline",
};

/**
 * A dense two-line list row, not a card. The previous card stacked a bordered
 * container, a colored rail, a status line and a full-width <select> — roughly
 * 96px of chrome per agent, so four agents filled the sidebar. Everything is
 * still here, just placed on two lines with the trust picker inline.
 */
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
      className="agent-row"
      onClick={onOpen}
      role="button"
      tabIndex={0}
      aria-label={`Open ${agent.handle}'s hub`}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <span className="agent-avatar">
        <ProviderIcon provider={agent.provider} size={24} />
        <span className={`status-dot status-${state}`} title={STATE_LABELS[state] ?? state} />
      </span>

      <div className="agent-row-top">
        <span className="agent-handle" title={agent.handle}>
          {agent.handle}
        </span>
        {modelLabel && (
          <span className="agent-model-tag" title={modelLabel}>
            {modelLabel}
          </span>
        )}
      </div>

      <div className="agent-row-bottom">
        <span className={`task-line ${task ? "" : "empty"}`} title={task ?? undefined}>
          {task ?? (state === "offline" ? "Not started" : (STATE_LABELS[state] ?? state))}
        </span>
        {modes.length > 0 && (
          <select
            className="trust-select"
            value={agent.trustLevel}
            aria-label={`Trust level for ${agent.handle}`}
            title={TRUST_DESCRIPTIONS[agent.trustLevel]}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            onChange={(e) => onTrustChange(e.target.value as TrustLevel)}
          >
            {modes.map((level) => (
              <option key={level} value={level}>
                {TRUST_LABELS[level]}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}

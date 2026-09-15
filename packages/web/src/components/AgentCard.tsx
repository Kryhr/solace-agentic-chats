import { useEffect, useState } from "react";
import type { AgentConfig, AgentStatus, ProviderModelInfo, ProviderPermissionInfo, TrustLevel } from "@solace/shared";
import { ProviderIcon } from "./ProviderIcon";
import { permissionOptionsFor, TRUST_DESCRIPTIONS, TRUST_LABELS } from "../lib/permissionOptions";

/** "4s", "2m 10s", "1h 04m" - short enough for a sidebar row, and it keeps seconds while they
 * still mean something. Wall-clock since the turn started, not an estimate of anything. */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

/** Ticks once a second only while a turn is actually running, so an idle sidebar does no work. */
function useElapsed(startedAt: string | undefined): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  if (!startedAt) return null;
  const started = new Date(startedAt).getTime();
  if (!Number.isFinite(started)) return null;
  return formatElapsed(now - started);
}

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
  // Status first, config second. The config value is a label someone typed once via /task and
  // never updates itself, so preferring it meant an agent mid-build still advertised whatever
  // it had been asked to do hours earlier. The server derives the status value from the turn
  // actually running and falls back to the config label when idle, so it is always the more
  // truthful of the two.
  const task = status?.currentTask || agent.currentTask;
  const elapsed = useElapsed(status?.turnStartedAt);
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
        {elapsed && (
          <span className="agent-elapsed" title={`Working for ${elapsed}`}>
            {elapsed}
          </span>
        )}
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

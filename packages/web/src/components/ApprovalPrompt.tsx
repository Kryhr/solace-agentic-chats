import type { AgentConfig, PendingApproval } from "@solace/shared";
import { ProviderIcon } from "./ProviderIcon";

export function ApprovalPrompt({
  approval,
  agent,
  onResolve,
}: {
  approval: PendingApproval;
  agent?: AgentConfig;
  onResolve: (approved: boolean) => void;
}) {
  return (
    <div className="approval-card fade-in">
      {agent && <ProviderIcon provider={agent.provider} size={20} />}
      <div className="approval-body">
        <div className="approval-title">{agent?.handle ?? "agent"} wants to run:</div>
        <div className="approval-description">{approval.description}</div>
      </div>
      <div className="approval-actions">
        <button className="btn-secondary" onClick={() => onResolve(false)}>
          Deny
        </button>
        <button className="btn-primary" onClick={() => onResolve(true)}>
          Allow
        </button>
      </div>
    </div>
  );
}

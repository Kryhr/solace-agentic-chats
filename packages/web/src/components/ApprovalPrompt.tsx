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
    <div className="approval-card" role="alertdialog" aria-label="Permission request">
      {agent && <ProviderIcon provider={agent.provider} size={20} />}
      <div className="approval-body">
        <div className="approval-title">
          <strong>{agent?.handle ?? "An agent"}</strong> wants to run
        </div>
        <div className="approval-description">{approval.description}</div>
      </div>
      <div className="approval-actions">
        {/* Deny gets the visually emphasized button, not Allow - a permission gate whose
            "recommended-looking" button grants the risky action is a bad default for a tool
            whose entire job is letting a CLI agent run real shell commands and edit real
            files. Neither choice should look like a nudge toward approving. */}
        <button className="btn-secondary btn-xs" onClick={() => onResolve(true)}>
          Allow
        </button>
        <button className="btn-primary btn-xs" onClick={() => onResolve(false)}>
          Deny
        </button>
      </div>
    </div>
  );
}

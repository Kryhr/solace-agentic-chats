import { useState } from "react";
import type { AgentConfig, ProviderId, TrustLevel } from "@solace/shared";

const PROVIDERS: ProviderId[] = ["claude-code", "codex-cli", "gemini-cli", "qwen-code"];

export function AddAgentModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (config: Omit<AgentConfig, "id">) => void;
}) {
  const [handle, setHandle] = useState("");
  const [provider, setProvider] = useState<ProviderId>("claude-code");
  const [cwd, setCwd] = useState("");
  const [trustLevel, setTrustLevel] = useState<TrustLevel>("confirm-risky");

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: 0 }}>Add agent</h3>
        <label>
          Handle (used for @mentions)
          <input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="claude-1" />
        </label>
        <label>
          Provider
          <select value={provider} onChange={(e) => setProvider(e.target.value as ProviderId)}>
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label>
          Working directory
          <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="C:\path\to\project" />
        </label>
        <label>
          Trust level
          <select value={trustLevel} onChange={(e) => setTrustLevel(e.target.value as TrustLevel)}>
            <option value="confirm-all">Read-only</option>
            <option value="confirm-risky">Can edit files</option>
            <option value="auto-approve">Full auto</option>
          </select>
        </label>
        <div className="actions">
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            disabled={!handle || !cwd}
            onClick={() => handle && cwd && onCreate({ handle, provider, cwd, trustLevel })}
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

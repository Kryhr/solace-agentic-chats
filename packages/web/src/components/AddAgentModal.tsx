import { useEffect, useState } from "react";
import type { AgentConfig, ProviderId, ProviderModelInfo, TrustLevel } from "@solace/shared";
import { createProject, fetchProjects, type ProjectInfo } from "../api";
import { effortOptionsFor, modelOptionsFor } from "../lib/modelOptions";

const PROVIDERS: ProviderId[] = ["claude-code", "codex-cli", "gemini-cli", "qwen-code"];
const NEW_PROJECT_VALUE = "__new__";

export function AddAgentModal({
  modelCatalog,
  onClose,
  onCreate,
}: {
  modelCatalog: ProviderModelInfo[];
  onClose: () => void;
  onCreate: (config: Omit<AgentConfig, "id">) => void;
}) {
  const [handle, setHandle] = useState("");
  const [provider, setProvider] = useState<ProviderId>("claude-code");
  const [trustLevel, setTrustLevel] = useState<TrustLevel>("confirm-risky");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");

  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [newProjectName, setNewProjectName] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const info = modelCatalog.find((m) => m.provider === provider);
  const modelOptions = modelOptionsFor(info);
  const effortOptions = effortOptionsFor(info);

  useEffect(() => {
    fetchProjects().then(({ root, projects }) => {
      setWorkspaceRoot(root);
      setProjects(projects);
      if (projects.length > 0) setSelected(projects[0].path);
      else setSelected(NEW_PROJECT_VALUE);
    });
  }, []);

  // Whenever the provider changes, snap model/effort to that provider's own real options.
  useEffect(() => {
    setModel(modelOptions[0] ?? "");
    setEffort(effortOptions[0] ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  const isCreatingNew = selected === NEW_PROJECT_VALUE;

  const handleAdd = async () => {
    setError(null);
    let cwd = selected;
    if (isCreatingNew) {
      if (!newProjectName.trim()) {
        setError("Give the new project a name first");
        return;
      }
      try {
        setCreatingProject(true);
        const project = await createProject(newProjectName);
        cwd = project.path;
      } catch (err) {
        setError((err as Error).message);
        setCreatingProject(false);
        return;
      }
      setCreatingProject(false);
    }
    if (!handle || !cwd) return;
    onCreate({
      handle,
      provider,
      cwd,
      trustLevel,
      model: model || undefined,
      effort: effort || undefined,
    });
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Add agent</h3>
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
        {modelOptions.length > 0 && (
          <label>
            Model
            <select value={model} onChange={(e) => setModel(e.target.value)}>
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
            Thinking effort
            <select value={effort} onChange={(e) => setEffort(e.target.value)}>
              {effortOptions.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Project
          <select value={selected} onChange={(e) => setSelected(e.target.value)}>
            {projects.map((p) => (
              <option key={p.path} value={p.path}>
                {p.name}
              </option>
            ))}
            <option value={NEW_PROJECT_VALUE}>+ New project…</option>
          </select>
        </label>
        {isCreatingNew && (
          <label>
            New project name
            <input
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              placeholder="my-new-app"
              autoFocus
            />
          </label>
        )}
        <div style={{ fontSize: "0.6875rem", color: "var(--text-faint)" }}>
          Projects live under <code style={{ fontFamily: "var(--font-mono)" }}>{workspaceRoot}</code>
        </div>
        {error && <div style={{ fontSize: "0.75rem", color: "var(--danger)" }}>{error}</div>}
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
          <button className="btn-primary" disabled={!handle || creatingProject} onClick={handleAdd}>
            {creatingProject ? "Creating…" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}

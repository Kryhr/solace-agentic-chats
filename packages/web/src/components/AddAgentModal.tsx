import { useEffect, useState } from "react";
import type { AgentConfig, CredentialMeta, ProviderId, ProviderModelInfo, ProviderPermissionInfo, TrustLevel } from "@solace/shared";
import { createProject, fetchCredentials, fetchProjects, saveCredential, type ProjectInfo } from "../api";
import { effortOptionsFor, modelOptionsFor } from "../lib/modelOptions";
import { permissionOptionsFor, TRUST_LABELS } from "../lib/permissionOptions";

const PROVIDERS: ProviderId[] = ["claude-code", "codex-cli", "gemini-cli", "qwen-code"];
const NEW_PROJECT_VALUE = "__new__";
const NEW_KEY_VALUE = "__new__";
// Mirrors adapters/index.ts's apiAdapters map - only these two providers have a direct-API
// alternative to the CLI/subscription path today.
const API_KEY_CAPABLE: ProviderId[] = ["claude-code", "codex-cli"];

export function AddAgentModal({
  modelCatalog,
  permissionCatalog,
  onClose,
  onCreate,
}: {
  modelCatalog: ProviderModelInfo[];
  permissionCatalog: ProviderPermissionInfo[];
  onClose: () => void;
  onCreate: (config: Omit<AgentConfig, "id">) => void;
}) {
  const [handle, setHandle] = useState("");
  const [provider, setProvider] = useState<ProviderId>("claude-code");
  const [trustLevel, setTrustLevel] = useState<TrustLevel>("bypassPermissions");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");

  const [authMode, setAuthMode] = useState<"cli" | "api-key">("cli");
  const [credentials, setCredentials] = useState<CredentialMeta[]>([]);
  const [credentialId, setCredentialId] = useState<string>(NEW_KEY_VALUE);
  const [newKeyLabel, setNewKeyLabel] = useState("");
  const [newKeyValue, setNewKeyValue] = useState("");

  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [newProjectName, setNewProjectName] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const info = modelCatalog.find((m) => m.provider === provider);
  const modelOptions = modelOptionsFor(info);
  const effortOptions = effortOptionsFor(info);
  const permissionInfo = permissionCatalog.find((p) => p.provider === provider);
  const trustOptions = permissionOptionsFor(permissionInfo);
  const providerCredentials = credentials.filter((c) => c.provider === provider);

  // Escape closes the dialog. It read as broken without this: the backdrop was
  // already click-to-dismiss, so the modal was dismissible by mouse but not by
  // keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    fetchProjects().then(({ root, projects }) => {
      setWorkspaceRoot(root);
      setProjects(projects);
      if (projects.length > 0) setSelected(projects[0].path);
      else setSelected(NEW_PROJECT_VALUE);
    });
    fetchCredentials().then(setCredentials);
  }, []);

  // Whenever the provider changes, snap model/effort/trust to that provider's own real options.
  useEffect(() => {
    setModel(modelOptions[0] ?? "");
    setEffort(effortOptions[0] ?? "");
    setTrustLevel(trustOptions.includes("bypassPermissions") ? "bypassPermissions" : (trustOptions[0] ?? "bypassPermissions"));
    if (!API_KEY_CAPABLE.includes(provider)) setAuthMode("cli");
    // credentialId must reset too - a credential belongs to exactly one provider, and both
    // claude-code and codex-cli are API_KEY_CAPABLE, so switching between them previously left
    // a stale credentialId selected (pointing at the WRONG provider's saved key) with no
    // visible sign anything was wrong, since the <select>'s displayed value silently falls
    // back to whatever the browser shows for an out-of-list value while React's state still
    // held the old id - it would have been submitted as-is on Add.
    setCredentialId(NEW_KEY_VALUE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  const isCreatingNew = selected === NEW_PROJECT_VALUE;
  const isCreatingNewKey = credentialId === NEW_KEY_VALUE;

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

    let finalCredentialId: string | undefined;
    if (authMode === "api-key") {
      if (isCreatingNewKey) {
        if (!newKeyValue.trim()) {
          setError("Paste an API key first");
          return;
        }
        const saved = await saveCredential(provider, newKeyLabel.trim() || "unlabeled", newKeyValue.trim());
        finalCredentialId = saved.id;
      } else {
        finalCredentialId = credentialId;
      }
    }

    onCreate({
      handle,
      provider,
      cwd,
      trustLevel,
      model: model || undefined,
      effort: effort || undefined,
      authMode,
      credentialId: finalCredentialId,
    });
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Add agent" onClick={(e) => e.stopPropagation()}>
        <h3>Add agent</h3>
        <label>
          Handle (used for @mentions)
          <input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="claude-1" />
        </label>
        <label>
          Provider
          <select className="select" value={provider} onChange={(e) => setProvider(e.target.value as ProviderId)}>
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>

        {API_KEY_CAPABLE.includes(provider) && (
          <label>
            Sign-in method
            <select className="select" value={authMode} onChange={(e) => setAuthMode(e.target.value as "cli" | "api-key")}>
              <option value="cli">Subscription (this machine's CLI login)</option>
              <option value="api-key">API key</option>
            </select>
          </label>
        )}

        {authMode === "api-key" && (
          <>
            <label>
              API key
              <select className="select" value={credentialId} onChange={(e) => setCredentialId(e.target.value)}>
                {providerCredentials.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
                <option value={NEW_KEY_VALUE}>+ Add a new key…</option>
              </select>
            </label>
            {isCreatingNewKey && (
              <>
                <label>
                  Key label
                  <input value={newKeyLabel} onChange={(e) => setNewKeyLabel(e.target.value)} placeholder="personal" />
                </label>
                <label>
                  Paste API key
                  <input
                    type="password"
                    value={newKeyValue}
                    onChange={(e) => setNewKeyValue(e.target.value)}
                    placeholder="sk-…"
                    autoComplete="off"
                  />
                </label>
                <div className="field-note">
                  Stored locally on this machine only, never shown again after saving. Note: an API-key
                  agent is a plain chat model - no file/shell access, unlike the CLI-based agents.
                </div>
              </>
            )}
          </>
        )}

        {modelOptions.length > 0 && (
          <label>
            Model
            <select className="select" value={model} onChange={(e) => setModel(e.target.value)}>
              {modelOptions.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
        )}
        {effortOptions.length > 0 && authMode === "cli" && (
          <label>
            Thinking effort
            <select className="select" value={effort} onChange={(e) => setEffort(e.target.value)}>
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
          <select className="select" value={selected} onChange={(e) => setSelected(e.target.value)}>
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
        <div className="field-note">
          Projects live under <code>{workspaceRoot}</code>
        </div>
        {error && (
          <div className="field-error" role="alert">
            {error}
          </div>
        )}
        {authMode === "cli" && (
          <label>
            Trust level
            <select className="select" value={trustLevel} onChange={(e) => setTrustLevel(e.target.value as TrustLevel)}>
              {trustOptions.map((level) => (
                <option key={level} value={level}>
                  {TRUST_LABELS[level]}
                </option>
              ))}
            </select>
          </label>
        )}
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

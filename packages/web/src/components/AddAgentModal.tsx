import { useEffect, useState } from "react";
import type {
  AgentConfig,
  CredentialMeta,
  ModelDiscoveryResult,
  ProviderId,
  ProviderModelInfo,
  ProviderPermissionInfo,
  TrustLevel,
} from "@solace/shared";
import { createProject, fetchCredentials, fetchDiscoveredModels, fetchProjects, saveCredential, type ProjectInfo } from "../api";
import { effortOptionsFor, modelOptionsFor } from "../lib/modelOptions";
import { permissionOptionsFor, TRUST_LABELS } from "../lib/permissionOptions";

const PROVIDERS: ProviderId[] = ["claude-code", "codex-cli", "gemini-cli", "qwen-code", "custom", "local"];
const NEW_PROJECT_VALUE = "__new__";
const NEW_KEY_VALUE = "__new__";
// Mirrors adapters/index.ts's apiAdapters map - only these providers have a direct-API
// alternative to the CLI/subscription path today. "custom" and "local" are connection-only:
// there's no CLI to shell out to for an arbitrary OpenAI-compatible endpoint.
const API_KEY_CAPABLE: ProviderId[] = ["claude-code", "codex-cli", "custom", "local"];
const API_KEY_ONLY: ProviderId[] = ["custom", "local"];

/** Providers whose agent is backed by a saved connection (base URL + optional key) rather
 * than a CLI login - they share every special case in this modal. */
function isEndpointProvider(provider: ProviderId): boolean {
  return provider === "custom" || provider === "local";
}

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
  /** Models the selected connection's endpoint listed for itself, with when it said so.
   * null = not asked/failed; the model field stays free text either way. */
  const [discovered, setDiscovered] = useState<ModelDiscoveryResult | null>(null);
  const [discoveryState, setDiscoveryState] = useState<"idle" | "loading" | "failed">("idle");

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
    // Custom endpoints are API-key-only; every other provider goes back to its CLI default
    // rather than silently inheriting "API key" from a provider that was only ever one.
    setAuthMode(API_KEY_ONLY.includes(provider) ? "api-key" : "cli");
    // credentialId must reset too - a credential belongs to exactly one provider, and both
    // claude-code and codex-cli are API_KEY_CAPABLE, so switching between them previously left
    // a stale credentialId selected (pointing at the WRONG provider's saved key) with no
    // visible sign anything was wrong, since the <select>'s displayed value silently falls
    // back to whatever the browser shows for an out-of-list value while React's state still
    // held the old id - it would have been submitted as-is on Add.
    // Custom endpoints can't be added inline (they need a base URL too, which belongs to the
    // Connections panel's flow) - so default to the first one already saved there.
    setCredentialId(isEndpointProvider(provider) ? (providerCredentials[0]?.id ?? "") : NEW_KEY_VALUE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  // fetchCredentials() (mount effect above) is async - if the user switches to "custom"
  // before it resolves, the effect above runs with providerCredentials still empty and
  // leaves credentialId at "". When credentials then arrive, the <select> visually shows its
  // first real option selected (a bare <select value=""> falls back to showing the first
  // <option> even though nothing matches), but credentialId stays "" - Add then rejects with
  // "add this endpoint under Connections first" even though one is visibly selected. Re-sync
  // once real credentials show up, but only while nothing has been chosen yet.
  useEffect(() => {
    if (isEndpointProvider(provider) && !credentialId && providerCredentials.length > 0) {
      setCredentialId(providerCredentials[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credentials, provider]);

  /**
   * Ask the selected connection's own endpoint what models it has. Nothing in this app used
   * to do this, which is why an endpoint agent's model was a bare text field you had to get
   * exactly right from memory. Best-effort on purpose: the field below stays free text, and
   * a failure is reported as "couldn't ask", never as "this endpoint has no models".
   *
   * `cancelled` guards the usual out-of-order case - switching connections faster than a slow
   * endpoint answers would otherwise show the previous connection's models under the new one.
   */
  useEffect(() => {
    setDiscovered(null);
    if (!isEndpointProvider(provider) || !credentialId || credentialId === NEW_KEY_VALUE) {
      setDiscoveryState("idle");
      return;
    }
    let cancelled = false;
    setDiscoveryState("loading");
    fetchDiscoveredModels(credentialId)
      .then((result) => {
        if (cancelled) return;
        setDiscovered(result);
        setDiscoveryState("idle");
      })
      .catch(() => {
        if (!cancelled) setDiscoveryState("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [provider, credentialId]);

  const isCreatingNew = selected === NEW_PROJECT_VALUE;
  const isCreatingNewKey = credentialId === NEW_KEY_VALUE;
  /** A custom connection is identified by the service it points at, not by "custom" - several
   * saved custom keys would otherwise be indistinguishable in this dropdown. */
  const credentialOptionLabel = (c: CredentialMeta) =>
    isEndpointProvider(c.provider) ? (c.connectionName || c.baseUrl || "custom endpoint") : c.label;

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

    if (isEndpointProvider(provider) && !model.trim()) {
      setError("Enter the model id this endpoint expects - there's no default to fall back to");
      return;
    }

    let finalCredentialId: string | undefined;
    if (authMode === "api-key") {
      if (isEndpointProvider(provider) && !credentialId) {
        setError("Add this endpoint under Connections in the sidebar first");
        return;
      }
      if (isCreatingNewKey) {
        if (!newKeyValue.trim()) {
          setError("Paste an API key first");
          return;
        }
        // saveCredential() throws on a non-OK response (a behavior change from earlier this
        // session) - this call was never updated to expect that, so a failed save (bad key
        // format, server error) used to become an unhandled rejection with no feedback and
        // the modal stuck showing nothing happened.
        try {
          const saved = await saveCredential(provider, newKeyLabel.trim() || "unlabeled", newKeyValue.trim());
          finalCredentialId = saved.id;
        } catch (err) {
          setError((err as Error).message || "Failed to save the API key");
          return;
        }
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

        {API_KEY_CAPABLE.includes(provider) && !API_KEY_ONLY.includes(provider) && (
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
                {isEndpointProvider(provider) && providerCredentials.length === 0 && <option value="">No connections saved yet</option>}
                {providerCredentials.map((c) => (
                  <option key={c.id} value={c.id}>
                    {credentialOptionLabel(c)}
                  </option>
                ))}
                {/* A custom endpoint needs a base URL as well as a key, so it's added in the
                    sidebar's Connections panel rather than inline here. */}
                {!isEndpointProvider(provider) && <option value={NEW_KEY_VALUE}>+ Add a new key…</option>}
              </select>
            </label>
            {isEndpointProvider(provider) && (
              <div className="field-note">
                Custom endpoints are added under <strong>Connections</strong> in the sidebar (name + base URL + key).
              </div>
            )}
            {!isEndpointProvider(provider) && isCreatingNewKey && (
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

        {/* Still free text, never a closed <select>: the suggestions below come from the
            endpoint's own /models and can be missing, stale by a minute, or unavailable
            entirely, so the user must always be able to type a model this list doesn't have. */}
        {isEndpointProvider(provider) && (
          <label>
            Model id
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="deepseek-chat"
              spellCheck={false}
              list={discovered ? "discovered-models" : undefined}
            />
            {discovered && (
              <datalist id="discovered-models">
                {discovered.models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            )}
          </label>
        )}
        {isEndpointProvider(provider) && (
          <div className="field-note">
            {discoveryState === "loading" && "Asking this connection which models it has…"}
            {discoveryState === "failed" &&
              "Couldn't ask this connection for its model list - type the model id yourself. (That the list is unavailable says nothing about which models the endpoint has.)"}
            {discovered &&
              `${discovered.models.length} model${discovered.models.length === 1 ? "" : "s"} reported by this endpoint at ${new Date(discovered.fetchedAt).toLocaleTimeString()}.`}
          </div>
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

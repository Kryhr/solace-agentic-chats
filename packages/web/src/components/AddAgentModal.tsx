import { useEffect, useState } from "react";
import type {
  AgentConfig,
  ApiKeyCredentialMeta,
  CredentialMeta,
  ModelDiscoveryResult,
  ProviderId,
  ProviderModelInfo,
  ProviderPermissionInfo,
  TrustLevel,
} from "@solace/shared";
import {
  createProject,
  fetchAccounts,
  fetchConnectedClis,
  fetchCredentials,
  fetchDiscoveredModels,
  fetchProjects,
  saveCredential,
  type AccountIdentity,
  type ProjectInfo,
} from "../api";
import { effortOptionsFor, initialModelFor } from "../lib/modelOptions";
import { ModelPicker, ModelSourceNote } from "./ModelPicker";
import { permissionOptionsFor, TRUST_LABELS } from "../lib/permissionOptions";
import { providerLabel } from "./ProviderIcon";

/**
 * The order providers are offered in - NOT the list. What is actually offered is whatever the
 * user has CONNECTED, computed below: a CLI they connected under Connections, or a saved
 * endpoint credential for "custom"/"local". An agent can only run against something that is
 * set up, so offering thirteen providers when three are usable meant ten choices that end in a
 * failed turn. This array only decides what comes first among the ones that survive.
 */
const PROVIDER_ORDER: ProviderId[] = ["claude-code", "codex-cli", "gemini-cli", "qwen-code", "copilot-cli", "opencode", "crush", "continue", "droid", "kilo", "kimi", "custom", "local"];

/**
 * How one login is named in the picker.
 *
 * The email and plan come from the CLI's own `auth status` output, never from anything this app
 * inferred - which is the point: "claude-code" twice tells the user nothing, and
 * "andr3w244@gmail.com - max" tells them exactly which subscription the agent will spend.
 * A signed-out slot says so rather than looking like a usable choice.
 */
function accountOptionLabel(a: AccountIdentity): string {
  const who = a.email ?? (a.label ? a.label : "default login");
  // Kimi and Qwen cannot be asked who they are without spending a turn, so their slots are named
  // by label alone. Falling through to "not signed in" would libel a perfectly good login.
  if (a.identityUnknown) return a.label ?? "default login";
  if (!a.loggedIn) return `${a.label ?? "default"} - not signed in`;
  const plan = a.subscriptionType ? ` - ${a.subscriptionType}` : "";
  return a.label ? `${who}${plan} (${a.label})` : `${who}${plan}`;
}

const NEW_PROJECT_VALUE = "__new__";
/** "Give it its own folder, named after the handle" - the default, so adding an agent never
 * requires answering a question about projects. */
const OWN_FOLDER_VALUE = "__own__";
const NEW_KEY_VALUE = "__new__";
// Mirrors adapters/index.ts's apiAdapters map - only these providers have a direct-API
// alternative to the CLI/subscription path today. "custom" and "local" are connection-only:
// there's no CLI to shell out to for an arbitrary OpenAI-compatible endpoint.
/**
 * Only these are API-key backed, and they are exactly the connection kinds that have no CLI:
 * an arbitrary OpenAI-compatible endpoint, hosted or local.
 *
 * A CLI provider is NEVER asked for a key. Every coding-agent CLI in the list owns its own
 * sign-in - you authenticate it once in the terminal, against your subscription, and this app
 * shells out to that. Offering "API key" as an alternative
 * sign-in method for those blurred two genuinely different things together: a CLI you have
 * logged in, and a raw API endpoint you pay per token for. The app already has a separate
 * connection type for the second one.
 *
 * NOTE: adapters/claude-api.ts and openai-api.ts still exist and still work. They are simply
 * no longer reachable by giving a CLI agent a key, because that was the confusing route. If
 * key-backed Claude or OpenAI should be offered, it belongs under Hosted API endpoint as its
 * own connection - Anthropic's wire format is not OpenAI-shaped, so the generic endpoint path
 * cannot serve it without that work.
 */
const API_KEY_ONLY: ProviderId[] = ["custom", "local"];

/** Providers whose agent is backed by a saved connection (base URL + optional key) rather
 * than a CLI login - they share every special case in this modal. */
function isEndpointProvider(provider: ProviderId): boolean {
  return provider === "custom" || provider === "local";
}

export function AddAgentModal({
  modelCatalog,
  permissionCatalog,
  defaultProjectPath,
  defaultTrustLevel,
  onClose,
  onCreate,
}: {
  modelCatalog: ProviderModelInfo[];
  permissionCatalog: ProviderPermissionInfo[];
  /** The path of the project the sidebar is scoped to, so a new agent lands in it by default. */
  defaultProjectPath?: string;
  /** The app setting "Trust level a new agent starts on" - which option this form preselects.
   * A preference, not a cap: the dropdown below still offers every level the chosen provider
   * supports, and a provider that does not support this one falls back to its own first. */
  defaultTrustLevel: TrustLevel;
  onClose: () => void;
  onCreate: (config: Omit<AgentConfig, "id">) => void;
}) {
  const [handle, setHandle] = useState("");
  /** null while the connected list is still being fetched, so the form does not flash a
   * "nothing connected" state at a user who has plenty connected. */
  const [connectedClis, setConnectedClis] = useState<ProviderId[] | null>(null);
  const [provider, setProvider] = useState<ProviderId>("claude-code");
  /** Logins available for the chosen provider. Empty when it can only hold one. */
  const [accounts, setAccounts] = useState<AccountIdentity[]>([]);
  /** "" means the CLI's own default login - the normal case, and the default here. */
  const [account, setAccount] = useState<string>("");
  const [trustLevel, setTrustLevel] = useState<TrustLevel>(defaultTrustLevel);
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
  // Effort is looked up for the model actually chosen: Codex states its levels per model and
  // they genuinely differ between them, so a provider-wide list would offer one that fails.
  const effortOptions = effortOptionsFor(info, model);
  const permissionInfo = permissionCatalog.find((p) => p.provider === provider);
  const trustOptions = permissionOptionsFor(permissionInfo);
  // The vault holds deploy targets, logins and free-form secrets too, none of which can back
  // an agent's sign-in. Matched as an allowlist on "api-key" rather than excluding "ssh":
  // the exclusion silently stopped covering everything the moment other kinds existed, and a
  // saved password would have appeared here as a selectable API credential.
  const providerCredentials = credentials.filter(
    (c): c is ApiKeyCredentialMeta => c.kind === "api-key" && c.provider === provider,
  );

  /**
   * What this user can actually point an agent at.
   *
   * A CLI qualifies when it is in the connected list - installed is not connected, and the
   * Connections panel already draws that line. "custom" and "local" qualify when a saved
   * api-key credential exists for them, because for an endpoint the saved connection IS the
   * setup. Anything else is a provider that would spawn, fail, and leave the user to work out
   * why from a CLI error.
   */
  const availableProviders = PROVIDER_ORDER.filter((p) => {
    if (p === "custom" || p === "local") {
      return credentials.some((c) => c.kind === "api-key" && c.provider === p);
    }
    return (connectedClis ?? []).includes(p);
  });
  const stillLoading = connectedClis === null;

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
      // Only preselect a project when the sidebar is actually scoped to one - then the agent
      // lands where the user is already working. Scoped to "All projects" there is nothing to
      // inherit, so fall through to the agent's own folder rather than silently filing it
      // under whichever project happens to sort first.
      const preferred = defaultProjectPath && projects.find((p) => p.path === defaultProjectPath);
      setSelected(preferred ? preferred.path : OWN_FOLDER_VALUE);
    });
    fetchCredentials().then(setCredentials);
    // Failing closed (an empty list) rather than open: if this cannot be read, offering every
    // provider would be guessing that they all work.
    fetchConnectedClis().then(({ connected }) => setConnectedClis(connected)).catch(() => setConnectedClis([]));
  }, []);

  // The default "claude-code" is a guess made before the connected list arrives. Once it does,
  // snap to the first provider that is really available - otherwise the form opens pointed at a
  // provider that is not in its own dropdown, and Add would submit it anyway.
  useEffect(() => {
    if (stillLoading) return;
    if (availableProviders.length > 0 && !availableProviders.includes(provider)) {
      setProvider(availableProviders[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stillLoading, availableProviders.join(",")]);

  // Whenever the provider changes, snap model/effort/trust to that provider's own real options.
  useEffect(() => {
    setModel(initialModelFor(info));
    setEffort(effortOptionsFor(info, initialModelFor(info))[0] ?? "");
    // The configured default when this provider actually offers it, otherwise that provider's
    // own first option - never a level its CLI would reject, and never a silently higher one.
    setTrustLevel(trustOptions.includes(defaultTrustLevel) ? defaultTrustLevel : (trustOptions[0] ?? defaultTrustLevel));
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
    // Which logins this provider has. Reset to the default first: an account label belongs to
    // one provider, and carrying "second" across to a provider that has never heard of it would
    // silently point the new agent at a directory that is not its own.
    setAccount("");
    setAccounts([]);
    fetchAccounts(provider)
      .then((r) => setAccounts(r.supported ? r.accounts : []))
      .catch(() => setAccounts([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  // Effort levels are per-model for Codex, so switching model can strand the chosen effort on
  // a level this model doesn't accept - which the CLI would only reject mid-turn. Snap to a
  // level the selected model actually declares instead of passing on a value we know is wrong.
  useEffect(() => {
    if (effort && !effortOptions.includes(effort)) setEffort(effortOptions[0] ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

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
  const usingOwnFolder = selected === OWN_FOLDER_VALUE;
  const isCreatingNewKey = credentialId === NEW_KEY_VALUE;
  /** A custom connection is identified by the service it points at, not by "custom" - several
   * saved custom keys would otherwise be indistinguishable in this dropdown. */
  const credentialOptionLabel = (c: ApiKeyCredentialMeta) =>
    isEndpointProvider(c.provider) ? (c.connectionName || c.baseUrl || "custom endpoint") : c.label;

  const handleAdd = async () => {
    setError(null);
    let cwd = selected;
    // "Its own folder" creates one named after the handle. Deliberately NOT the workspace root
    // itself: the credentials file and app state live there, and an agent on bypassPermissions
    // pointed at the root could read both.
    if (usingOwnFolder) {
      try {
        setCreatingProject(true);
        const existing = projects.find((p) => p.name.toLowerCase() === handle.toLowerCase());
        cwd = existing ? existing.path : (await createProject(handle)).path;
      } catch (err) {
        setError((err as Error).message);
        setCreatingProject(false);
        return;
      }
      setCreatingProject(false);
    }
    if (isCreatingNew) {
      if (!newProjectName.trim()) {
        setError("Give the new folder a name first");
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

    if (!model.trim()) {
      // Asked for rather than filled in: see initialModelFor. Now that the list is the whole
      // set of models the installed CLI knows, quietly defaulting to whichever happened to be
      // first would be choosing for the user with no basis.
      setError(
        isEndpointProvider(provider)
          ? "Enter the model id this endpoint expects - there's no default to fall back to"
          : "Choose a model for this agent",
      );
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
      account: account || undefined,
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
          {/* Capitalised as it is typed so what the user sees is what gets saved - the server
              capitalises on the way in regardless (validateAgentConfig.ts), and a field that
              silently differs from the stored value is its own small lie. Only the first
              character, and only while it is a lowercase letter, so the caret never jumps. */}
          <input
            value={handle}
            onChange={(e) => {
              const v = e.target.value;
              setHandle(v && v[0] >= "a" && v[0] <= "z" ? v[0].toUpperCase() + v.slice(1) : v);
            }}
            placeholder="Claude-1"
          />
        </label>
        <label>
          Provider
          <select
            className="select"
            value={provider}
            onChange={(e) => setProvider(e.target.value as ProviderId)}
            disabled={stillLoading || availableProviders.length === 0}
          >
            {stillLoading && <option value={provider}>Loading your connections…</option>}
            {!stillLoading && availableProviders.length === 0 && <option value={provider}>No connections yet</option>}
            {!stillLoading &&
              availableProviders.map((p) => (
                <option key={p} value={p}>
                  {providerLabel(p)}
                </option>
              ))}
          </select>
        </label>
        {/* Only when the provider genuinely supports more than one login, and only when more than
            one exists - a picker with a single entry is a control that cannot do anything.
            Each option is identified by WHO it is (the email and plan the CLI itself reported),
            because two agents both saying "claude-code" is exactly the confusion this solves. */}
        {accounts.length > 1 && (
          <label>
            Account
            <select className="select" value={account} onChange={(e) => setAccount(e.target.value)}>
              {accounts.map((a) => (
                <option key={a.label ?? ""} value={a.label ?? ""}>
                  {accountOptionLabel(a)}
                </option>
              ))}
            </select>
          </label>
        )}

        {/* Said plainly rather than shown as an empty dropdown, and it names the way out. An
            agent needs something to run against; this is the one case where the form genuinely
            cannot be completed. */}
        {!stillLoading && availableProviders.length === 0 && (
          <p className="field-note">
            Nothing is connected yet, so there is nothing for an agent to run on. Add a coding agent CLI, a local model
            server or a hosted endpoint under <strong>Connections</strong> first.
          </p>
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
        {!isEndpointProvider(provider) && (
          <>
            <ModelPicker info={info} value={model} onChange={setModel} />
            <ModelSourceNote info={info} />
          </>
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
          Working folder
          <select className="select" value={selected} onChange={(e) => setSelected(e.target.value)}>
            {/* An agent has to run somewhere, but "which project does it belong to" is a
                question most people do not have an answer to - especially when the chat they
                want it in is not filed under a project either. Its own folder is the honest
                default: it still gets a real cwd, and nothing has to be decided. */}
            <option value={OWN_FOLDER_VALUE}>Its own folder{handle ? ` (${handle})` : ""}</option>
            {projects.map((p) => (
              <option key={p.path} value={p.path}>
                {p.name}
              </option>
            ))}
            <option value={NEW_PROJECT_VALUE}>+ New folder…</option>
          </select>
        </label>
        {isCreatingNew && (
          <label>
            New folder name
            <input
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              placeholder="my-new-app"
              autoFocus
            />
          </label>
        )}
        <div className="field-note">
          Where this agent's CLI actually runs, under <code>{workspaceRoot}</code>. It does not
          limit which chats it can join - only a chat filed under a project is restricted, and
          then to agents working inside that project's folder.
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
          <button
            className="btn-primary"
            disabled={!handle || creatingProject || stillLoading || availableProviders.length === 0}
            onClick={handleAdd}
          >
            {creatingProject ? "Creating…" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}

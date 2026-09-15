import { useEffect, useState } from "react";
import type { CredentialMeta, ProviderId, ProviderStatus, SshCredentialMeta } from "@solace/shared";
import {
  deleteCredential,
  fetchCredentials,
  fetchProviderStatuses,
  saveCredential,
  saveSshCredential,
  testProviderConnection,
  type SshCredentialDraft,
} from "../api";
import { ProviderIcon, providerLabel } from "./ProviderIcon";
import { searchCatalog, type CatalogProvider } from "../lib/providerCatalog";

type TestResult = { ok: boolean; message: string } | { pending: true };

/** Mirrors the real row's shape (glyph + one line of text) rather than a spinner. */
function SkeletonRows() {
  return (
    <div className="connection-list" aria-hidden="true">
      {[52, 64, 46, 58].map((w, i) => (
        <div className="skeleton-row" key={i}>
          <span className="skeleton skeleton-glyph" />
          <span className="skeleton skeleton-line" style={{ width: `${w}%` }} />
        </div>
      ))}
    </div>
  );
}

/** What a saved credential should be called in a list: its own connection name for custom
 * endpoints (that's the only thing distinguishing several "custom" keys from each other),
 * otherwise the provider it belongs to. The label ("personal", "work") is the secondary line. */
export function credentialTitle(c: CredentialMeta): string {
  if (c.kind === "ssh") return c.label;
  if (c.provider === "custom") return c.connectionName || c.baseUrl || "Custom endpoint";
  return providerLabel(c.provider);
}

/** user@host:port - the whole point of an SSH row. Never includes a key path or any secret;
 * the key path is its own, quieter line so it can't be mistaken for part of the address. */
function sshAddress(c: SshCredentialMeta): string {
  return `${c.ssh.username}@${c.ssh.host}:${c.ssh.port}`;
}

const EMPTY_SSH_DRAFT: SshCredentialDraft = { label: "", host: "", username: "", port: 22, privateKeyPath: "" };

/** Saved SSH deploy targets. Deliberately stores a *reference* to a key file the user already
 * has (with the permissions they already set on it) rather than a second copy of their private
 * key inside Solace's own plaintext JSON. Pasting key material is possible but has to be opened
 * explicitly, and is labelled as the weaker option, because it is. */
function SshConnections({
  targets,
  onSaved,
  onDelete,
}: {
  targets: SshCredentialMeta[];
  onSaved: (c: CredentialMeta) => void;
  onDelete: (id: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<SshCredentialDraft>(EMPTY_SSH_DRAFT);
  const [pasteKey, setPasteKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setAdding(false);
    setDraft(EMPTY_SSH_DRAFT);
    setPasteKey(false);
    setError(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = await saveSshCredential({
        ...draft,
        // Whichever input the user didn't use is dropped rather than sent empty, so the server
        // sees exactly one of "path" or "material" and can't guess wrong about which they meant.
        privateKeyPath: pasteKey ? undefined : draft.privateKeyPath,
        privateKey: pasteKey ? draft.privateKey : undefined,
      });
      onSaved(saved);
      reset();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="connection-subhead">
        Deploy targets (SSH)
        <span className="label-rule" />
      </div>

      {targets.length === 0 && !adding && <div className="provider-hint connection-empty">No SSH targets yet.</div>}

      {targets.map((c) => (
        <div key={c.id} className="provider-row credential-row is-ssh">
          <span className="provider-glyph ssh-glyph" aria-hidden="true">
            SSH
          </span>
          <span className="provider-name">
            {sshAddress(c)}
            <span className="credential-sub" title={c.ssh.privateKeyPath ?? undefined}>
              {c.ssh.privateKeyPath ?? "key stored in Solace (no file path)"}
            </span>
          </span>
          <span className="provider-actions">
            <button
              className="btn-ghost btn-xs"
              onClick={() => onDelete(c.id)}
              title="Forget this deploy target (nothing on the server or on disk is touched)"
            >
              Delete
            </button>
          </span>
        </div>
      ))}

      {!adding && (
        <button className="btn-ghost btn-xs add-connection" onClick={() => setAdding(true)}>
          + Add deploy target
        </button>
      )}

      {adding && (
        <div className="connection-add">
          <label className="connection-field">
            Name
            <input
              value={draft.label}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
              placeholder="prod-web"
              autoFocus
            />
          </label>
          <label className="connection-field">
            Host
            <input
              value={draft.host}
              onChange={(e) => setDraft({ ...draft, host: e.target.value })}
              placeholder="203.0.113.10 or deploy.example.com"
              spellCheck={false}
            />
          </label>
          <label className="connection-field">
            User
            <input
              value={draft.username}
              onChange={(e) => setDraft({ ...draft, username: e.target.value })}
              placeholder="deploy"
              spellCheck={false}
            />
          </label>
          <label className="connection-field">
            Port
            <input
              value={String(draft.port)}
              onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) || 0 })}
              inputMode="numeric"
              spellCheck={false}
            />
          </label>

          {!pasteKey ? (
            <label className="connection-field">
              Private key path
              <input
                value={draft.privateKeyPath ?? ""}
                onChange={(e) => setDraft({ ...draft, privateKeyPath: e.target.value })}
                placeholder="C:\Users\you\.ssh\id_ed25519"
                spellCheck={false}
              />
            </label>
          ) : (
            <label className="connection-field">
              Private key material
              <textarea
                className="ssh-key-input"
                value={draft.privateKey ?? ""}
                onChange={(e) => setDraft({ ...draft, privateKey: e.target.value })}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                spellCheck={false}
                autoComplete="off"
                rows={4}
              />
            </label>
          )}

          <label className="connection-field">
            known_hosts path (optional)
            <input
              value={draft.knownHostsPath ?? ""}
              onChange={(e) => setDraft({ ...draft, knownHostsPath: e.target.value })}
              placeholder="C:\Users\you\.ssh\known_hosts"
              spellCheck={false}
            />
          </label>

          <div className="provider-hint">
            {pasteKey
              ? "Pasting stores a second copy of your private key in Solace's own local file. Pointing at a key file instead is safer - that file already has the permissions you set on it."
              : "Solace stores the path only, never the key itself. The path must already exist on this machine."}{" "}
            <button className="btn-ghost btn-xs ssh-mode-toggle" onClick={() => setPasteKey((p) => !p)}>
              {pasteKey ? "Use a key file instead" : "Paste key material instead"}
            </button>
          </div>

          {error && (
            <div className="field-error" role="alert">
              {error}
            </div>
          )}
          <div className="connection-add-actions">
            <button className="btn-ghost btn-xs" onClick={reset}>
              Cancel
            </button>
            <button className="btn-primary btn-xs" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/** Saved API-key connections. Separate from the CLI providers above it: those are "is this
 * machine signed in", these are keys the user pasted and can add/remove at will - previously
 * only reachable mid-way through Add Agent, with no way to just manage them. */
export function SavedConnections() {
  const [credentials, setCredentials] = useState<CredentialMeta[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  /** null = still picking from the catalog; otherwise the chosen target's name + base URL
   * (pre-filled from a tile, or blank for the free-text "+ Custom" path). */
  const [draft, setDraft] = useState<{ name: string; baseUrl: string; fromCatalog: boolean } | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchCredentials()
      .then(setCredentials)
      .catch(() => setCredentials([]));
  }, []);

  const reset = () => {
    setAdding(false);
    setDraft(null);
    setQuery("");
    setApiKey("");
    setError(null);
  };

  const pick = (p: CatalogProvider) => setDraft({ name: p.name, baseUrl: p.baseUrl, fromCatalog: true });

  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim() || !draft.baseUrl.trim()) {
      setError("Name and base URL are both required");
      return;
    }
    if (!apiKey.trim()) {
      setError("Paste an API key first");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await saveCredential("custom", draft.name.trim(), apiKey.trim(), draft.baseUrl.trim(), draft.name.trim());
      setCredentials((c) => [...(c ?? []), saved]);
      reset();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    await deleteCredential(id);
    setCredentials((c) => (c ?? []).filter((x) => x.id !== id));
  };

  const matches = searchCatalog(query);
  // Legacy records arrive without `kind`; the server normalises those to "api-key" before
  // they get here, so anything that isn't explicitly "ssh" belongs in the API-key list.
  const apiKeys = (credentials ?? []).filter((c): c is Exclude<CredentialMeta, SshCredentialMeta> => c.kind !== "ssh");
  const sshTargets = (credentials ?? []).filter((c): c is SshCredentialMeta => c.kind === "ssh");

  return (
    <div className="saved-connections">
      <div className="connection-subhead">
        API keys
        <span className="label-rule" />
      </div>

      {credentials !== null && apiKeys.length === 0 && !adding && (
        <div className="provider-hint connection-empty">No saved API keys yet.</div>
      )}

      {apiKeys.map((c) => (
        <div key={c.id} className="provider-row credential-row">
          <span className="provider-glyph">
            <ProviderIcon provider={c.provider} size={20} />
          </span>
          <span className="provider-name">
            {credentialTitle(c)}
            <span className="credential-sub">{c.provider === "custom" ? c.baseUrl : c.label}</span>
          </span>
          <span className="provider-actions">
            <button
              className="btn-ghost btn-xs"
              onClick={() => remove(c.id)}
              title={
                c.provider === "custom"
                  ? "Delete this saved key (agents using it will error on their next message - there's no CLI sign-in to fall back to)"
                  : "Delete this saved key (agents using it fall back to CLI sign-in)"
              }
            >
              Delete
            </button>
          </span>
        </div>
      ))}

      {!adding && (
        <button className="btn-ghost btn-xs add-connection" onClick={() => setAdding(true)}>
          + Add connection
        </button>
      )}

      {adding && !draft && (
        <div className="connection-add">
          <input
            className="connection-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search providers…"
            autoFocus
            aria-label="Search providers"
          />
          <div className="catalog-grid">
            {matches.map((p) => (
              <button key={p.name} className="catalog-tile" onClick={() => pick(p)} title={`${p.baseUrl} · key from ${p.keyHint}`}>
                <span className="catalog-tile-name">{p.name}</span>
                <span className="catalog-tile-hint">{p.keyHint}</span>
              </button>
            ))}
            <button className="catalog-tile is-custom" onClick={() => setDraft({ name: "", baseUrl: "", fromCatalog: false })}>
              <span className="catalog-tile-name">+ Custom</span>
              <span className="catalog-tile-hint">any OpenAI-compatible URL</span>
            </button>
          </div>
          {matches.length === 0 && (
            <div className="provider-hint">No match - use “+ Custom” for any other OpenAI-compatible endpoint.</div>
          )}
          <div className="connection-add-actions">
            <button className="btn-ghost btn-xs" onClick={reset}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {adding && draft && (
        <div className="connection-add">
          <label className="connection-field">
            Name
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="DeepSeek"
              autoFocus={!draft.fromCatalog}
            />
          </label>
          <label className="connection-field">
            Base URL
            <input
              value={draft.baseUrl}
              onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
              placeholder="https://api.example.com/v1"
              spellCheck={false}
            />
          </label>
          <label className="connection-field">
            API key
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-…"
              autoComplete="off"
              autoFocus={draft.fromCatalog}
            />
          </label>
          <div className="provider-hint">
            Stored locally on this machine only, never shown again after saving. Turns are billed by that provider; Solace
            reports whatever token counts the endpoint returns and never estimates a cost for it.
          </div>
          {error && (
            <div className="field-error" role="alert">
              {error}
            </div>
          )}
          <div className="connection-add-actions">
            <button className="btn-ghost btn-xs" onClick={reset}>
              Cancel
            </button>
            <button className="btn-primary btn-xs" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}

      {credentials !== null && (
        <SshConnections
          targets={sshTargets}
          onSaved={(saved) => setCredentials((c) => [...(c ?? []), saved])}
          onDelete={remove}
        />
      )}
    </div>
  );
}

export function ProvidersPanel() {
  const [statuses, setStatuses] = useState<ProviderStatus[] | null>(null);
  const [results, setResults] = useState<Record<string, TestResult>>({});

  useEffect(() => {
    fetchProviderStatuses()
      .then(setStatuses)
      .catch(() => setStatuses([]));
  }, []);

  const runTest = async (provider: ProviderId) => {
    setResults((r) => ({ ...r, [provider]: { pending: true } }));
    const result = await testProviderConnection(provider);
    setResults((r) => ({ ...r, [provider]: result }));
  };

  if (statuses === null) return <SkeletonRows />;

  return (
    <>
      {statuses.map((s) => {
        const result = results[s.provider];
        const pending = result !== undefined && "pending" in result;
        // The dot reflects whether we've actually proven a connection works, never just
        // "the CLI binary exists" - that distinction was confusing before this fix.
        const dotState = pending ? "pending" : !result ? "unknown" : "ok" in result && result.ok ? "ok" : "fail";
        const statusText = !s.installed
          ? "Not installed"
          : pending
            ? "Testing…"
            : result && "ok" in result
              ? result.ok
                ? "Connected"
                : "Failed"
              : "Installed";
        const tone = dotState === "ok" ? "is-ok" : dotState === "fail" ? "is-fail" : "";
        const detail = result && "ok" in result && !result.ok ? result.message : statusText;

        return (
          <div key={s.provider} className={`provider-row ${s.installed ? "is-testable" : ""}`}>
            <span className="provider-glyph">
              <ProviderIcon provider={s.provider} size={20} />
            </span>
            <span className="provider-name">{providerLabel(s.provider)}</span>

            <span className="provider-actions">
              <span className="provider-swap">
                <span className={`provider-status ${tone}`} title={detail}>
                  {statusText}
                </span>
                {s.installed && (
                  <button
                    className="btn-ghost btn-xs provider-test"
                    onClick={() => runTest(s.provider)}
                    disabled={pending}
                    title={`Run a real request against ${providerLabel(s.provider)}`}
                  >
                    {pending ? "Testing…" : "Test"}
                  </button>
                )}
              </span>
              <span className={`connection-dot ${dotState}`} title={detail} />
            </span>

            {!s.installed && <div className="provider-hint">{s.detail}</div>}
          </div>
        );
      })}
    </>
  );
}

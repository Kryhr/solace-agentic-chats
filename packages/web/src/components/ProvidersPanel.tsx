import { useEffect, useState } from "react";
import type {
  ApiKeyCredentialMeta,
  CatalogProvider,
  CredentialMeta,
  LocalServerFinding,
  LoginCredentialMeta,
  ProviderId,
  ProviderStatus,
  RevealedField,
  SecretCredentialMeta,
  SshCredentialMeta,
} from "@solace/shared";
import { searchCatalog } from "@solace/shared";
import {
  deleteCredential,
  fetchCredentials,
  fetchProviderStatuses,
  revealCredential,
  saveCredential,
  saveLoginCredential,
  saveSecretCredential,
  saveSshCredential,
  scanLocalServers,
  testProviderConnection,
  type LoginCredentialDraft,
  type SecretCredentialDraft,
  type SshCredentialDraft,
} from "../api";
import { ProviderIcon, providerLabel } from "./ProviderIcon";

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
  if (c.kind === "ssh" || c.kind === "login" || c.kind === "secret") return c.label;
  if (isEndpointProvider(c.provider)) return c.connectionName || c.baseUrl || "Custom endpoint";
  return providerLabel(c.provider);
}

/** How long a revealed secret stays on screen before hiding itself again. A revealed value
 * left sitting in a sidebar is the accidental-exposure case this whole flow exists to avoid -
 * the user walks away, someone else looks at the screen, a screen share starts. Long enough
 * to read a password out or copy it, short enough that it isn't still there ten minutes later. */
const REVEAL_TIMEOUT_MS = 45_000;

/**
 * The per-entry reveal. Deliberately awkward in exactly one way: it does nothing until
 * pressed, and what it shows is gone again on hide, on timeout, or the moment this panel
 * unmounts (navigating away). The values live only in this component's state and are never
 * written into the credential list, so no list re-render can bring them back.
 *
 * One entry at a time is enforced by construction - each row owns its own instance and its
 * own fetch, and there is no route that returns more than one entry's secret anyway.
 */
function RevealSecret({ id, what }: { id: string; what: string }) {
  const [fields, setFields] = useState<RevealedField[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Hides itself again after a timeout, and - because the cleanup runs on unmount too - drops
  // the values when the user navigates away rather than leaving them in a mounted component.
  useEffect(() => {
    if (!fields) return;
    const timer = setTimeout(() => setFields(null), REVEAL_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [fields]);

  const show = async () => {
    setBusy(true);
    setError(null);
    try {
      const revealed = await revealCredential(id);
      setFields(revealed.fields);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copy = async (field: RevealedField) => {
    try {
      await navigator.clipboard.writeText(field.value);
      setCopied(field.name);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // A denied clipboard permission must not look like a successful copy - the user would
      // paste something stale and never know why.
      setError("This browser refused clipboard access - select the value and copy it manually.");
    }
  };

  if (!fields) {
    return (
      <>
        <button className="btn-ghost btn-xs" onClick={show} disabled={busy} title={`Show the stored ${what} for this entry`}>
          {busy ? "…" : "Reveal"}
        </button>
        {error && (
          <span className="field-error reveal-error" role="alert">
            {error}
          </span>
        )}
      </>
    );
  }

  // Built from <span>s rather than <div>s because this renders inside the row's own
  // <span className="provider-actions"> - a div there is invalid markup that the browser
  // silently restructures, which shows up later as React hydration/DOM mismatches. The
  // .reveal-* classes give these block layout.
  return (
    <span className="reveal-panel">
      {fields.length === 0 && <span className="provider-hint">Nothing is stored for this entry.</span>}
      {fields.map((f) => (
        <span className="reveal-field" key={f.name}>
          <span className="reveal-field-name">{f.name}</span>
          {/* A textarea, not a password input: key material is multi-line and the whole point
              of pressing Reveal is to actually read the thing. */}
          <textarea className="reveal-value" value={f.value} readOnly rows={f.value.includes("\n") ? 4 : 1} spellCheck={false} />
          {f.note && <span className="provider-hint reveal-note">{f.note}</span>}
          <button className="btn-ghost btn-xs" onClick={() => copy(f)}>
            {copied === f.name ? "Copied" : "Copy"}
          </button>
        </span>
      ))}
      <span className="reveal-actions">
        <span className="provider-hint">Hides itself in under a minute, and when you leave this panel.</span>
        <button className="btn-ghost btn-xs" onClick={() => setFields(null)}>
          Hide
        </button>
      </span>
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
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
              {/* Shown because until this line existed there was no way at all to tell that
                  Solace was holding the passphrase for the key file named right beside it. */}
              {c.ssh.hasPassphrase && " · passphrase stored here too"}
            </span>
            {c.notes && <span className="credential-sub credential-notes">{c.notes}</span>}
          </span>
          <span className="provider-actions">
            {(c.ssh.hasStoredKeyMaterial || c.ssh.hasPassphrase) && (
              <RevealSecret id={c.id} what="key material or passphrase" />
            )}
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

          <label className="connection-field">
            Key passphrase (optional)
            <input
              type="password"
              value={draft.passphrase ?? ""}
              onChange={(e) => setDraft({ ...draft, passphrase: e.target.value })}
              placeholder="leave blank if the key has none"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          {/* The API has accepted a passphrase since deploy targets existed, but no field ever
              sent one and nothing ever said it was kept - so a passphrase could sit in the
              plaintext file with the user unable to find that out. It is offered explicitly
              now, with what it actually costs stated next to it. */}
          {(draft.passphrase ?? "") !== "" && (
            <div className="provider-hint">
              Stored in Solace's own local file - the same file as the key path above it. Anyone who can read that file then
              has both the passphrase and the location of the key it unlocks. You can view it again later with Reveal, and
              remove it by deleting and re-adding this target.
            </div>
          )}

          <label className="connection-field">
            Notes (optional)
            <input
              value={draft.notes ?? ""}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
              placeholder="what this box is, who else has access…"
            />
          </label>
          <div className="provider-hint">Notes are shown in this list - keep secrets in the fields above, not here.</div>

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
  );}


const EMPTY_LOGIN_DRAFT: LoginCredentialDraft = { label: "", service: "", username: "", password: "", totpSecret: "", notes: "" };
const EMPTY_SECRET_DRAFT: SecretCredentialDraft = { label: "", value: "", notes: "" };

/**
 * Logins and free-form secrets - the two kinds that exist because "anything an agent needs
 * to sign into something later" is mostly neither an API key nor an SSH target. They share a
 * section because they are the same thing from the user's side: a labelled entry with a
 * secret in it that Reveal can show them again.
 */
function VaultEntries({
  logins,
  secrets,
  onSaved,
  onDelete,
}: {
  logins: LoginCredentialMeta[];
  secrets: SecretCredentialMeta[];
  onSaved: (c: CredentialMeta) => void;
  onDelete: (id: string) => void;
}) {
  /** null = not adding. Otherwise which form is open. */
  const [adding, setAdding] = useState<"login" | "secret" | null>(null);
  const [login, setLogin] = useState<LoginCredentialDraft>(EMPTY_LOGIN_DRAFT);
  const [secret, setSecret] = useState<SecretCredentialDraft>(EMPTY_SECRET_DRAFT);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setAdding(null);
    setLogin(EMPTY_LOGIN_DRAFT);
    setSecret(EMPTY_SECRET_DRAFT);
    setError(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      onSaved(adding === "login" ? await saveLoginCredential(login) : await saveSecretCredential(secret));
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
        Logins &amp; secrets
        <span className="label-rule" />
      </div>

      {logins.length === 0 && secrets.length === 0 && !adding && (
        <div className="provider-hint connection-empty">
          Nothing saved yet. Anything an agent might need to sign into something - a service password, a token, a recovery
          code - can live here, and you can read it back with Reveal.
        </div>
      )}

      {logins.map((c) => (
        <div key={c.id} className="provider-row credential-row is-vault">
          <span className="provider-glyph vault-glyph" aria-hidden="true">
            LOG
          </span>
          <span className="provider-name">
            {c.label}
            <span className="credential-sub" title={c.service}>
              {c.username} @ {c.service}
              {!c.hasPassword && " · no password stored"}
              {c.hasTotp && " · 2FA stored"}
            </span>
            {c.notes && <span className="credential-sub credential-notes">{c.notes}</span>}
          </span>
          <span className="provider-actions">
            {(c.hasPassword || c.hasTotp) && <RevealSecret id={c.id} what="password" />}
            <button className="btn-ghost btn-xs" onClick={() => onDelete(c.id)} title="Forget this login">
              Delete
            </button>
          </span>
        </div>
      ))}

      {secrets.map((c) => (
        <div key={c.id} className="provider-row credential-row is-vault">
          <span className="provider-glyph vault-glyph" aria-hidden="true">
            SEC
          </span>
          <span className="provider-name">
            {c.label}
            <span className="credential-sub">{c.hasValue ? "secret stored" : "empty"}</span>
            {c.notes && <span className="credential-sub credential-notes">{c.notes}</span>}
          </span>
          <span className="provider-actions">
            {c.hasValue && <RevealSecret id={c.id} what="secret" />}
            <button className="btn-ghost btn-xs" onClick={() => onDelete(c.id)} title="Forget this secret">
              Delete
            </button>
          </span>
        </div>
      ))}

      {!adding && (
        <div className="vault-add-row">
          <button className="btn-ghost btn-xs add-connection" onClick={() => setAdding("login")}>
            + Add login
          </button>
          <button className="btn-ghost btn-xs add-connection" onClick={() => setAdding("secret")}>
            + Add secret
          </button>
        </div>
      )}

      {adding === "login" && (
        <div className="connection-add">
          <label className="connection-field">
            Name
            <input
              value={login.label}
              onChange={(e) => setLogin({ ...login, label: e.target.value })}
              placeholder="grafana"
              autoFocus
            />
          </label>
          <label className="connection-field">
            Service or URL
            <input
              value={login.service}
              onChange={(e) => setLogin({ ...login, service: e.target.value })}
              placeholder="https://grafana.example.com"
              spellCheck={false}
            />
          </label>
          <label className="connection-field">
            Username
            <input
              value={login.username}
              onChange={(e) => setLogin({ ...login, username: e.target.value })}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="connection-field">
            Password
            <input
              type="password"
              value={login.password ?? ""}
              onChange={(e) => setLogin({ ...login, password: e.target.value })}
              autoComplete="new-password"
              spellCheck={false}
            />
          </label>
          <label className="connection-field">
            2FA seed or backup codes (optional)
            <textarea
              className="ssh-key-input"
              value={login.totpSecret ?? ""}
              onChange={(e) => setLogin({ ...login, totpSecret: e.target.value })}
              placeholder="otpauth://… or your backup codes"
              autoComplete="off"
              spellCheck={false}
              rows={3}
            />
          </label>
          {/* Said plainly rather than implied: keeping the second factor beside the first
              means this one file is enough to get in, which is a real trade the user should
              make on purpose. */}
          {(login.totpSecret ?? "") !== "" && (
            <div className="provider-hint">
              Storing the second factor next to the password means this one file is enough to sign in. Keep it elsewhere if
              that matters for this account.
            </div>
          )}
          <label className="connection-field">
            Notes (optional)
            <input
              value={login.notes ?? ""}
              onChange={(e) => setLogin({ ...login, notes: e.target.value })}
              placeholder="which account this is, what it's for…"
            />
          </label>
          <div className="provider-hint">
            Stored in Solace's own local file on this machine. Notes are shown in the list, so keep secrets in the fields
            above. You can read any of this back later with Reveal.
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

      {adding === "secret" && (
        <div className="connection-add">
          <label className="connection-field">
            Name
            <input
              value={secret.label}
              onChange={(e) => setSecret({ ...secret, label: e.target.value })}
              placeholder="stripe restricted key"
              autoFocus
            />
          </label>
          <label className="connection-field">
            Secret
            <textarea
              className="ssh-key-input"
              value={secret.value}
              onChange={(e) => setSecret({ ...secret, value: e.target.value })}
              placeholder="the token, code, or text to keep"
              autoComplete="off"
              spellCheck={false}
              rows={3}
            />
          </label>
          <label className="connection-field">
            Notes (optional)
            <input
              value={secret.notes ?? ""}
              onChange={(e) => setSecret({ ...secret, notes: e.target.value })}
              placeholder="what this unlocks, when it expires…"
            />
          </label>
          <div className="provider-hint">
            Stored in Solace's own local file on this machine. Notes are shown in the list, so keep the secret itself in the
            field above. An agent can ask for this by name, and you'll see a message in its hub when it does.
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

/** A connection is endpoint-backed (needs a base URL, may legitimately have no key) rather
 * than a bare key for one of the built-in CLI providers. */
function isEndpointProvider(provider: ProviderId): boolean {
  return provider === "custom" || provider === "local";
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
  const [draft, setDraft] = useState<{ name: string; baseUrl: string; fromCatalog: boolean; local: boolean } | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** null = never scanned this session. Deliberately not fetched on mount: see api.ts. */
  const [findings, setFindings] = useState<LocalServerFinding[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

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

  const pick = (p: CatalogProvider) =>
    setDraft({ name: p.name, baseUrl: p.baseUrl, fromCatalog: true, local: Boolean(p.local) });

  /** Pre-fills the form from a server the scan actually found, so the base URL is the one
   * that answered rather than a default port that happens to be in the catalog. */
  const useFinding = (f: LocalServerFinding) => {
    setAdding(true);
    setApiKey("");
    setDraft({ name: f.name, baseUrl: f.baseUrl, fromCatalog: true, local: true });
  };

  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim() || !draft.baseUrl.trim()) {
      setError("Name and base URL are both required");
      return;
    }
    // No key requirement. A local server normally has none, and several hosted gateways can
    // be reached keyless on a LAN too; the base URL above is the thing actually needed to
    // make a request at all, so that's what's enforced.
    setSaving(true);
    setError(null);
    try {
      const saved = await saveCredential(
        draft.local ? "local" : "custom",
        draft.name.trim(),
        apiKey.trim(),
        draft.baseUrl.trim(),
        draft.name.trim(),
      );
      setCredentials((c) => [...(c ?? []), saved]);
      reset();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const scan = async () => {
    setScanning(true);
    setScanError(null);
    try {
      setFindings(await scanLocalServers());
    } catch (err) {
      setScanError((err as Error).message);
    } finally {
      setScanning(false);
    }
  };

  const remove = async (id: string) => {
    await deleteCredential(id);
    setCredentials((c) => (c ?? []).filter((x) => x.id !== id));
  };

  const matches = searchCatalog(query);
  // Legacy records arrive without `kind`; the server normalises those to "api-key" before
  // they get here. Filtered as an allowlist rather than "not ssh" - the old exclusion would
  // have quietly dumped every login and free-form secret into the API-key list the moment
  // those kinds existed, and rendered them as providers.
  const apiKeys = (credentials ?? []).filter((c): c is ApiKeyCredentialMeta => c.kind === "api-key");
  const sshTargets = (credentials ?? []).filter((c): c is SshCredentialMeta => c.kind === "ssh");
  const logins = (credentials ?? []).filter((c): c is LoginCredentialMeta => c.kind === "login");
  const secrets = (credentials ?? []).filter((c): c is SecretCredentialMeta => c.kind === "secret");

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
            <span className="credential-sub">
              {isEndpointProvider(c.provider) ? c.baseUrl : c.label}
              {/* hasKey is absent on connections saved before keyless ones existed, all of
                  which did have a key - so only an explicit false means "no key". */}
              {c.hasKey === false && " · no key"}
            </span>
            {c.notes && <span className="credential-sub credential-notes">{c.notes}</span>}
          </span>
          <span className="provider-actions">
            {c.hasKey !== false && <RevealSecret id={c.id} what="API key" />}
            <button
              className="btn-ghost btn-xs"
              onClick={() => remove(c.id)}
              title={
                isEndpointProvider(c.provider)
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
              <button
                key={p.name}
                className={`catalog-tile ${p.local ? "is-local" : ""}`}
                onClick={() => pick(p)}
                title={p.keyHint ? `${p.baseUrl} · key from ${p.keyHint}` : `${p.baseUrl} · runs on this machine`}
              >
                <span className="catalog-tile-name">{p.name}</span>
                <span className="catalog-tile-hint">{p.keyHint ?? "on this machine · no key needed"}</span>
              </button>
            ))}
            <button
              className="catalog-tile is-custom"
              onClick={() => setDraft({ name: "", baseUrl: "", fromCatalog: false, local: false })}
            >
              <span className="catalog-tile-name">+ Custom</span>
              <span className="catalog-tile-hint">any OpenAI-compatible URL</span>
            </button>
          </div>
          {matches.length === 0 && (
            <div className="provider-hint">No match - use “+ Custom” for any other OpenAI-compatible endpoint.</div>
          )}

          <div className="connection-subhead">
            Local servers
            <span className="label-rule" />
          </div>
          <button className="btn-ghost btn-xs" onClick={scan} disabled={scanning}>
            {scanning ? "Scanning…" : "Scan for local servers"}
          </button>
          <div className="provider-hint">
            Checks this machine's own loopback ports for the default ports of Ollama, LM Studio, Jan, KoboldCpp and GPT4All,
            and only reports one when the reply actually identifies that runtime. llama.cpp, vLLM and LocalAI share ports
            with common non-LLM servers, so pick their tile above instead of scanning for them.
          </div>
          {scanError && (
            <div className="field-error" role="alert">
              {scanError}
            </div>
          )}
          {findings?.length === 0 && (
            <div className="provider-hint">
              Nothing answered on those ports just now. That isn't proof nothing is installed - a server on a non-default
              port is added with its tile above.
            </div>
          )}
          {findings?.map((f) => (
            <div key={`${f.runtime}-${f.baseUrl}`} className="provider-row">
              <span className="provider-glyph">
                <ProviderIcon provider="local" size={20} />
              </span>
              <span className="provider-name">
                {f.name}
                <span className="credential-sub">
                  {f.baseUrl}
                  {f.state === "authenticated" && " · wants an API key"}
                  {f.models?.length ? ` · ${f.models.length} model${f.models.length === 1 ? "" : "s"}` : ""}
                  {` · seen ${new Date(f.verifiedAt).toLocaleTimeString()}`}
                </span>
              </span>
              <span className="provider-actions">
                <button className="btn-ghost btn-xs" onClick={() => useFinding(f)}>
                  Add
                </button>
              </span>
            </div>
          ))}

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
            {draft.local ? "API key (leave blank - most local servers have none)" : "API key (optional)"}
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={draft.local ? "usually empty" : "sk-…"}
              autoComplete="off"
              autoFocus={draft.fromCatalog && !draft.local}
            />
          </label>
          <div className="provider-hint">
            {draft.local ? (
              <>
                Runs on this machine, so nothing is billed and no key is sent unless you enter one. Solace reports whatever
                token counts the server returns and never estimates a cost.
              </>
            ) : (
              <>
                Stored locally on this machine only, never shown again after saving. Turns are billed by that provider;
                Solace reports whatever token counts the endpoint returns and never estimates a cost for it.
              </>
            )}
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

      {credentials !== null && (
        <VaultEntries
          logins={logins}
          secrets={secrets}
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

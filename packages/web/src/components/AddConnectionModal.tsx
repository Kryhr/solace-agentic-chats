import { useState } from "react";
import type {
  CatalogProvider,
  ConnectionCheck,
  ConnectorKindId,
  CredentialMeta,
  GithubConnection,
  LocalServerFinding,
  ProviderId,
} from "@solace/shared";
import { CONNECTOR_KINDS, searchCatalog } from "@solace/shared";
import {
  saveCredential,
  saveLoginCredential,
  saveSecretCredential,
  saveSshCredential,
  scanLocalServers,
  type LoginCredentialDraft,
  type SecretCredentialDraft,
  type SshCredentialDraft,
} from "../api";
import { ProviderIcon } from "./ProviderIcon";
import { ConnectCliPanel } from "./ConnectCliPanel";
import type { ConnectableProvider } from "../api";

/**
 * The one way into every kind of connection this app can hold.
 *
 * Before this, "Add connection" lived inside the API-keys section and offered only endpoints,
 * which made the app look like a place to paste API keys - hiding the CLI agents that are the
 * whole point of it, and hiding GitHub entirely. So the first screen here is a chooser over
 * CONNECTOR_KINDS, and every kind is a peer of every other. A new connector type is a new
 * entry in that shared list plus a case below, not a redesign of this file.
 *
 * GitHub is deliberately *not* a form. It is a program the user installs and signs into
 * themselves, and pretending otherwise with a form that can only fail would be worse than
 * showing the real command.
 *
 * The CLI kind is the one that DOES do something here, and it lives in its own file - see
 * ConnectCliPanel. Connecting a CLI is a real, persisted opt-in gated on that CLI's own
 * --version having just passed; it is not the read-only "here is what is installed" report
 * that used to live in this file, and it is not the same claim as being signed in.
 */

/** A command the user is meant to run somewhere else. Shown as the literal text to copy, not
 * described in prose - "install the Claude Code CLI" is not something you can paste. */
function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Silently leaving it uncopied would be a lie; the text is selectable either way.
      setCopied(false);
    }
  };
  return (
    <div className="command-line">
      <code>{command}</code>
      <button className="btn-ghost btn-xs" onClick={copy} title="Copy this command">
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function ChooserRow({ id, onPick, count }: { id: ConnectorKindId; onPick: () => void; count: number }) {
  const kind = CONNECTOR_KINDS.find((k) => k.id === id)!;
  return (
    <button className="chooser-row" onClick={onPick}>
      <span className="chooser-row-head">
        <span className="chooser-row-title">{kind.title}</span>
        {count > 0 && <span className="chooser-row-count">{count} saved</span>}
      </span>
      <span className="chooser-row-blurb">{kind.blurb}</span>
      {/* Stated up front, on the chooser, so the user picks knowing what "connected" will be
          able to mean for this kind. */}
      <span className="chooser-row-check">Check: {kind.verification}</span>
    </button>
  );
}

const EMPTY_SSH_DRAFT: SshCredentialDraft = { label: "", host: "", username: "", port: 22, privateKeyPath: "" };
const EMPTY_LOGIN_DRAFT: LoginCredentialDraft = { label: "", service: "", username: "", password: "", totpSecret: "", notes: "" };
const EMPTY_SECRET_DRAFT: SecretCredentialDraft = { label: "", value: "", notes: "" };

export function AddConnectionModal({
  cliCatalog,
  connectedClis,
  onConnectedClisChange,
  github,
  credentials,
  onSaved,
  onClose,
}: {
  /** Every CLI that can be connected, with its real sign-in command. Comes from the server. */
  cliCatalog: ConnectableProvider[];
  /** The ones the user has actually connected - NOT the ones installed on this machine. */
  connectedClis: ProviderId[];
  /** `verified` carries the check that authorised a connection, so the sidebar's new row shows
   * that check rather than the older page-load snapshot. See ConnectCliPanel. */
  onConnectedClisChange: (next: ProviderId[], verified?: { provider: ProviderId; check: ConnectionCheck }) => void;
  github: GithubConnection | null;
  credentials: CredentialMeta[];
  onSaved: (c: CredentialMeta) => void;
  onClose: () => void;
}) {
  /** null = the chooser. Otherwise which kind's screen is open. */
  const [kind, setKind] = useState<ConnectorKindId | null>(null);

  const counts: Record<ConnectorKindId, number> = {
    // Connected, not installed. The count beside "Coding agent CLI" has to mean the same thing
    // the sidebar section under it means, or the chooser promises rows that aren't there.
    cli: connectedClis.length,
    github: github?.authenticated ? 1 : 0,
    "local-server": credentials.filter((c) => c.kind === "api-key" && c.provider === "local").length,
    "hosted-api": credentials.filter((c) => c.kind === "api-key" && c.provider !== "local").length,
    ssh: credentials.filter((c) => c.kind === "ssh").length,
    vault: credentials.filter((c) => c.kind === "login" || c.kind === "secret").length,
  };

  const title = kind ? CONNECTOR_KINDS.find((k) => k.id === kind)!.title : "Add connection";

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          {kind && (
            <button className="btn-ghost btn-xs" onClick={() => setKind(null)} aria-label="Back to all connection types">
              ← All types
            </button>
          )}
          <h3>{title}</h3>
        </div>

        {!kind && (
          <div className="chooser-list">
            {CONNECTOR_KINDS.map((k) => (
              <ChooserRow key={k.id} id={k.id} count={counts[k.id]} onPick={() => setKind(k.id)} />
            ))}
          </div>
        )}

        {kind === "cli" && (
          <ConnectCliPanel catalog={cliCatalog} connected={connectedClis} onConnectedChange={onConnectedClisChange} />
        )}
        {kind === "github" && <GithubGuide github={github} />}
        {(kind === "local-server" || kind === "hosted-api") && (
          <EndpointForm local={kind === "local-server"} onSaved={onSaved} onDone={onClose} />
        )}
        {kind === "ssh" && <SshForm onSaved={onSaved} onDone={onClose} />}
        {kind === "vault" && <VaultForm onSaved={onSaved} onDone={onClose} />}

        <div className="actions">
          <button className="btn-ghost btn-xs" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * GitHub, shown as what `gh` actually reports rather than as a capability list this app made
 * up. The raw `gh auth status` output is rendered verbatim (gh masks the token in it itself),
 * and the scopes line is the only honest answer to "what does this let agents do" - it is the
 * set of permissions GitHub actually granted this token.
 */
function GithubGuide({ github }: { github: GithubConnection | null }) {
  if (!github) return <div className="field-note">Asking gh…</div>;

  return (
    <div className="guide">
      {!github.installed && (
        <>
          <p className="field-note">
            The GitHub CLI isn't installed on this machine, so agents can't clone, push or open pull requests as you. This is a
            real missing piece, not an optional extra.
          </p>
          {github.fixCommand && <CommandLine command={github.fixCommand} />}
          <div className="field-note">{github.fixHint}</div>
        </>
      )}

      {github.installed && !github.authenticated && (
        <>
          <p className="field-note">{github.fixHint}</p>
          {github.fixCommand && <CommandLine command={github.fixCommand} />}
        </>
      )}

      {github.authenticated && (
        <>
          <p className="field-note">
            Signed in as <strong>{github.account}</strong>. Agents run <code>gh</code> as you, so anything this token is allowed
            to do, they can do.
          </p>
          {github.reportedAccount && github.reportedAccount !== github.account && (
            <div className="field-note">
              {/* gh caches the account name from when the token was stored and can report a
                  stale one after a rename. Shown rather than quietly resolved, because the
                  disagreement is itself information. */}
              gh's own status still says <code>{github.reportedAccount}</code>. GitHub reports the current login as{" "}
              <code>{github.account}</code> - gh caches that name from when the token was stored, so it can lag a rename.
            </div>
          )}
          {github.scopes && (
            <div className="field-note">
              Token scopes, exactly as gh listed them:{" "}
              {github.scopes.length
                ? // Separated explicitly. Adjacent <code> elements render with no gap at all,
                  // which turned "gist, read:org, repo" into the single meaningless token
                  // "gistread:orgrepo" - a list of permissions has to stay readable as a list.
                  github.scopes.map((s, i) => (
                    <span key={s}>
                      {i > 0 && ", "}
                      <code>{s}</code>
                    </span>
                  ))
                : "none"}
            </div>
          )}
        </>
      )}

      {github.statusText && (
        <>
          <div className="field-note">
            What <code>gh auth status</code> said, word for word:
          </div>
          <pre className="verbatim-output">{github.statusText}</pre>
        </>
      )}
      <div className="field-note">Checked {new Date(github.checkedAt).toLocaleTimeString()}.</div>
    </div>
  );
}

/**
 * Local model servers and hosted API endpoints share this form because from the save side
 * they are one thing: a base URL and an optional key. What differs is real - a local server
 * costs nothing and usually wants no key - so the two screens differ in what they offer
 * (a scan, versus the hosted catalogue) and in what they say about billing.
 */
function EndpointForm({ local, onSaved, onDone }: { local: boolean; onSaved: (c: CredentialMeta) => void; onDone: () => void }) {
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<{ name: string; baseUrl: string; fromCatalog: boolean; local: boolean } | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [findings, setFindings] = useState<LocalServerFinding[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  const matches = searchCatalog(query).filter((p) => Boolean(p.local) === local);

  const pick = (p: CatalogProvider) => setDraft({ name: p.name, baseUrl: p.baseUrl, fromCatalog: true, local: Boolean(p.local) });

  /** Pre-fills from a server the scan actually found, so the base URL is the one that
   * answered rather than a default port that happens to be in the catalog. */
  const useFinding = (f: LocalServerFinding) => {
    setApiKey("");
    setDraft({ name: f.name, baseUrl: f.baseUrl, fromCatalog: true, local: true });
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

  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim() || !draft.baseUrl.trim()) {
      setError("Name and base URL are both required");
      return;
    }
    // No key requirement. A local server normally has none, and several hosted gateways can
    // be reached keyless on a LAN too; the base URL is the thing actually needed to make a
    // request at all, so that's what's enforced.
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
      onSaved(saved);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (draft) {
    return (
      <div className="guide">
        <label className="connection-field">
          Name
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="DeepSeek" autoFocus={!draft.fromCatalog} />
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
        <div className="field-note">
          {draft.local
            ? "Runs on this machine, so nothing is billed and no key is sent unless you enter one. Solace reports whatever token counts the server returns and never estimates a cost."
            : "Stored locally on this machine only, never shown again after saving. Turns are billed by that provider; Solace reports whatever token counts the endpoint returns and never estimates a cost for it."}
        </div>
        <div className="field-note">
          Saving does not check it. Press Check on the row afterwards - that runs a real GET /models against this URL.
        </div>
        {error && (
          <div className="field-error" role="alert">
            {error}
          </div>
        )}
        <div className="connection-add-actions">
          <button className="btn-ghost btn-xs" onClick={() => setDraft(null)}>
            Back
          </button>
          <button className="btn-primary btn-xs" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="guide">
      {local && (
        <>
          <button className="btn-secondary btn-xs" onClick={scan} disabled={scanning}>
            {scanning ? "Scanning…" : "Scan this machine for running servers"}
          </button>
          <div className="field-note">
            Checks this machine's own loopback ports for the default ports of Ollama, LM Studio, Jan, KoboldCpp and GPT4All, and
            only reports one when the reply actually identifies that runtime. llama.cpp, vLLM and LocalAI share ports with common
            non-LLM servers, so pick their tile below instead of scanning for them.
          </div>
          {scanError && (
            <div className="field-error" role="alert">
              {scanError}
            </div>
          )}
          {findings?.length === 0 && (
            <div className="field-note">
              Nothing answered on those ports just now. That isn't proof nothing is installed - a server on a non-default port is
              added with its tile below.
            </div>
          )}
          {findings?.map((f) => (
            <div key={`${f.runtime}-${f.baseUrl}`} className="provider-row credential-row">
              <span className="provider-glyph">
                {/* The runtime the probe positively identified, so the row carries that
                    runtime's real mark rather than a generic local-machine glyph. */}
                <ProviderIcon provider="local" size={20} connectionName={f.name} />
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
        </>
      )}

      <input
        className="connection-search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={local ? "Search local runtimes…" : "Search providers…"}
        aria-label={local ? "Search local runtimes" : "Search providers"}
      />
      <div className="catalog-grid catalog-grid-roomy">
        {matches.map((p) => (
          <button
            key={p.name}
            className={`catalog-tile ${p.local ? "is-local" : ""}`}
            onClick={() => pick(p)}
            title={p.keyHint ? `${p.baseUrl} · key from ${p.keyHint}` : `${p.baseUrl} · runs on this machine`}
          >
            <span className="catalog-tile-brand">
              <ProviderIcon provider={p.local ? "local" : "custom"} size={16} connectionName={p.name} />
            </span>
            <span className="catalog-tile-name">{p.name}</span>
            <span className="catalog-tile-hint">{p.keyHint ?? "on this machine · no key needed"}</span>
          </button>
        ))}
        <button className="catalog-tile is-custom" onClick={() => setDraft({ name: "", baseUrl: "", fromCatalog: false, local })}>
          <span className="catalog-tile-name">+ Custom</span>
          <span className="catalog-tile-hint">any OpenAI-compatible URL</span>
        </button>
      </div>
      <div className="field-note">
        Every base URL in this list was checked against that provider's own docs on 2026-09-15. Providers whose docs no longer
        state one are left out rather than guessed at.
      </div>
    </div>
  );
}

/** Saved SSH deploy targets. Deliberately stores a *reference* to a key file the user already
 * has (with the permissions they already set on it) rather than a second copy of their private
 * key inside Solace's own plaintext JSON. Pasting key material is possible but has to be opened
 * explicitly, and is labelled as the weaker option, because it is. */
function SshForm({ onSaved, onDone }: { onSaved: (c: CredentialMeta) => void; onDone: () => void }) {
  const [draft, setDraft] = useState<SshCredentialDraft>(EMPTY_SSH_DRAFT);
  const [pasteKey, setPasteKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="guide">
      <label className="connection-field">
        Name
        <input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="prod-web" autoFocus />
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
        <input value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} placeholder="deploy" spellCheck={false} />
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
        <div className="field-note">
          Stored in Solace's own local file - the same file as the key path above it. Anyone who can read that file then has both
          the passphrase and the location of the key it unlocks. You can view it again later with Reveal, and remove it by
          deleting and re-adding this target.
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
      <div className="field-note">Notes are shown in this list - keep secrets in the fields above, not here.</div>

      <div className="field-note">
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
        <button className="btn-primary btn-xs" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

/**
 * Logins and free-form secrets - the two kinds that exist because "anything an agent needs
 * to sign into something later" is mostly neither an API key nor an SSH target. They share a
 * screen because they are the same thing from the user's side: a labelled entry with a secret
 * in it that Reveal can show them again.
 */
function VaultForm({ onSaved, onDone }: { onSaved: (c: CredentialMeta) => void; onDone: () => void }) {
  const [which, setWhich] = useState<"login" | "secret">("login");
  const [login, setLogin] = useState<LoginCredentialDraft>(EMPTY_LOGIN_DRAFT);
  const [secret, setSecret] = useState<SecretCredentialDraft>(EMPTY_SECRET_DRAFT);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      onSaved(which === "login" ? await saveLoginCredential(login) : await saveSecretCredential(secret));
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="guide">
      <div className="segmented">
        <button className={`segmented-option ${which === "login" ? "is-active" : ""}`} onClick={() => setWhich("login")}>
          Login
        </button>
        <button className={`segmented-option ${which === "secret" ? "is-active" : ""}`} onClick={() => setWhich("secret")}>
          Secret
        </button>
      </div>

      {which === "login" ? (
        <>
          <label className="connection-field">
            Name
            <input value={login.label} onChange={(e) => setLogin({ ...login, label: e.target.value })} placeholder="grafana" autoFocus />
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
            <input value={login.username} onChange={(e) => setLogin({ ...login, username: e.target.value })} autoComplete="off" spellCheck={false} />
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
            <div className="field-note">
              Storing the second factor next to the password means this one file is enough to sign in. Keep it elsewhere if that
              matters for this account.
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
          <div className="field-note">
            Stored in Solace's own local file on this machine. Notes are shown in the list, so keep secrets in the fields above.
            You can read any of this back later with Reveal.
          </div>
        </>
      ) : (
        <>
          <label className="connection-field">
            Name
            <input value={secret.label} onChange={(e) => setSecret({ ...secret, label: e.target.value })} placeholder="stripe restricted key" autoFocus />
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
          <div className="field-note">
            Stored in Solace's own local file on this machine. Notes are shown in the list, so keep the secret itself in the field
            above. An agent can ask for this by name, and you'll see a message in its hub when it does.
          </div>
        </>
      )}

      <div className="field-note">
        Nothing here can be verified from Solace. Whether the far end still accepts it is only knowable by signing in, which this
        app won't do on its own - so these rows never show a working state.
      </div>

      {error && (
        <div className="field-error" role="alert">
          {error}
        </div>
      )}
      <div className="connection-add-actions">
        <button className="btn-primary btn-xs" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import type { CatalogProvider, CredentialMeta, LocalServerFinding, ProviderId, ProviderStatus } from "@solace/shared";
import { searchCatalog } from "@solace/shared";
import {
  deleteCredential,
  fetchCredentials,
  fetchProviderStatuses,
  saveCredential,
  scanLocalServers,
  testProviderConnection,
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
  if (c.provider === "custom" || c.provider === "local") return c.connectionName || c.baseUrl || "Custom endpoint";
  return providerLabel(c.provider);
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

  return (
    <div className="saved-connections">
      <div className="connection-subhead">
        API keys
        <span className="label-rule" />
      </div>

      {credentials?.length === 0 && !adding && <div className="provider-hint connection-empty">No saved API keys yet.</div>}

      {credentials?.map((c) => (
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
          </span>
          <span className="provider-actions">
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

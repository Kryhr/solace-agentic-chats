import { useEffect, useMemo, useState } from "react";
import type { AgentConfig, CatalogMcpServer, CredentialMeta, McpEnvEntry, McpServerConfig } from "@solace/shared";
import {
  createMcpServer,
  deleteMcpServer,
  fetchCredentials,
  fetchMcpServers,
  testMcpServer,
  updateMcpServer,
  type McpServerDraft,
  type McpTestResult,
} from "../api";

/**
 * MCP servers: tools the user gives their agents, beyond whatever their CLI ships with.
 *
 * Three rules shape this panel, and they are the same ones Connections follows.
 *
 * 1. Nothing claims to work that has not been proved to work. A row says "Verified - N tools"
 *    only when Test actually spawned the server and it answered an MCP handshake with those
 *    tools. Everything else says "Not tested", which looks different, and editing a server's
 *    command clears the badge server-side because what was proved was the old command.
 *
 * 2. Say what an entry needs BEFORE it fails. A catalogue tile that wants an API key or a
 *    running desktop app says so on the tile, not in a stack trace twenty seconds later.
 *
 * 3. A token goes in the vault, not in this form. An env value can reference a saved
 *    credential, and the panel says plainly that anything typed inline is stored in plaintext.
 */

/** Per-agent is the default worth nudging toward: a Roblox server on every agent is seven
 * irrelevant tools in six agents' tool lists, paid for in context on every turn they take. */
type ScopeKind = "global" | "agents";

interface DraftState {
  id?: string;
  name: string;
  command: string;
  argsText: string;
  env: McpEnvEntry[];
  scopeKind: ScopeKind;
  agentIds: string[];
  note: string;
  enabled: boolean;
}

const EMPTY_DRAFT: DraftState = {
  name: "",
  command: "",
  argsText: "",
  env: [],
  scopeKind: "global",
  agentIds: [],
  note: "",
  enabled: true,
};

/** Args are edited as one line, split on whitespace outside quotes - the same shape the user
 * copied out of a README. Quoted segments survive, because a Windows path with a space is the
 * single most common argument these servers take. */
function parseArgs(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

function formatArgs(args: string[]): string {
  return args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
}

function draftFromServer(server: McpServerConfig): DraftState {
  return {
    id: server.id,
    name: server.name,
    command: server.command,
    argsText: formatArgs(server.args),
    env: server.env,
    scopeKind: server.scope.kind === "agents" ? "agents" : "global",
    agentIds: server.scope.kind === "agents" ? server.scope.agentIds : [],
    note: server.note ?? "",
    enabled: server.enabled,
  };
}

function draftFromCatalog(entry: CatalogMcpServer): DraftState {
  return {
    ...EMPTY_DRAFT,
    name: entry.name,
    command: entry.command,
    argsText: formatArgs(entry.args),
    env: (entry.requiredEnv ?? []).map((e) => ({ name: e.name, value: "" })),
    note: entry.blurb,
  };
}

function toPayload(draft: DraftState): McpServerDraft {
  return {
    name: draft.name,
    command: draft.command,
    args: parseArgs(draft.argsText),
    env: draft.env.filter((e) => e.name.trim()),
    enabled: draft.enabled,
    note: draft.note,
    scope: draft.scopeKind === "agents" ? { kind: "agents", agentIds: draft.agentIds } : { kind: "global" },
  };
}

export function McpPanel({ agents }: { agents: AgentConfig[] }) {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [catalog, setCatalog] = useState<CatalogMcpServer[]>([]);
  const [credentials, setCredentials] = useState<CredentialMeta[]>([]);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<McpTestResult | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = () => {
    fetchMcpServers()
      .then((data) => {
        setServers(data.servers);
        setCatalog(data.catalog);
      })
      .catch(() => setError("Could not load MCP servers."))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    reload();
    fetchCredentials()
      .then(setCredentials)
      .catch(() => setCredentials([]));
  }, []);

  const alreadyAdded = useMemo(() => new Set(servers.map((s) => s.name)), [servers]);

  const openDraft = (next: DraftState) => {
    setDraft(next);
    setTestResult(null);
    setError(null);
  };

  const save = async () => {
    if (!draft) return;
    setError(null);
    try {
      const payload = toPayload(draft);
      if (draft.id) await updateMcpServer(draft.id, payload);
      else await createMcpServer(payload);
      setDraft(null);
      setTestResult(null);
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const runTest = async () => {
    if (!draft) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testMcpServer({ ...toPayload(draft), id: draft.id });
      setTestResult(result);
      // A successful test against a SAVED server records the badge server-side, so the list
      // has to be re-read to show it - the badge is the server's fact, not this form's.
      if (result.ok && draft.id) reload();
    } catch (err) {
      setTestResult({ ok: false, tools: [], error: (err as Error).message });
    } finally {
      setTesting(false);
    }
  };

  const remove = async (id: string) => {
    await deleteMcpServer(id);
    if (draft?.id === id) setDraft(null);
    reload();
  };

  const toggleEnabled = async (server: McpServerConfig) => {
    await updateMcpServer(server.id, { enabled: !server.enabled });
    reload();
  };

  return (
    <section className="mcp-panel">
      {/* No title or blurb of its own. This panel has exactly one caller - the "MCP servers"
          section of Settings - which already heads it with that name and, since this header was
          emptied, the whole description too. Carrying a second <h2> and a second paragraph here
          printed the heading twice, one under the other, with two blurbs saying much the same
          thing, and nested an h2 inside that section's h3. */}
      <header className="mcp-panel-head">
        <button className="mcp-add" onClick={() => openDraft({ ...EMPTY_DRAFT })}>
          + Add server
        </button>
      </header>

      {error && <p className="mcp-error">{error}</p>}

      {loading ? (
        <p className="mcp-empty">Loading…</p>
      ) : servers.length === 0 ? (
        <p className="mcp-empty">No MCP servers registered. Your agents still have their CLI's own tools.</p>
      ) : (
        <ul className="mcp-list">
          {servers.map((server) => {
            const scopeLabel =
              server.scope.kind === "global"
                ? "All agents"
                : server.scope.agentIds.length === 0
                  ? "No agents yet"
                  : server.scope.agentIds
                      .map((id) => agents.find((a) => a.id === id)?.handle ?? "(removed agent)")
                      .join(", ");
            return (
              <li key={server.id} className={`mcp-row${server.enabled ? "" : " is-off"}`}>
                <div className="mcp-row-main">
                  <div className="mcp-row-title">
                    <strong>{server.name}</strong>
                    {server.lastVerified ? (
                      <span className="mcp-badge is-verified">
                        Verified · {server.lastVerified.tools.length} tool{server.lastVerified.tools.length === 1 ? "" : "s"}
                      </span>
                    ) : (
                      // Deliberately not styled as a warning and deliberately not absent: "we
                      // have never checked" is a real state, distinct from a failure.
                      <span className="mcp-badge">Not tested</span>
                    )}
                  </div>
                  <code className="mcp-cmd">
                    {server.command} {formatArgs(server.args)}
                  </code>
                  <p className="mcp-meta">
                    {scopeLabel}
                    {server.env.length > 0 && ` · ${server.env.length} env var${server.env.length === 1 ? "" : "s"}`}
                    {server.lastVerified && ` · last verified ${new Date(server.lastVerified.at).toLocaleString()}`}
                  </p>
                </div>
                <div className="mcp-row-actions">
                  <button onClick={() => toggleEnabled(server)}>{server.enabled ? "Disable" : "Enable"}</button>
                  <button onClick={() => openDraft(draftFromServer(server))}>Edit</button>
                  <button className="mcp-danger" onClick={() => remove(server.id)}>
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <h3 className="mcp-section-head">Suggested</h3>
      <p className="mcp-sub">
        Each of these was checked against the project's own docs on 15 September 2026. Anything that could not be confirmed
        was left out rather than guessed.
      </p>
      <ul className="mcp-catalog">
        {catalog.map((entry) => (
          <li key={entry.name} className="mcp-tile">
            <div className="mcp-tile-head">
              <strong>{entry.title}</strong>
              {alreadyAdded.has(entry.name) ? (
                <span className="mcp-badge">Added</span>
              ) : (
                <button onClick={() => openDraft(draftFromCatalog(entry))}>Add</button>
              )}
            </div>
            <p className="mcp-tile-blurb">{entry.blurb}</p>
            {entry.requiredEnv?.map((env) => (
              <p key={env.name} className="mcp-tile-need">
                Needs <code>{env.name}</code> — {env.hint}
              </p>
            ))}
            {entry.needsLocalApp && <p className="mcp-tile-need">{entry.needsLocalApp}</p>}
            {entry.placeholderArgs?.length ? (
              <p className="mcp-tile-need">Replace the placeholder path in its arguments before it will work.</p>
            ) : null}
            {entry.macos && <p className="mcp-tile-need">On macOS this launches differently: {entry.macos.command}</p>}
          </li>
        ))}
      </ul>

      {draft && (
        <div className="mcp-editor">
          <h3>{draft.id ? `Edit ${draft.name}` : "Add an MCP server"}</h3>

          <label className="mcp-field">
            <span>Name</span>
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="roblox-studio"
            />
          </label>
          <p className="mcp-hint">
            Agents call its tools as <code>mcp__{draft.name || "name"}__tool</code>. Lowercase letters, digits, hyphens.
            {draft.name.includes("_") && " Avoid underscores: Gemini's policy engine mis-parses a server name containing one."}
          </p>

          <label className="mcp-field">
            <span>Command</span>
            <input value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} placeholder="npx" />
          </label>

          <label className="mcp-field">
            <span>Arguments</span>
            <input
              value={draft.argsText}
              onChange={(e) => setDraft({ ...draft, argsText: e.target.value })}
              placeholder='-y @modelcontextprotocol/server-filesystem "C:\\my project"'
            />
          </label>
          <p className="mcp-hint">Split on spaces. Put quotes around any path that contains one.</p>

          <div className="mcp-field mcp-field-block">
            <span>Environment</span>
            {draft.env.map((entry, i) => (
              <div key={i} className="mcp-env-row">
                <input
                  className="mcp-env-name"
                  value={entry.name}
                  onChange={(e) => {
                    const env = [...draft.env];
                    env[i] = { ...env[i], name: e.target.value } as McpEnvEntry;
                    setDraft({ ...draft, env });
                  }}
                  placeholder="GITHUB_PERSONAL_ACCESS_TOKEN"
                />
                <select
                  value={entry.credentialId ?? ""}
                  onChange={(e) => {
                    const env = [...draft.env];
                    env[i] = e.target.value ? { name: entry.name, credentialId: e.target.value } : { name: entry.name, value: "" };
                    setDraft({ ...draft, env });
                  }}
                >
                  <option value="">Typed in below</option>
                  {credentials.map((c) => (
                    <option key={c.id} value={c.id}>
                      Vault: {c.label}
                    </option>
                  ))}
                </select>
                {entry.credentialId ? (
                  <span className="mcp-env-vaulted">read from the vault when the server starts</span>
                ) : (
                  <input
                    className="mcp-env-value"
                    value={entry.value ?? ""}
                    onChange={(e) => {
                      const env = [...draft.env];
                      env[i] = { name: entry.name, value: e.target.value };
                      setDraft({ ...draft, env });
                    }}
                    placeholder="value"
                  />
                )}
                <button
                  className="mcp-danger"
                  onClick={() => setDraft({ ...draft, env: draft.env.filter((_, j) => j !== i) })}
                >
                  ×
                </button>
              </div>
            ))}
            <button onClick={() => setDraft({ ...draft, env: [...draft.env, { name: "", value: "" }] })}>
              + Environment variable
            </button>
          </div>
          <p className="mcp-hint">
            A value typed in here is stored in plaintext in Solace's state file. Put a token in the vault and select it
            instead — a vault value is also scrubbed out of chat history if an agent ever repeats it back.
          </p>

          <div className="mcp-field mcp-field-block">
            <span>Give this to</span>
            <label className="mcp-radio">
              <input
                type="radio"
                checked={draft.scopeKind === "global"}
                onChange={() => setDraft({ ...draft, scopeKind: "global" })}
              />
              Every agent
            </label>
            <label className="mcp-radio">
              <input
                type="radio"
                checked={draft.scopeKind === "agents"}
                onChange={() => setDraft({ ...draft, scopeKind: "agents" })}
              />
              Only the agents I pick
            </label>
            {draft.scopeKind === "agents" && (
              <div className="mcp-agent-picks">
                {agents.length === 0 ? (
                  <p className="mcp-hint">No agents yet. Add one first, or give this to every agent.</p>
                ) : (
                  agents.map((agent) => (
                    <label key={agent.id} className="mcp-radio">
                      <input
                        type="checkbox"
                        checked={draft.agentIds.includes(agent.id)}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            agentIds: e.target.checked
                              ? [...draft.agentIds, agent.id]
                              : draft.agentIds.filter((id) => id !== agent.id),
                          })
                        }
                      />
                      {agent.handle}
                    </label>
                  ))
                )}
              </div>
            )}
            <p className="mcp-hint">
              Every agent that gets this server carries its tools in every turn it takes. Picking the ones that need it keeps
              the others' tool lists (and their context) clear.
            </p>
          </div>

          {testResult && (
            <div className={`mcp-test-result${testResult.ok ? " is-ok" : " is-bad"}`}>
              {testResult.ok ? (
                <>
                  <strong>
                    Started and answered · {testResult.tools.length} tool{testResult.tools.length === 1 ? "" : "s"}
                  </strong>
                  {testResult.serverInfo?.name && <span> from {testResult.serverInfo.name}</span>}
                  <p className="mcp-tools">{testResult.tools.join(", ") || "(the server reported no tools)"}</p>
                </>
              ) : (
                <>
                  <strong>Did not start</strong>
                  <p>{testResult.error}</p>
                  {testResult.stderr && <pre className="mcp-stderr">{testResult.stderr}</pre>}
                </>
              )}
            </div>
          )}

          <div className="mcp-editor-actions">
            <button onClick={runTest} disabled={testing || !draft.command.trim()}>
              {testing ? "Starting it…" : "Test"}
            </button>
            <button className="mcp-primary" onClick={save} disabled={!draft.name.trim() || !draft.command.trim()}>
              Save
            </button>
            <button onClick={() => setDraft(null)}>Cancel</button>
          </div>
          <p className="mcp-hint">
            Test actually launches the server and asks it what tools it has. You can save without testing — the row will say
            it was never tested.
          </p>
        </div>
      )}

      <p className="mcp-footnote">
        These reach agents that run a CLI (Claude Code, Codex, Gemini, Qwen, Copilot). Agents pointed at an API endpoint or a
        local model run Solace's own tool loop instead, which has no MCP client yet — registering a server here does nothing
        for those, and the panel would rather say so than let you wonder.
      </p>
    </section>
  );
}

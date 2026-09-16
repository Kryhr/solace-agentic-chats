import { useEffect, useState } from "react";
import type {
  ApiKeyCredentialMeta,
  ConnectionCheck,
  ConnectorKindId,
  CredentialMeta,
  GithubConnection,
  LoginCredentialMeta,
  ProviderId,
  ProviderStatus,
  SecretCredentialMeta,
  SshCredentialMeta,
} from "@solace/shared";
import { CONNECTOR_KINDS } from "@solace/shared";
import {
  checkCliConnection,
  checkCredentialConnection,
  deleteCredential,
  fetchCredentials,
  fetchGithubConnection,
  fetchProviderStatuses,
  NotCheckableError,
} from "../api";
import { BRAND_ICONS } from "./brandIcons";
import { ProviderIcon, providerLabel } from "./ProviderIcon";
import { RevealSecret } from "./RevealSecret";
import { AddConnectionModal } from "./AddConnectionModal";

/**
 * Connections: everything this machine can reach, in one list, with one way in.
 *
 * Two rules shape this file.
 *
 * 1. One entry point. "Add connection" is the section's primary action and sits at the top,
 *    next to the heading. It opens a chooser over CONNECTOR_KINDS covering every kind - CLI
 *    agents, GitHub, local servers, hosted endpoints, deploy targets, vault entries - so no
 *    single kind can read as "what Connections is for". The panel used to bury its only add
 *    button inside the API-keys section, which made the whole surface look like a place to
 *    paste API keys.
 *
 * 2. Nothing is green that wasn't checked. A row's state is a real ConnectionCheck or it is
 *    "Not checked", and those look different. Both carry the time, because every one of these
 *    can stop being true: a CLI is uninstalled, a token expires, a local server is closed.
 *    The CLI and GitHub rows arrive already checked because listing them IS running the check
 *    (`--version`, `gh auth status`); saved endpoints arrive unchecked, because checking one
 *    means a request against a possibly-paid API and that only happens when the user asks.
 */

/** What a row is currently able to say about itself. "unchecked" is a first-class state, not
 * a placeholder for a result we expect to be fine. */
type CheckState =
  | { status: "unchecked" }
  | { status: "checking" }
  | { status: "done"; check: ConnectionCheck }
  | { status: "not-checkable"; reason: string }
  | { status: "error"; message: string };

const UNCHECKED: CheckState = { status: "unchecked" };

function shortTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * The row's status word, its Check button and its dot. The mapping is the honesty contract:
 *   unchecked     → grey dot, "Not checked"      (we have no idea, and say so)
 *   done + ok     → green dot, "Working HH:MM"   (a real check, with when)
 *   done + !ok    → red dot,   "Failed HH:MM"
 *   not-checkable → NO dot and no button         (nothing failed; there is nothing to check)
 *
 * The markup shape matters: the status text and the button share one relatively-positioned
 * slot and crossfade on hover, while the dot is their sibling. Putting the dot inside that
 * slot would let the absolutely-positioned button land on top of it.
 */
function CheckControl({ state, onCheck, title }: { state: CheckState; onCheck?: () => void; title?: string }) {
  if (state.status === "not-checkable") {
    // Deliberately dotless. A vault entry has not passed and has not failed, and giving it
    // any coloured dot would put it on the same scale as things that were actually proven.
    return (
      <span className="provider-status" title={state.reason}>
        Nothing to check
      </span>
    );
  }

  const dot =
    state.status === "checking" ? "pending" : state.status === "unchecked" ? "unknown" : state.status === "error" ? "fail" : state.check.ok ? "ok" : "fail";
  const tone = dot === "ok" ? "is-ok" : dot === "fail" ? "is-fail" : "";
  // A healthy connection says it with the dot alone. "Working 6:29 PM" on every row was a
  // timestamp repeated down a list of two, which is noise standing in for information - and
  // the exact time is still one hover away. Anything NOT healthy keeps its words, because
  // that is the case where a dot alone leaves you guessing.
  const text =
    state.status === "checking"
      ? "Checking…"
      : state.status === "unchecked"
        ? "Not checked"
        : state.status === "error"
          ? "Check failed"
          : state.check.ok
            ? ""
            : `Failed ${shortTime(state.check.checkedAt)}`;
  const hover =
    state.status === "done"
      ? // Carries the time now that the row no longer prints it.
        `${state.check.ok ? "Working" : "Failed"} - checked ${shortTime(state.check.checkedAt)}${state.check.detail ? `
${state.check.detail}` : ""}`
      : state.status === "error"
        ? state.message
        : state.status === "unchecked"
          ? "No check has been run for this connection yet"
          : undefined;

  return (
    <>
      <span className="provider-swap">
        <span className={`provider-status ${tone} ${text ? "" : "dot-only"}`} title={hover}>
          {text}
        </span>
        {onCheck && (
          <button className="btn-ghost btn-xs provider-test" onClick={onCheck} disabled={state.status === "checking"} title={title}>
            Check
          </button>
        )}
      </span>
      <span className={`connection-dot ${dot}`} title={hover} />
    </>
  );
}

/** The detail line under a row: whatever the tool or endpoint actually said. Only rendered
 * once a check has really run, so an unchecked row stays quiet rather than explaining itself. */
function CheckDetail({ state }: { state: CheckState }) {
  // title carries the full text: the visible line is clamped to two rows because this is
  // whatever the endpoint said, in a ~234px column, and it was rendering taller than the
  // connection it described.
  if (state.status === "done")
    return (
      <div className="provider-hint" title={state.check.detail}>
        {state.check.detail}
      </div>
    );
  if (state.status === "error")
    return (
      <div className="provider-hint" title={state.message}>
        {state.message}
      </div>
    );
  return null;
}

/** The name to match a brand mark against, and the name to show. A "custom"/"local" row is
 * only distinguishable by what the user called it, so that comes first; the base URL's host
 * is the last resort so an unnamed row still resolves to something real. */
export function connectionDisplayName(c: ApiKeyCredentialMeta): string {
  if (c.connectionName?.trim()) return c.connectionName.trim();
  if (c.label?.trim() && c.label !== "unlabeled") return c.label.trim();
  if (c.baseUrl) {
    try {
      return new URL(c.baseUrl).hostname;
    } catch {
      return c.baseUrl;
    }
  }
  return providerLabel(c.provider);
}

function isEndpointProvider(provider: ProviderId): boolean {
  return provider === "custom" || provider === "local";
}

/** The real GitHub mark, from the same Simple Icons set ProviderIcon uses. Rendered here
 * rather than through ProviderIcon because GitHub is not a ProviderId - it is its own kind of
 * connection, which is the entire point of it having a row at all. */
function GithubMark({ size = 20 }: { size?: number }) {
  const brand = BRAND_ICONS.github;
  return (
    <span className="provider-icon" style={{ width: size, height: size, background: `${brand.color}26`, color: brand.color }} title={brand.title}>
      <svg viewBox="0 0 24 24" width={Math.round(size * 0.6)} height={Math.round(size * 0.6)} fill="currentColor" aria-hidden="true">
        <path d={brand.path} />
      </svg>
    </span>
  );
}

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

function SectionHead({ id }: { id: ConnectorKindId }) {
  const kind = CONNECTOR_KINDS.find((k) => k.id === id)!;
  return (
    <div className="connection-subhead" title={kind.verification}>
      {kind.title}
    </div>
  );
}

/**
 * Which groups this instance renders.
 *
 * The panel is mounted twice rather than duplicated. The sidebar shows the things you glance at
 * while working - which CLIs are alive, is GitHub connected, is a local server up. Keys, SSH
 * targets and vault entries moved to Settings: they are set up once, they need room to show a
 * host and a label properly, and a narrow rail is the wrong place to keep somebody's secrets
 * list permanently open.
 */
export type ConnectionSection = "cli" | "github" | "local-server" | "hosted-api" | "ssh" | "vault";

const ALL_SECTIONS: ConnectionSection[] = ["cli", "github", "local-server", "hosted-api", "ssh", "vault"];

export function ConnectionsPanel({
  sections = ALL_SECTIONS,
  variant = "rail",
}: {
  sections?: ConnectionSection[];
  /** "page" drops the panel's own header and rail padding, for embedding in Settings. */
  variant?: "rail" | "page";
} = {}) {
  const shows = (id: ConnectionSection) => sections.includes(id);
  const [statuses, setStatuses] = useState<ProviderStatus[] | null>(null);
  const [github, setGithub] = useState<GithubConnection | null>(null);
  const [credentials, setCredentials] = useState<CredentialMeta[] | null>(null);
  const [checks, setChecks] = useState<Record<string, CheckState>>({});
  const [showAdd, setShowAdd] = useState(false);

  useEffect(() => {
    fetchProviderStatuses()
      .then((list) => {
        setStatuses(list);
        // Listing a CLI provider already ran `<bin> --version` server-side, so these rows
        // arrive genuinely checked rather than assumed-good. Seeded from that same result so
        // the timestamp shown is the one the check really happened at.
        setChecks((prev) => {
          const next = { ...prev };
          for (const s of list) {
            if (!s.checkedAt) continue;
            next[`cli:${s.provider}`] = {
              status: "done",
              check: {
                ok: s.installed,
                detail: s.installed ? `\`--version\` reported ${s.version}` : (s.detail ?? "not found on PATH"),
                checkedAt: s.checkedAt,
              },
            };
          }
          return next;
        });
      })
      .catch(() => setStatuses([]));

    fetchGithubConnection()
      .then((g) => {
        setGithub(g);
        setChecks((prev) => ({
          ...prev,
          github: {
            status: "done",
            check: {
              ok: g.authenticated,
              // The verbatim first line of what gh said, not a summary of it.
              detail: g.installed
                ? g.authenticated
                  ? `gh reports signed in as ${g.account}${g.scopes?.length ? ` · scopes ${g.scopes.join(", ")}` : ""}`
                  : (g.statusText?.split(/\r?\n/).find((l) => l.trim())?.trim() ?? "gh reports no usable token")
                : "the gh CLI is not on this machine's PATH",
              checkedAt: g.checkedAt,
            },
          },
        }));
      })
      .catch(() => setGithub(null));

    // Deliberately NOT checked on mount: a check hits a possibly-paid endpoint.
    fetchCredentials()
      .then(setCredentials)
      .catch(() => setCredentials([]));
  }, []);

  const runCliCheck = async (provider: ProviderId) => {
    const key = `cli:${provider}`;
    setChecks((c) => ({ ...c, [key]: { status: "checking" } }));
    try {
      // Awaited before the updater, not inside it: a state updater must stay synchronous.
      const check = await checkCliConnection(provider);
      setChecks((c) => ({ ...c, [key]: { status: "done", check } }));
    } catch (err) {
      setChecks((c) => ({ ...c, [key]: { status: "error", message: (err as Error).message } }));
    }
  };

  const runGithubCheck = async () => {
    setChecks((c) => ({ ...c, github: { status: "checking" } }));
    try {
      const g = await fetchGithubConnection();
      setGithub(g);
      setChecks((c) => ({
        ...c,
        github: {
          status: "done",
          check: {
            ok: g.authenticated,
            detail: g.installed
              ? g.authenticated
                ? `gh reports signed in as ${g.account}${g.scopes?.length ? ` · scopes ${g.scopes.join(", ")}` : ""}`
                : (g.statusText?.split(/\r?\n/).find((l) => l.trim())?.trim() ?? "gh reports no usable token")
              : "the gh CLI is not on this machine's PATH",
            checkedAt: g.checkedAt,
          },
        },
      }));
    } catch (err) {
      setChecks((c) => ({ ...c, github: { status: "error", message: (err as Error).message } }));
    }
  };

  const runCredentialCheck = async (id: string) => {
    const key = `cred:${id}`;
    setChecks((c) => ({ ...c, [key]: { status: "checking" } }));
    try {
      const check = await checkCredentialConnection(id);
      setChecks((c) => ({ ...c, [key]: { status: "done", check } }));
    } catch (err) {
      // "Nothing to check" is not a failure and must not render as one.
      setChecks((c) => ({
        ...c,
        [key]:
          err instanceof NotCheckableError
            ? { status: "not-checkable", reason: err.message }
            : { status: "error", message: (err as Error).message },
      }));
    }
  };

  const remove = async (id: string) => {
    await deleteCredential(id);
    setCredentials((c) => (c ?? []).filter((x) => x.id !== id));
    setChecks((c) => {
      const next = { ...c };
      delete next[`cred:${id}`];
      return next;
    });
  };

  const stateOf = (key: string): CheckState => checks[key] ?? UNCHECKED;

  const all = credentials ?? [];
  const localServers = all.filter((c): c is ApiKeyCredentialMeta => c.kind === "api-key" && c.provider === "local");
  const hosted = all.filter((c): c is ApiKeyCredentialMeta => c.kind === "api-key" && c.provider !== "local");
  const sshTargets = all.filter((c): c is SshCredentialMeta => c.kind === "ssh");
  const logins = all.filter((c): c is LoginCredentialMeta => c.kind === "login");
  const secrets = all.filter((c): c is SecretCredentialMeta => c.kind === "secret");

  /** One saved endpoint (hosted or local). They render identically - what differs is only
   * which section they sit in and what their check talks to. */
  const endpointRow = (c: ApiKeyCredentialMeta) => {
    const state = stateOf(`cred:${c.id}`);
    const name = connectionDisplayName(c);
    return (
      <div key={c.id} className="provider-row credential-row is-testable">
        <span className="provider-glyph">
          <ProviderIcon provider={c.provider} size={20} connectionName={name} />
        </span>
        <span className="provider-name">
          {name}
          <span className="credential-sub">
            {isEndpointProvider(c.provider) ? c.baseUrl : c.label}
            {/* hasKey is absent on connections saved before keyless ones existed, all of
                which did have a key - so only an explicit false means "no key". */}
            {c.hasKey === false && " · no key"}
          </span>
        </span>
        <span className="provider-actions">
          <CheckControl
            state={state}
            onCheck={() => runCredentialCheck(c.id)}
            title={`Run a real GET /models against ${c.baseUrl ?? name}`}
          />
          {c.hasKey !== false && <RevealSecret id={c.id} what="API key" />}
          <button
            className="btn-ghost btn-xs provider-delete"
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
        <CheckDetail state={state} />
      </div>
    );
  };

  if (statuses === null) {
    return (
      <section className="sidebar-group">
        <div className="sidebar-section-label">Connections</div>
        <SkeletonRows />
      </section>
    );
  }

  return (
    <section className={variant === "page" ? "connections-embedded" : "sidebar-group"}>
      {/* The primary action, at the top, beside the heading - not buried in whichever
          sub-list happened to own it. The embedded copy has a heading of its own from the
          Settings section around it, so it only needs the button. */}
      {variant === "rail" ? (
        <div className="sidebar-section-label connections-head">
          <span>Connections</span>
          <button className="btn-ghost btn-xs add-connection-top" onClick={() => setShowAdd(true)}>
            + Add connection
          </button>
        </div>
      ) : (
        <div className="connections-embedded-head">
          <button className="btn-ghost btn-xs" onClick={() => setShowAdd(true)}>
            + Add connection
          </button>
        </div>
      )}

      <div className="connection-list">
        {/* --- CLI / subscription agents. First, because they are the point of the app. --- */}
        {shows("cli") && <SectionHead id="cli" />}
        {shows("cli") &&
          statuses.map((s) => {
          const state = stateOf(`cli:${s.provider}`);
          return (
            <div key={s.provider} className="provider-row credential-row is-testable">
              <span className="provider-glyph">
                <ProviderIcon provider={s.provider} size={20} />
              </span>
              <span className="provider-name">
                {providerLabel(s.provider)}
                {s.installed && s.version && <span className="credential-sub">{s.version}</span>}
              </span>
              <span className="provider-actions">
                <CheckControl state={state} onCheck={() => runCliCheck(s.provider)} title={`Run \`--version\` for ${providerLabel(s.provider)}`} />
              </span>
              {!s.installed && s.installCommand && (
                // The real command, not a sentence about installing. This row is the most
                // common reason a new user has nothing working, so it gets the actual fix.
                <div className="provider-hint">
                  Not installed — <code>{s.installCommand}</code>
                </div>
              )}
            </div>
          );
        })}

        {/* --- GitHub. Detected all along, but until now it had no row here at all. --- */}
        {shows("github") && <SectionHead id="github" />}
        {shows("github") &&
          (github === null ? (
          <div className="provider-hint connection-empty">Asking gh…</div>
        ) : (
          <div className="provider-row credential-row is-testable">
            <span className="provider-glyph">
              <GithubMark />
            </span>
            <span className="provider-name">
              GitHub
              <span className="credential-sub">
                {!github.installed
                  ? "gh CLI not installed"
                  : github.authenticated
                    ? `${github.account}${github.scopes?.length ? ` · ${github.scopes.join(", ")}` : ""}`
                    : "installed, not signed in"}
              </span>
            </span>
            <span className="provider-actions">
              <CheckControl state={stateOf("github")} onCheck={runGithubCheck} title="Re-run `gh auth status`" />
            </span>
            {!github.authenticated && github.fixCommand && (
              <div className="provider-hint">
                <code>{github.fixCommand}</code>
              </div>
            )}
            {!github.authenticated && !github.fixCommand && github.fixHint && <div className="provider-hint">{github.fixHint}</div>}
          </div>
          ))}

        {/* --- Local model servers ------------------------------------------------------- */}
        {shows("local-server") && (
          <>
            <SectionHead id="local-server" />
            {credentials !== null && localServers.length === 0 && (
              <div className="provider-hint connection-empty">None saved.</div>
            )}
            {localServers.map(endpointRow)}
          </>
        )}

        {/* --- Hosted API endpoints ------------------------------------------------------ */}
        {shows("hosted-api") && (
          <>
            <SectionHead id="hosted-api" />
            {credentials !== null && hosted.length === 0 && (
              <div className="provider-hint connection-empty">None saved.</div>
            )}
            {hosted.map(endpointRow)}
          </>
        )}

        {/* --- Deploy targets ------------------------------------------------------------ */}
        {shows("ssh") && <SectionHead id="ssh" />}
        {shows("ssh") && credentials !== null && sshTargets.length === 0 && (
          <div className="provider-hint connection-empty">None saved.</div>
        )}
        {shows("ssh") &&
          sshTargets.map((c) => {
          const state = stateOf(`cred:${c.id}`);
          return (
            <div key={c.id} className="provider-row credential-row is-ssh is-testable">
              <span className="provider-glyph ssh-glyph" aria-hidden="true">
                SSH
              </span>
              {/* The row identifies the target and nothing else: user@host:port. The key path is
                  long, often absolute, and not what you scan a list for - it moves to the
                  tooltip, along with whether Solace is also holding the passphrase, which is the
                  one fact about it that is otherwise invisible. */}
              <span
                className="provider-name"
                title={
                  `${c.ssh.privateKeyPath ?? "Key stored in Solace (no file path)"}` +
                  `${c.ssh.hasPassphrase ? " · passphrase stored here too" : ""}` +
                  `${c.notes ? `

${c.notes}` : ""}`
                }
              >
                {`${c.ssh.username}@${c.ssh.host}`}
                <span className="credential-sub">{`port ${c.ssh.port}`}</span>
              </span>
              <span className="provider-actions">
                <CheckControl
                  state={state}
                  onCheck={() => runCredentialCheck(c.id)}
                  title="Check the key file this target points at is still there. This is not a sign-in test."
                />
                {(c.ssh.hasStoredKeyMaterial || c.ssh.hasPassphrase) && <RevealSecret id={c.id} what="key material or passphrase" />}
                <button className="btn-ghost btn-xs" onClick={() => remove(c.id)} title="Forget this deploy target (nothing on the server or on disk is touched)">
                  Delete
                </button>
              </span>
              <CheckDetail state={state} />
            </div>
          );
        })}

        {/* --- Logins & secrets. The one kind with no honest check. ---------------------- */}
        {shows("vault") && <SectionHead id="vault" />}
        {shows("vault") && credentials !== null && logins.length === 0 && secrets.length === 0 && (
          <div className="provider-hint connection-empty">
            Nothing saved yet. Anything an agent might need to sign into something - a service password, a token, a recovery code
            - can live here, and you can read it back with Reveal.
          </div>
        )}
        {shows("vault") &&
          logins.map((c) => (
          <div key={c.id} className="provider-row credential-row is-vault">
            <span className="provider-glyph vault-glyph" aria-hidden="true">
              LOG
            </span>
            <span className="provider-name" title={c.notes || undefined}>
              {c.label}
              <span className="credential-sub" title={c.service}>
                {c.username} @ {c.service}
                {!c.hasPassword && " · no password stored"}
                {c.hasTotp && " · 2FA stored"}
              </span>
            </span>
            <span className="provider-actions">
              {(c.hasPassword || c.hasTotp) && <RevealSecret id={c.id} what="password" />}
              <button className="btn-ghost btn-xs" onClick={() => remove(c.id)} title="Forget this login">
                Delete
              </button>
            </span>
          </div>
        ))}
        {shows("vault") &&
          secrets.map((c) => (
          <div key={c.id} className="provider-row credential-row is-vault">
            <span className="provider-glyph vault-glyph" aria-hidden="true">
              SEC
            </span>
            <span className="provider-name">
              {c.label}
              <span className="credential-sub">{c.hasValue ? "secret stored" : "empty"}</span>
            </span>
            <span className="provider-actions">
              {c.hasValue && <RevealSecret id={c.id} what="secret" />}
              <button className="btn-ghost btn-xs" onClick={() => remove(c.id)} title="Forget this secret">
                Delete
              </button>
            </span>
          </div>
        ))}
      </div>

      {showAdd && (
        <AddConnectionModal
          statuses={statuses}
          github={github}
          credentials={all}
          onSaved={(saved) => setCredentials((c) => [...(c ?? []), saved])}
          onClose={() => setShowAdd(false)}
        />
      )}
    </section>
  );
}

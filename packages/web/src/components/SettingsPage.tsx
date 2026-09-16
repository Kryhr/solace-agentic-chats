import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentConfig,
  AppSettings,
  NumberSettingDefinition,
  ProjectMeta,
  SelectSettingDefinition,
  SettingDefinition,
} from "@solace/shared";
import { SETTING_SECTIONS } from "@solace/shared";
import { fetchSettings, setProjectMembership, updateSettings } from "../api";
import { ProviderIcon } from "./ProviderIcon";
import { McpPanel } from "./McpPanel";
import { ConnectionsPanel } from "./ConnectionsPanel";

/**
 * Does this setting match what was typed in the filter box?
 *
 * Label AND description, because the label is a short phrase and the thing a user actually
 * remembers is usually a word from the explanation ("billed", "rate limit", "hub"). Every word
 * typed has to appear SOMEWHERE in the row rather than as one contiguous run, so "resume turn"
 * finds the resume setting even though those two words are nowhere near each other in it.
 */
function matchesFilter(def: SettingDefinition, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = `${def.label} ${def.description}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/**
 * App settings, rendered from the schema the server serves rather than from JSX written per
 * setting. Adding a second setting is one entry in SETTING_DEFINITIONS (shared/src/settings.ts)
 * and nothing here changes.
 *
 * These are saved on the SERVER, not in this browser - they change how the server behaves for
 * every tab and for turns that run when no tab is open at all. The page says so, because a
 * settings screen that silently only applies to one browser is a trap.
 */
export function SettingsPage({
  settings,
  onSettingsChange,
  agents,
  projects,
  onProjectsChange,
  onBack,
}: {
  /** The live value, kept in App so a change made in another tab (settings:updated over the
   * socket) updates this page while it is open. */
  settings: AppSettings | null;
  onSettingsChange: (settings: AppSettings) => void;
  agents: AgentConfig[];
  projects: ProjectMeta[];
  onProjectsChange: (projects: ProjectMeta[]) => void;
  onBack: () => void;
}) {
  const [memberBusy, setMemberBusy] = useState<string | null>(null);
  const [definitions, setDefinitions] = useState<SettingDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);

  /**
   * Group the schema into the sections it declares, in SETTING_SECTIONS order, after filtering.
   *
   * Built from the definitions rather than from a list written here, so adding a setting stays
   * one array entry in shared/src/settings.ts. A section whose settings are all filtered out
   * drops away entirely - an empty "Projects" heading would read as "there is nothing here",
   * which is a different (and wrong) claim from "nothing here matched what you typed".
   */
  const terms = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const grouped = useMemo(() => {
    const matched = definitions.filter((def) => matchesFilter(def, terms));
    const known = SETTING_SECTIONS.map((section) => ({
      section,
      defs: matched.filter((def) => def.section === section.id),
    }));
    // Anything the server sent that this page has no heading for is shown anyway, at the end.
    //
    // Not hypothetical: a server running a build older than this page sends definitions with no
    // section at all, and filtering them out silently produced a completely blank settings page
    // claiming nothing matched an empty filter. A setting that exists, saves and is honoured
    // must never be invisible just because its heading is unfamiliar.
    const filed = new Set(SETTING_SECTIONS.map((s) => s.id));
    const orphans = matched.filter((def) => !filed.has(def.section));
    return [
      ...known,
      { section: { id: "other" as const, title: "Other", blurb: "Sent by the server under a heading this page does not know." }, defs: orphans },
    ].filter((group) => group.defs.length > 0);
  }, [definitions, filter]);

  const matchCount = grouped.reduce((n, group) => n + group.defs.length, 0);

  /**
   * "/" focuses the filter, Escape clears it.
   *
   * Safe to bind at the window: this page and the chat composer are never mounted at the same
   * time (App renders one view or the other), so it cannot steal a keystroke the composer wants.
   * The typing guard is belt-and-braces for the controls on THIS page - without it, typing a
   * slash into the filter box itself, or into a number box, would be swallowed.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement ||
        el?.isContentEditable === true;
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        filterRef.current?.focus();
        filterRef.current?.select();
      }
      if (e.key === "Escape" && el === filterRef.current) {
        setFilter("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    fetchSettings()
      .then((data) => {
        setDefinitions(data.definitions);
        onSettingsChange(data.settings);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
    // Fetched once on mount; later changes arrive over the socket.
  }, []);

  /**
   * Save one setting, whatever kind of control it came from.
   *
   * Optimistic, then corrected by whatever the server ACTUALLY stored - which matters more now
   * than it did with only toggles: the server rejects an out-of-range number and keeps the
   * documented default instead, and this is what makes the box snap back to show that, rather
   * than displaying a value the server never accepted.
   */
  const save = async (def: SettingDefinition, next: AppSettings[typeof def.key]) => {
    if (!settings) return;
    const previous = settings;
    onSettingsChange({ ...settings, [def.key]: next });
    setSavingKey(def.key);
    setError(null);
    try {
      onSettingsChange(await updateSettings({ [def.key]: next } as Partial<AppSettings>));
    } catch (err) {
      onSettingsChange(previous);
      setError((err as Error).message);
    } finally {
      setSavingKey(null);
    }
  };

  const handleMember = async (project: ProjectMeta, agent: AgentConfig, member: boolean) => {
    const busyKey = `${project.id}:${agent.id}`;
    setMemberBusy(busyKey);
    setError(null);
    try {
      onProjectsChange(await setProjectMembership(project.id, agent.id, member));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setMemberBusy(null);
    }
  };

  return (
    <div className="hub-page">
      <div className="hub-page-header">
        <button className="back-btn" onClick={onBack}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          Group chat
        </button>
        <div className="hub-page-identity">
          <h2>Settings</h2>
        </div>
      </div>

      <div className="hub-page-chat">
        <div className="settings-list">
          <p className="settings-scope-note">
            Saved on the server, not in this browser. They apply to every tab, and to turns that run when no tab is
            open.
          </p>

          {error && <div className="settings-error">{error}</div>}

          {/* Only worth showing once there is actually something to load and filter. Rendering
              it over "Loading settings…" would offer to narrow a list that does not exist yet. */}
          {!loading && settings && definitions.length > 0 && (
            <div className="settings-filter">
              <svg
                className="settings-filter-icon"
                viewBox="0 0 16 16"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <circle cx="7.2" cy="7.2" r="4.4" />
                <path d="M10.4 10.4 13.5 13.5" />
              </svg>
              <input
                ref={filterRef}
                className="settings-filter-input"
                type="search"
                value={filter}
                placeholder="Filter settings"
                aria-label="Filter settings by name or description"
                onChange={(e) => setFilter(e.target.value)}
              />
              {/* Announced politely rather than assertively: it updates on every keystroke, and
                  an assertive region would interrupt a screen-reader user mid-word. */}
              <span className="settings-filter-count" aria-live="polite">
                {terms.length === 0 ? `${definitions.length} settings` : `${matchCount} of ${definitions.length}`}
              </span>
              {terms.length > 0 && (
                <button type="button" className="settings-filter-clear" onClick={() => setFilter("")}>
                  Clear
                </button>
              )}
            </div>
          )}

          {loading || !settings ? (
            <div className="chat-empty">
              <div className="chat-empty-title">Loading settings…</div>
            </div>
          ) : definitions.length === 0 ? (
            <div className="chat-empty">
              <div className="chat-empty-title">No settings yet</div>
              <div className="chat-empty-body">This server exposes no configurable options.</div>
            </div>
          ) : grouped.length === 0 ? (
            /* A filter that matches nothing must SAY nothing matched. Falling through to an
               empty column would look identical to a page that failed to load, and the way out
               (clear the box) would not be obvious from anything on screen. */
            <div className="chat-empty">
              <div className="chat-empty-title">Nothing matches “{filter.trim()}”</div>
              <div className="chat-empty-body">
                No setting has that in its name or description.{" "}
                <button type="button" className="settings-empty-clear" onClick={() => setFilter("")}>
                  Show all {definitions.length} settings
                </button>
              </div>
            </div>
          ) : (
            grouped.map(({ section, defs }) => (
              <section key={section.id} className="settings-group">
                <div className="settings-group-head">
                  <h3 className="settings-group-title">{section.title}</h3>
                  <p className="settings-group-blurb">{section.blurb}</p>
                </div>
                {defs.map((def) => (
                  <SettingRow
                    key={def.key}
                    def={def}
                    settings={settings}
                    busy={savingKey === def.key}
                    onSave={save}
                  />
                ))}
              </section>
            ))
          )}

          {/* Keys, SSH deploy targets and vault entries. These were in the sidebar rail, where
              a saved login had ~104px to render a label AND a service, and an SSH target could
              not show its host without truncating it. They are configuration you set up once,
              so they belong on a page with room, next to the other things you set up once. */}
          <section className="settings-section">
            <h3 className="settings-section-title">Keys &amp; secrets</h3>
            <p className="settings-section-note">
              SSH deploy targets, service logins and anything else an agent might need to sign in with. Values are
              never shown in a list or in chat - use Reveal to read one back.
            </p>
            <ConnectionsPanel sections={["ssh", "vault"]} variant="page" />
          </section>

          {/* MCP servers live here rather than in the sidebar. They were originally rendered
              beside Connections, in a 234px rail, where each tile had to fit a title, a
              paragraph of description, a setup note and an Add button - the text simply ran out
              of the container. They are configuration, they are read once and rarely changed,
              and this page has the width to show them properly. */}
          <section className="settings-section">
            <h3 className="settings-section-title">MCP servers</h3>
            <p className="settings-section-note">
              Extra tools your agents can use - reading a Roblox place, driving a browser, searching a codebase.
              Each one is registered here and can be turned on per agent, so an agent only sees the tools it needs.
            </p>
            <McpPanel agents={agents} />
          </section>

          {/* Per-project rosters. Only meaningful while agents follow the user: with the setting
              off, membership is decided by each agent's own working directory and there is
              nothing here to choose. */}
          {settings?.agentsFollowProjects && (
            <section className="settings-section">
              <h3 className="settings-section-title">Who works on each project</h3>
              <p className="settings-section-note">
                Every agent is in every project by default. Switch one off to keep it out of that project&apos;s
                chats - it stays in your other projects, and nothing on disk changes.
              </p>

              {projects.length === 0 ? (
                <div className="settings-section-empty">
                  No projects yet. Create one from the sidebar and your agents will already be in it.
                </div>
              ) : agents.length === 0 ? (
                <div className="settings-section-empty">No agents yet.</div>
              ) : (
                projects.map((project) => {
                  const excluded = new Set(project.excludedAgentIds ?? []);
                  return (
                    <div key={project.id} className="project-members">
                      <div className="project-members-head">
                        <span className="project-members-name">{project.name}</span>
                        <span className="project-members-count">
                          {agents.length - excluded.size} of {agents.length}
                        </span>
                      </div>
                      <div className="project-members-list">
                        {agents.map((agent) => {
                          const member = !excluded.has(agent.id);
                          const busyKey = `${project.id}:${agent.id}`;
                          return (
                            <button
                              key={agent.id}
                              type="button"
                              role="switch"
                              aria-checked={member}
                              aria-label={`${agent.handle} in ${project.name}`}
                              className={`member-chip ${member ? "is-member" : ""}`}
                              disabled={memberBusy === busyKey}
                              onClick={() => void handleMember(project, agent, !member)}
                            >
                              <ProviderIcon provider={agent.provider} size={16} />
                              <span className="member-chip-handle">{agent.handle}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * One setting row, whatever control it renders as.
 *
 * Pulled out of the page only because the page now maps over sections and then over settings,
 * and two levels of nesting around this much JSX stopped being readable. The behaviour is
 * unchanged: the control is still chosen from `def.kind` alone, so a new kind is a compile
 * error here rather than a silently unrendered row.
 */
function SettingRow({
  def,
  settings,
  busy,
  onSave,
}: {
  def: SettingDefinition;
  settings: AppSettings;
  busy: boolean;
  onSave: (def: SettingDefinition, next: AppSettings[typeof def.key]) => void;
}) {
  return (
    <div className="setting-entry">
      <div className="setting-entry-text">
        <label className="setting-entry-label" htmlFor={`setting-${def.key}`}>
          {def.label}
        </label>
        <div className="setting-entry-desc">{def.description}</div>
      </div>
      {def.kind === "toggle" ? (
        <button
          id={`setting-${def.key}`}
          type="button"
          role="switch"
          aria-checked={settings[def.key] as boolean}
          className="setting-switch"
          disabled={busy}
          onClick={() => onSave(def, !settings[def.key])}
        >
          <span className="setting-switch-track" aria-hidden="true">
            <span className="setting-switch-thumb" />
          </span>
          <span className="setting-switch-state">{settings[def.key] ? "On" : "Off"}</span>
        </button>
      ) : def.kind === "number" ? (
        <NumberControl
          def={def}
          value={settings[def.key] as number}
          busy={busy}
          onCommit={(next) => onSave(def, next)}
        />
      ) : (
        <SelectControl
          def={def}
          value={settings[def.key] as string}
          busy={busy}
          // The control can only ever emit one of def.options, and sanitizeAppSettings checks
          // that same list again on the server, so the cast is narrowing a string TS cannot see
          // is already constrained - not trusting free input.
          onCommit={(next) => onSave(def, next as AppSettings[typeof def.key])}
        />
      )}
    </div>
  );
}

/**
 * A number setting: a box, the unit it is measured in, and the legal range said out loud.
 *
 * Holds a DRAFT string rather than writing on every keystroke. Typing "120" through a
 * write-per-keystroke input would PATCH "1", then "12", then "120" - and since the server
 * rejects anything outside the range rather than clamping it, the intermediate "1" would be
 * refused and snap the box back mid-word. So: edit freely, save on blur or Enter, revert on
 * Escape. The draft is dropped whenever the saved value changes underneath (another tab), which
 * is the same rule the toggles follow.
 */
function NumberControl({
  def,
  value,
  busy,
  onCommit,
}: {
  def: NumberSettingDefinition;
  value: number;
  busy: boolean;
  onCommit: (next: number) => void;
}) {
  const [draft, setDraft] = useState<string>(String(value));
  // Re-sync when the stored value changes for any reason other than this box: another tab, or
  // the server correcting a value it refused.
  useEffect(() => setDraft(String(value)), [value]);

  const parsed = Number(draft.trim());
  const valid = draft.trim() !== "" && Number.isFinite(parsed) && parsed >= def.min && parsed <= def.max;

  const commit = () => {
    // An empty or out-of-range box is not a request to store something odd - it is an abandoned
    // edit. Put the real value back rather than sending one we know will be refused.
    if (!valid) {
      setDraft(String(value));
      return;
    }
    if (Math.round(parsed) !== value) onCommit(Math.round(parsed));
  };

  return (
    <div className="setting-number">
      <input
        id={`setting-${def.key}`}
        className={`setting-number-input ${valid ? "" : "is-invalid"}`}
        type="number"
        inputMode="numeric"
        min={def.min}
        max={def.max}
        step={1}
        value={draft}
        disabled={busy}
        aria-describedby={`setting-${def.key}-range`}
        aria-invalid={!valid}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setDraft(String(value));
            e.currentTarget.blur();
          }
        }}
      />
      <div className="setting-number-meta">
        <span className="setting-number-unit">{def.unit}</span>
        <span className="setting-number-range" id={`setting-${def.key}-range`}>
          {def.min}&ndash;{def.max}
        </span>
      </div>
    </div>
  );
}

/** A setting with a fixed set of choices. Saves immediately: unlike the number box there is no
 * half-typed state to protect, and every option it offers is one the server already accepts. */
function SelectControl({
  def,
  value,
  busy,
  onCommit,
}: {
  def: SelectSettingDefinition;
  value: string;
  busy: boolean;
  onCommit: (next: string) => void;
}) {
  return (
    <select
      id={`setting-${def.key}`}
      className="select setting-select"
      value={value}
      disabled={busy}
      onChange={(e) => onCommit(e.target.value)}
    >
      {def.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

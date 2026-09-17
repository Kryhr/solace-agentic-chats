import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentConfig,
  AppSettings,
  NumberSettingDefinition,
  ProjectMeta,
  SelectSettingDefinition,
  SettingDefinition,
} from "@solace/shared";
import { DEFAULT_APP_SETTINGS, SETTING_SECTIONS } from "@solace/shared";
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
 * The page's own panels, alongside the schema-driven sections.
 *
 * These are configuration too - they are simply not AppSettings, because what they configure is
 * a list of things (CLIs, MCP servers, credentials) rather than a value. Before, they were
 * appended to the bottom of one long column with no way to reach them except scrolling past
 * every setting, which is most of why this page needed a filter box to be usable at all. Listing
 * them in the same nav as the settings is the whole point: "which is which type of what" is
 * answered by the nav, not by reading every row.
 */
const PANEL_SECTIONS = [
  {
    id: "providers",
    title: "Providers & accounts",
    blurb: "Which coding CLIs Solace may run, and which login each one uses.",
  },
  {
    id: "tools",
    title: "Tools & MCP",
    blurb: "Extra tools your agents can reach, registered once and switched on per agent.",
  },
  {
    id: "secrets",
    title: "Keys & secrets",
    blurb: "Deploy targets and service logins. Values are never listed or shown in chat.",
  },
] as const;

/** Every default, said in the words the control uses. Read from DEFAULT_APP_SETTINGS rather
 * than restated here, so a default can never drift from the one the server falls back to. */
function defaultLabel(def: SettingDefinition): string {
  const value = DEFAULT_APP_SETTINGS[def.key];
  if (def.kind === "toggle") return value ? "On" : "Off";
  if (def.kind === "number") return `${(value as number).toLocaleString()} ${def.unit}`;
  return def.options.find((o) => o.value === value)?.label.split(" - ")[0] ?? String(value);
}

/** True when the stored value is still the documented default. Drives the "Default" marker,
 * which is the cheap way to answer "what have I actually changed here". */
function isDefault(def: SettingDefinition, settings: AppSettings): boolean {
  return settings[def.key] === DEFAULT_APP_SETTINGS[def.key];
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
  /** Which nav entry is highlighted. Driven by what is actually on screen, not by what was last
   * clicked - a nav that keeps pointing at a section you scrolled away from is lying. */
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

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
  /** Panels have no searchable rows of their own, so a filter narrows the nav to settings only
   * rather than leaving three entries that ignore what was typed. */
  const showPanels = terms.length === 0;
  const navEntries = useMemo(
    () => [
      ...grouped.map((g) => ({ id: g.section.id, title: g.section.title, count: g.defs.length })),
      ...(showPanels ? PANEL_SECTIONS.map((p) => ({ id: p.id, title: p.title, count: undefined })) : []),
      ...(showPanels && settings?.agentsFollowProjects
        ? [{ id: "rosters", title: "Who works on each project", count: undefined }]
        : []),
    ],
    [grouped, showPanels, settings?.agentsFollowProjects],
  );

  /**
   * Highlight whichever section is actually in view.
   *
   * rootMargin pulls the trigger line to just under the sticky filter bar and leaves the bottom
   * 55% out of consideration, so the highlighted entry is the heading you are reading rather
   * than whichever one happens to be nearest the viewport's centre. Re-run when the nav changes
   * because filtering removes and restores the very elements being observed.
   */
  useEffect(() => {
    const root = scrollerRef.current;
    if (!root || navEntries.length === 0) return;
    const seen = new Map<string, boolean>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) seen.set(entry.target.id, entry.isIntersecting);
        const first = navEntries.find((e) => seen.get(`settings-section-${e.id}`));
        if (first) setActiveSection(first.id);
      },
      { root, rootMargin: "-72px 0px -55% 0px", threshold: 0 },
    );
    for (const entry of navEntries) {
      const el = root.querySelector(`#settings-section-${entry.id}`);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [navEntries]);

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

  const jumpTo = (id: string) => {
    const el = scrollerRef.current?.querySelector(`#settings-section-${id}`);
    // "start" with the section's own scroll-margin-top, which clears the sticky filter bar - a
    // plain scrollIntoView put every heading underneath it.
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveSection(id);
  };

  const ready = !loading && settings !== null;

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

      <div className="hub-page-chat" ref={scrollerRef}>
        <div className="settings-shell">
          {/* The nav is rendered only once there is something to navigate. A sticky column of
              headings beside "Loading settings…" would offer to jump to sections that do not
              exist yet. */}
          {ready && navEntries.length > 0 && (
            <nav className="settings-nav" aria-label="Settings sections">
              <ul className="settings-nav-list">
                {navEntries.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className={`settings-nav-link ${activeSection === entry.id ? "is-active" : ""}`}
                      aria-current={activeSection === entry.id ? "true" : undefined}
                      onClick={() => jumpTo(entry.id)}
                    >
                      <span className="settings-nav-title">{entry.title}</span>
                      {entry.count !== undefined && <span className="settings-nav-count">{entry.count}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          )}

          <div className="settings-list">
            <p className="settings-scope-note">
              Saved on the server, not in this browser. They apply to every tab, and to turns that run when no tab is
              open.
            </p>

            {error && <div className="settings-error">{error}</div>}

            {/* Only worth showing once there is actually something to load and filter. Rendering
                it over "Loading settings…" would offer to narrow a list that does not exist yet. */}
            {ready && definitions.length > 0 && (
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

            {!ready ? (
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
                <section key={section.id} id={`settings-section-${section.id}`} className="settings-group">
                  <div className="settings-group-head">
                    <h3 className="settings-group-title">{section.title}</h3>
                    <p className="settings-group-blurb">{section.blurb}</p>
                  </div>
                  {defs.map((def) => (
                    <SettingRow
                      key={def.key}
                      def={def}
                      settings={settings!}
                      busy={savingKey === def.key}
                      onSave={save}
                    />
                  ))}
                </section>
              ))
            )}

            {showPanels && ready && (
              <>
                {/* Which CLIs Solace may run, and the login each one is on. First of the panels
                    because it is the one that decides whether anything else here can work at
                    all: an agent on a CLI that was never connected cannot take a turn. */}
                <section id="settings-section-providers" className="settings-section">
                  <h3 className="settings-section-title">{PANEL_SECTIONS[0].title}</h3>
                  <p className="settings-section-note">
                    Connecting a CLI is opting Solace into running it - it is not a scan of what happens to be
                    installed. Several logins of one provider can run at once, each in its own config directory, so a
                    second subscription never signs the first one out. Solace hands you the sign-in command to run
                    yourself; it never performs the login.
                  </p>
                  <ConnectionsPanel sections={["cli", "github", "local-server", "hosted-api"]} variant="page" />
                </section>

                {/* MCP servers live here rather than in the sidebar. They were originally rendered
                    beside Connections, in a 234px rail, where each tile had to fit a title, a
                    paragraph of description, a setup note and an Add button - the text simply ran
                    out of the container. They are configuration, they are read once and rarely
                    changed, and this page has the width to show them properly. */}
                <section id="settings-section-tools" className="settings-section">
                  <h3 className="settings-section-title">{PANEL_SECTIONS[1].title}</h3>
                  <p className="settings-section-note">
                    Extra tools your agents can use - reading a Roblox place, driving a browser, searching a codebase.
                    Each one is registered here and can be turned on per agent, so an agent only sees the tools it
                    needs. They are spawned per turn alongside Solace&apos;s own group-chat bridge; nothing here is
                    written to your CLI&apos;s own config files.
                  </p>
                  <McpPanel agents={agents} />
                </section>

                {/* Keys, SSH deploy targets and vault entries. These were in the sidebar rail,
                    where a saved login had ~104px to render a label AND a service, and an SSH
                    target could not show its host without truncating it. They are configuration
                    you set up once, so they belong on a page with room. */}
                <section id="settings-section-secrets" className="settings-section">
                  <h3 className="settings-section-title">{PANEL_SECTIONS[2].title}</h3>
                  <p className="settings-section-note">
                    SSH deploy targets, service logins and anything else an agent might need to sign in with. Values
                    are never shown in a list or in chat - use Reveal to read one back.
                  </p>
                  <ConnectionsPanel sections={["ssh", "vault"]} variant="page" />
                </section>

                {/* Per-project rosters. Only meaningful while agents follow the user: with the
                    setting off, membership is decided by each agent's own working directory and
                    there is nothing here to choose. */}
                {settings?.agentsFollowProjects && (
                  <section id="settings-section-rosters" className="settings-section">
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
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * One setting row, whatever control it renders as.
 *
 * The control is still chosen from `def.kind` alone, so a new kind is a compile error here
 * rather than a silently unrendered row. What is new is the line under the description saying
 * what the default is and whether this setting is still on it - the cheapest possible answer to
 * "what have I actually changed", which previously required opening the state file.
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
  const atDefault = isDefault(def, settings);
  return (
    <div className={`setting-entry ${def.kind === "select" ? "is-stacked" : ""}`}>
      <div className="setting-entry-text">
        {/* htmlFor only where it points at a real form control. The choice control is a
            radiogroup, which a <label for> cannot address - it names itself by pointing back at
            this id with aria-labelledby instead, so the group is still announced by its label. */}
        <label
          className="setting-entry-label"
          id={`setting-${def.key}-label`}
          htmlFor={def.kind === "select" ? undefined : `setting-${def.key}`}
        >
          {def.label}
        </label>
        <div className="setting-entry-desc">{def.description}</div>
        <div className="setting-entry-meta">
          <span className={`setting-default ${atDefault ? "is-current" : ""}`}>
            {atDefault ? `Default · ${defaultLabel(def)}` : `Changed · default is ${defaultLabel(def)}`}
          </span>
          {!atDefault && (
            <button
              type="button"
              className="setting-reset"
              disabled={busy}
              onClick={() => onSave(def, DEFAULT_APP_SETTINGS[def.key])}
            >
              Reset
            </button>
          )}
        </div>
      </div>
      <div className="setting-entry-control">
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
          <ChoiceControl
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
    </div>
  );
}

/**
 * A number setting: a stepper, the unit it is measured in, and the legal range said out loud.
 *
 * Holds a DRAFT string rather than writing on every keystroke. Typing "120" through a
 * write-per-keystroke input would PATCH "1", then "12", then "120" - and since the server
 * rejects anything outside the range rather than clamping it, the intermediate "1" would be
 * refused and snap the box back mid-word. So: edit freely, save on blur or Enter, revert on
 * Escape. The draft is dropped whenever the saved value changes underneath (another tab), which
 * is the same rule the toggles follow.
 *
 * The − / + buttons are for the common case, which is nudging a limit by one rather than typing
 * a new one. They commit immediately - there is no half-typed state to protect when the value
 * came from a button - and they are disabled AT the bound rather than silently refusing, because
 * a button that does nothing when pressed is indistinguishable from a broken one.
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

  // One press moves by 1 for a small range and by a round 1000 for the character caps, where 1
  // is below the resolution anyone cares about and 12,000 would be 12,000 presses away.
  const step = def.max - def.min > 5000 ? 1000 : 1;
  const nudge = (by: number) => {
    const next = Math.min(def.max, Math.max(def.min, value + by));
    if (next !== value) onCommit(next);
  };

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
      <div className="setting-stepper">
        <button
          type="button"
          className="setting-stepper-btn"
          disabled={busy || value <= def.min}
          aria-label={`Decrease ${def.label} by ${step}`}
          onClick={() => nudge(-step)}
        >
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <path d="M3.5 8h9" />
          </svg>
        </button>
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
        <button
          type="button"
          className="setting-stepper-btn"
          disabled={busy || value >= def.max}
          aria-label={`Increase ${def.label} by ${step}`}
          onClick={() => nudge(step)}
        >
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <path d="M8 3.5v9M3.5 8h9" />
          </svg>
        </button>
      </div>
      <div className="setting-number-meta">
        <span className="setting-number-unit">{def.unit}</span>
        <span className="setting-number-range" id={`setting-${def.key}-range`}>
          {def.min.toLocaleString()}&ndash;{def.max.toLocaleString()}
        </span>
      </div>
    </div>
  );
}

/**
 * A setting with a fixed set of choices, as a radio group rather than a `<select>`.
 *
 * Every option is on screen, which is the point: these are consequential choices ("fully
 * unattended" is one of them) and a closed dropdown shows one of five and hides the rest behind
 * a click. Each option's label is written "Name - what it does", so the name is set in the
 * reading weight and the explanation follows it in the muted one; splitting on that dash is
 * reading the schema's own convention, not parsing arbitrary text - an option without a dash
 * simply renders as a name with nothing after it.
 *
 * A real radiogroup, so arrow keys move between options and a screen reader announces "3 of 5"
 * - the behaviour a native select had and a row of plain buttons would have thrown away.
 * Saves immediately: unlike the number box there is no half-typed state to protect, and every
 * option offered is one the server already accepts.
 */
function ChoiceControl({
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
    <div className="setting-choices" role="radiogroup" aria-labelledby={`setting-${def.key}-label`} id={`setting-${def.key}`}>
      {def.options.map((option) => {
        const [name, ...rest] = option.label.split(" - ");
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            className={`setting-choice ${selected ? "is-selected" : ""}`}
            disabled={busy}
            onClick={() => onCommit(option.value)}
          >
            <span className="setting-choice-dot" aria-hidden="true" />
            <span className="setting-choice-text">
              <span className="setting-choice-name">{name}</span>
              {rest.length > 0 && <span className="setting-choice-note">{rest.join(" - ")}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

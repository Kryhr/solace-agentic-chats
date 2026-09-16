import { useEffect, useState } from "react";
import type {
  AgentConfig,
  AppSettings,
  NumberSettingDefinition,
  ProjectMeta,
  SelectSettingDefinition,
  SettingDefinition,
} from "@solace/shared";
import { fetchSettings, setProjectMembership, updateSettings } from "../api";
import { ProviderIcon } from "./ProviderIcon";

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

          {loading || !settings ? (
            <div className="chat-empty">
              <div className="chat-empty-title">Loading settings…</div>
            </div>
          ) : definitions.length === 0 ? (
            <div className="chat-empty">
              <div className="chat-empty-title">No settings yet</div>
              <div className="chat-empty-body">This server exposes no configurable options.</div>
            </div>
          ) : (
            definitions.map((def) => (
              <div key={def.key} className="setting-entry">
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
                    disabled={savingKey === def.key}
                    onClick={() => void save(def, !settings[def.key])}
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
                    busy={savingKey === def.key}
                    onCommit={(next) => void save(def, next)}
                  />
                ) : (
                  <SelectControl
                    def={def}
                    value={settings[def.key] as string}
                    busy={savingKey === def.key}
                    // The control can only ever emit one of def.options, and sanitizeAppSettings
                    // checks that same list again on the server, so the cast is narrowing a
                    // string TS cannot see is already constrained - not trusting free input.
                    onCommit={(next) => void save(def, next as AppSettings[typeof def.key])}
                  />
                )}
              </div>
            ))
          )}

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

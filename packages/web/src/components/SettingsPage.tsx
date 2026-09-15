import { useEffect, useState } from "react";
import type { AppSettings, SettingDefinition } from "@solace/shared";
import { fetchSettings, updateSettings } from "../api";

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
  onBack,
}: {
  /** The live value, kept in App so a change made in another tab (settings:updated over the
   * socket) updates this page while it is open. */
  settings: AppSettings | null;
  onSettingsChange: (settings: AppSettings) => void;
  onBack: () => void;
}) {
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

  const handleToggle = async (def: SettingDefinition, next: boolean) => {
    if (!settings) return;
    const previous = settings;
    // Optimistic, then corrected by whatever the server actually stored - a toggle that
    // appears to move and then silently does not is worse than one that takes a moment.
    onSettingsChange({ ...settings, [def.key]: next });
    setSavingKey(def.key);
    setError(null);
    try {
      onSettingsChange(await updateSettings({ [def.key]: next }));
    } catch (err) {
      onSettingsChange(previous);
      setError((err as Error).message);
    } finally {
      setSavingKey(null);
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
                <button
                  id={`setting-${def.key}`}
                  type="button"
                  role="switch"
                  aria-checked={settings[def.key]}
                  className="setting-switch"
                  disabled={savingKey === def.key}
                  onClick={() => void handleToggle(def, !settings[def.key])}
                >
                  <span className="setting-switch-track" aria-hidden="true">
                    <span className="setting-switch-thumb" />
                  </span>
                  <span className="setting-switch-state">{settings[def.key] ? "On" : "Off"}</span>
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

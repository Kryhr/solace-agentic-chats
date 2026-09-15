import { sanitizeAppSettings, type AppSettings } from "@solace/shared";

/**
 * The app's own settings, held in memory and written through to .solace-state.json by whoever
 * sets `onChange` (index.ts, the same way ChatStore and AgentManager persist).
 *
 * Tiny on purpose. The value of having a class at all is that there is exactly one object every
 * consumer reads from, so a setting changed in one browser tab takes effect for a turn that is
 * about to start in the server - rather than each consumer holding its own copy taken at boot.
 */
export class SettingsStore {
  private settings: AppSettings;

  /** Set by index.ts, to persist and to broadcast the new values to every tab. */
  onChange: ((settings: AppSettings) => void) | null = null;

  constructor(initial?: unknown) {
    this.settings = sanitizeAppSettings(initial);
  }

  get(): AppSettings {
    return { ...this.settings };
  }

  /**
   * Apply a partial update. The patch is merged onto the current values and then re-sanitized,
   * so a bogus key or a wrong-typed value from an HTTP body can never land in the store - it
   * falls back to the documented default instead of being half-believed.
   */
  update(patch: Partial<AppSettings>): AppSettings {
    this.settings = sanitizeAppSettings({ ...this.settings, ...patch });
    this.onChange?.(this.get());
    return this.get();
  }
}

/**
 * App-level settings: things that change how the SERVER behaves, for every chat and every tab.
 *
 * Deliberately not localStorage. These decide what the server does with an agent's work when
 * nobody is looking at a browser at all, so they have to survive a restart and apply regardless
 * of which tab (or whether any tab) is open. They live in .solace-state.json alongside agents,
 * history and queues - see server/core/persistence.ts.
 *
 * The schema below is the single definition of what a setting IS: its key, its default, the
 * words shown next to it. The server validates against it and the Settings page renders from
 * it, so adding a second setting is one entry in SETTING_DEFINITIONS - not a new route, a new
 * field on three types, and a new block of JSX.
 */

export interface AppSettings {
  /**
   * When an agent's turn fails because its provider is out of usage, hand that exact turn to
   * another agent working in the same directory instead of leaving it to wait for the reset.
   *
   * Off by default, and deliberately so: silently moving work between models changes who did
   * it and how, which is not a thing to do to somebody without being asked.
   */
  handoverOnUsageExhausted: boolean;

  /**
   * Your agents follow you into whatever project you are working in, instead of each agent
   * belonging to exactly one folder forever.
   *
   * On by default. Membership used to be derived purely from an agent's working directory, so
   * creating a project always produced an empty roster and every agent had to be added again -
   * and a chat filed under that project could reach nobody at all. With this on, an agent runs
   * its CLI in whichever project's folder the chat belongs to, and keeps a SEPARATE provider
   * conversation per folder, so switching projects never resumes one project's session inside
   * another's directory.
   *
   * Turning it off restores the old rule: an agent belongs to the project its own working
   * directory sits in, and nowhere else.
   */
  agentsFollowProjects: boolean;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  handoverOnUsageExhausted: false,
  agentsFollowProjects: true,
};

/** What a setting looks like on the Settings page. Only booleans exist so far; `kind` is here
 * so the second setting can be a different control without the page needing to be rebuilt. */
export interface SettingDefinition {
  key: keyof AppSettings;
  kind: "toggle";
  label: string;
  /** The honest explanation, including what the setting does NOT do. Shown under the label. */
  description: string;
}

export const SETTING_DEFINITIONS: SettingDefinition[] = [
  {
    key: "handoverOnUsageExhausted",
    kind: "toggle",
    label: "Hand work over when an agent runs out of usage",
    description:
      "If an agent's provider reports a usage or rate limit, pass that piece of work to another agent " +
      "working in the same directory. Only agents with the same working directory are considered - an " +
      "agent pointed at a different project would do confident work on the wrong codebase. The receiving " +
      "agent runs at its own permission level, every handover is announced in the chat, and work is never " +
      "passed on more than twice. When nobody is eligible, the work waits and says so.",
  },
  {
    key: "agentsFollowProjects",
    kind: "toggle",
    label: "Agents follow you between projects",
    description:
      "Your agents appear in every project instead of belonging to one folder forever, and each one " +
      "works in whichever project's folder the chat belongs to. Each agent keeps a separate memory per " +
      "project, so switching never carries one project's conversation into another's directory. You can " +
      "still remove specific agents from a specific project below. Turn this off and an agent belongs " +
      "only to the project its own working directory is inside - which means a new project starts empty.",
  },
];

/**
 * Coerce anything (an older state file, a hand-edited one, a PATCH body) into a legal
 * AppSettings. Unknown keys are dropped and a wrong-typed value falls back to the default
 * rather than being half-believed - a setting that decides whether work moves between models
 * is not a place to guess at what the user meant.
 */
export function sanitizeAppSettings(value: unknown): AppSettings {
  const raw = (value ?? {}) as Record<string, unknown>;
  const out = { ...DEFAULT_APP_SETTINGS };
  for (const def of SETTING_DEFINITIONS) {
    const incoming = raw[def.key];
    if (def.kind === "toggle" && typeof incoming === "boolean") out[def.key] = incoming;
  }
  return out;
}

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
 * it, so adding a setting is one entry in SETTING_DEFINITIONS - not a new route, a new field on
 * three types, and a new block of JSX.
 *
 * THE RULE for anything added here: a setting must control REAL, EXISTING behaviour, and the
 * place that behaviour lives must read it LIVE (never a copy taken at boot), so a change made
 * in one tab applies to a turn that starts five seconds later. Every default below is the
 * constant the code already used, so a user who never opens this page sees no change at all.
 */

/** The trust levels an agent can run at. Aliased from the real AgentConfig type rather than
 * re-listed here, so the setting's accepted values can never drift from the ones an agent can
 * actually be created with. Type-only, so this import is erased and there is no runtime cycle
 * with index.ts (which re-exports this file). The authoritative runtime check still lives in
 * server/core/validateAgentConfig.ts, which rejects anything outside the list. */
import type { TrustLevel } from "./index";

export type SettingsTrustLevel = TrustLevel;

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

  /**
   * The ceiling on one turn's wall-clock run time, in minutes. Read live in
   * agentManager.drainQueue, which arms the abort timer from it.
   *
   * Default 120 = the old MAX_TURN_MS. Range 5..720: below five minutes the ceiling would start
   * killing ordinary work (a single "build this page" turn is routinely longer), and twelve
   * hours is past the point where an unattended runaway turn is cheaper to stop than to let
   * run. The idle limit below is the one that actually fires in practice; this one only catches
   * a turn that never stops talking.
   */
  maxTurnMinutes: number;

  /**
   * How long a turn may produce NO output at all before it is treated as hung, in minutes.
   * Read live in agentManager.drainQueue, which arms and re-arms the idle timer from it.
   *
   * Default 5 = the old MAX_TURN_IDLE_MS. Range 1..60. This is the check that matters: a
   * working CLI emits constantly, so silence is the real signal of a stuck process. Raise it if
   * a provider you use goes quiet for long stretches mid-thought; below a minute it will start
   * killing healthy turns that are simply waiting on a slow tool.
   */
  turnIdleMinutes: number;

  /**
   * How many times one piece of work may be interrupted by a question and resumed before the
   * app stops and says so. Read live in agentManager.scheduleResume.
   *
   * Default 3 = the old MAX_RESUMES. Range 0..10. Each resume is a real billed turn that
   * re-reads files and re-establishes context, so an agent getting questions faster than it can
   * work would otherwise spend your money making no progress. 0 means work is never resumed
   * after an interrupt - it is abandoned and reported, not silently dropped.
   */
  maxResumes: number;

  /**
   * How many times one piece of work may be passed to a DIFFERENT agent after a usage
   * exhaustion. Read live in agentManager.attemptHandover. Does nothing at all unless
   * "Hand work over when an agent runs out of usage" is on.
   *
   * Default 2 = the old MAX_HANDOVERS. Range 0..5. Every hop is a real billed turn on a fresh
   * agent that has to re-read the files first, and agents on the same account share one real
   * limit, so "everybody is exhausted" is the normal case rather than the exotic one.
   */
  maxHandovers: number;

  /**
   * How many mid-turn group posts one turn may make, before it has to save the rest for its
   * final answer. Read live in agentManager.postFromCurrentTurn.
   *
   * Default 8 = the old MAX_MID_TURN_POSTS. Range 0..50. Every post can enqueue a real, billed
   * turn for another agent, so an agent that decides to narrate its whole working into the
   * group spends your money doing it. 0 stops mid-turn posting entirely: agents then only speak
   * in their final answers, which is quieter and cheaper but removes live coordination.
   */
  maxMidTurnPosts: number;

  /**
   * How long your question waits for the running turn to pick it up cooperatively before that
   * turn is killed to answer it, in seconds. Read live in agentManager.armInterruptTimer.
   *
   * Default 50 = the old INTERRUPT_GRACE_MS. Range 5..600. Longer than the gap between two tool
   * calls of a working agent (seconds) and shorter than a human's patience. Raising it means
   * fewer destroyed turns and slower answers; lowering it means the opposite. Only YOUR
   * questions can do this - an agent's question never kills another agent's turn, because doing
   * so starves the very answer it is asking for.
   */
  interruptGraceSeconds: number;

  /**
   * Which trust level a NEWLY added agent starts on, in the Add agent form.
   *
   * Default "bypassPermissions" = what the form already preselected. This is a starting point
   * for the dropdown, nothing more: it does NOT change any agent that already exists, and it is
   * not a cap - you can still pick any level for any agent, before or after creating it. If the
   * provider you pick does not support this level, the form falls back to that provider's first
   * supported one rather than sending something the CLI would reject.
   */
  defaultTrustLevel: SettingsTrustLevel;

  /**
   * How many agent-to-agent @mention hops are allowed before a chain is cut off. Read live in
   * agentManager.routeChatMessage.
   *
   * Default 6 = the old MAX_MENTION_CHAIN_DEPTH. Range 0..20. Two agents mentioning each other
   * back and forth is legitimate collaboration, not a bug, but with no cap it has no natural
   * stopping point and every hop is a real billed turn. 0 means an agent may never trigger
   * another agent at all: your own message still reaches everyone in the chat, but an agent's
   * answer stops there.
   *
   * A previous pass deliberately left this hardcoded because a cut-off chain was INVISIBLE: the
   * system notice that announces the cut-off could never fire (see announcesChainCutoff in
   * agentManager.ts - depth reaches that check in steps of TWO, so the old `=== cap + 1` test
   * never matched, not even at the default). That is fixed alongside this setting, because a cap
   * a user can lower without ever being told when it bites is a cap that makes work vanish
   * silently.
   */
  maxMentionChainDepth: number;

  /**
   * How long a running turn is protected from ANOTHER AGENT's question before it is stopped to
   * answer it, in minutes. Read live in agentManager.armInterruptTimer.
   *
   * Default 4 = the old AGENT_QUESTION_GRACE_MS. Range 1..60. Deliberately far longer than the
   * grace your own questions get: an agent's question is rarely worth destroying a half-finished
   * piece of work over, but leaving it unanswered for a whole long build leaves the asker
   * blocked. Both extremes were observed live and both were wrong - at ~50s one agent was killed
   * four times in a row and finished nothing; with no interrupt at all it worked straight through
   * eight @mentions while the others sat blocked. Still capped at ONE agent interruption per
   * turn whatever the value, which is what keeps it an interruption rather than a livelock.
   */
  agentQuestionGraceMinutes: number;

  /**
   * Whether an agent's reasoning and tool-use lines also appear in the GROUP chat during a
   * group-triggered turn, instead of only in that agent's own hub. Read live in
   * agentManager.drainQueue, at the moment each line is posted.
   *
   * Off by default, which is exactly today's behaviour: group chat is a coordination channel
   * that shows final answers, and the full working stays in the hub where it does not bury
   * everyone else's messages. Turning it on duplicates those lines into the group as they
   * happen; the hub keeps the complete record either way. Only affects turns triggered from a
   * group chat - a turn you started in an agent's hub already shows you everything.
   */
  showAgentWorkInGroupChat: boolean;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  handoverOnUsageExhausted: false,
  agentsFollowProjects: true,
  // Each number below is exactly the constant agentManager.ts used before it was configurable,
  // so nothing changes behaviour for someone who never opens Settings.
  maxTurnMinutes: 120,
  turnIdleMinutes: 5,
  maxResumes: 3,
  maxHandovers: 2,
  maxMidTurnPosts: 8,
  interruptGraceSeconds: 50,
  defaultTrustLevel: "bypassPermissions",
  maxMentionChainDepth: 6,
  agentQuestionGraceMinutes: 4,
  // No constant to match: this one is new behaviour rather than a constant made configurable.
  // false IS the old behaviour - working went only to the agent's own hub - so the "nothing
  // changes for someone who never opens Settings" promise holds here too.
  showAgentWorkInGroupChat: false,
};

/**
 * The headings the Settings page is grouped under, in the order they are shown.
 *
 * A flat list of nine settings was already hard to scan and the list only grows. Grouping is
 * kept in the schema rather than in the page so that adding a setting stays ONE array entry:
 * the entry names its section, and the page renders whatever sections turn out to be non-empty.
 * A section with no settings in it is not rendered at all, so an empty heading can never appear.
 */
export type SettingSectionId = "turns" | "collaboration" | "projects" | "appearance";

export interface SettingSection {
  id: SettingSectionId;
  title: string;
  /** One line under the heading saying what the group is about. Not a repeat of the settings. */
  blurb: string;
}

export const SETTING_SECTIONS: SettingSection[] = [
  {
    id: "turns",
    title: "Agents & turns",
    blurb: "When a single turn is stopped, resumed or given up on, and what a new agent starts as.",
  },
  {
    id: "collaboration",
    title: "Collaboration",
    blurb: "What agents are allowed to do to each other's work: interrupt it, chain off it, take it over.",
  },
  {
    id: "projects",
    title: "Projects",
    blurb: "Which agents belong to which folder, and whether that follows you around.",
  },
  {
    id: "appearance",
    title: "Appearance",
    blurb: "What the group chat shows. These change what is displayed, not what agents actually do.",
  },
];

/** Fields every setting has, whatever control it renders as. */
interface BaseSettingDefinition {
  key: keyof AppSettings;
  /** Which heading this setting is filed under. A value not in SETTING_SECTIONS would render
   * nowhere at all, which is why settings.test.ts pins every section id against that list. */
  section: SettingSectionId;
  label: string;
  /** The honest explanation, including what the setting does NOT do. Shown under the label. */
  description: string;
}

export interface ToggleSettingDefinition extends BaseSettingDefinition {
  kind: "toggle";
}

export interface NumberSettingDefinition extends BaseSettingDefinition {
  kind: "number";
  /** Inclusive. A value outside [min, max] is REJECTED, not clamped - see sanitizeAppSettings. */
  min: number;
  max: number;
  /** The word shown after the box ("minutes", "seconds", "posts per turn"). */
  unit: string;
}

export interface SelectSettingDefinition extends BaseSettingDefinition {
  kind: "select";
  /** The only accepted values. Anything else falls back to the default. */
  options: { value: string; label: string }[];
}

/** What a setting looks like on the Settings page. A discriminated union so the page can render
 * each control from the schema alone, and so a new kind is a compile error everywhere it has to
 * be handled rather than a silently unrendered row. */
export type SettingDefinition = ToggleSettingDefinition | NumberSettingDefinition | SelectSettingDefinition;

export const SETTING_DEFINITIONS: SettingDefinition[] = [
  {
    key: "handoverOnUsageExhausted",
    section: "collaboration",
    kind: "toggle",
    label: "Hand work over when an agent runs out of usage",
    description:
      "If an agent's provider reports a usage or rate limit, pass that piece of work to another agent " +
      "working in the same directory. Only agents with the same working directory are considered - an " +
      "agent pointed at a different project would do confident work on the wrong codebase. The receiving " +
      "agent runs at its own permission level, every handover is announced in the chat, and how many times " +
      "work may be passed on is set below. When nobody is eligible, the work waits and says so.",
  },
  {
    key: "agentsFollowProjects",
    section: "projects",
    kind: "toggle",
    label: "Agents follow you between projects",
    description:
      "Your agents appear in every project instead of belonging to one folder forever, and each one " +
      "works in whichever project's folder the chat belongs to. Each agent keeps a separate memory per " +
      "project, so switching never carries one project's conversation into another's directory. You can " +
      "still remove specific agents from a specific project below. Turn this off and an agent belongs " +
      "only to the project its own working directory is inside - which means a new project starts empty.",
  },
  {
    key: "turnIdleMinutes",
    section: "turns",
    kind: "number",
    min: 1,
    max: 60,
    unit: "minutes of silence",
    label: "Give up on a turn that has gone quiet",
    description:
      "How long a turn may produce no output at all before it is treated as stuck and stopped. This is " +
      "the limit that actually fires: a working CLI emits text, tool calls and usage constantly, so " +
      "silence is the real signal of a hung process, and any output at all resets the clock. It does not " +
      "measure how long the turn has run in total - that is the next setting. A turn stopped this way is " +
      "reported as stopped by this app, never disguised as a provider failure, and keeps its Retry button.",
  },
  {
    key: "maxTurnMinutes",
    section: "turns",
    kind: "number",
    min: 5,
    max: 720,
    unit: "minutes",
    label: "Maximum length of one turn",
    description:
      "The hard ceiling on a single turn's run time, however much it is still producing. This only " +
      "catches a turn that never stops talking; a genuinely stuck one is caught far sooner by the silence " +
      "limit above. A turn resumed after an interruption inherits whatever is LEFT of this budget rather " +
      "than a fresh one - otherwise an agent interrupted every ten minutes would never time out at all - " +
      "with a one-minute floor so a nearly-exhausted resume is not killed on arrival.",
  },
  {
    key: "interruptGraceSeconds",
    section: "turns",
    kind: "number",
    min: 5,
    max: 600,
    unit: "seconds",
    label: "How long a question waits before it interrupts a turn",
    description:
      "When you ask something while an agent is working, it first gets this long to pick the question up " +
      "on its own between tool calls, which costs nothing. Only if that window passes is the turn killed " +
      "and resumed afterwards, which costs a real billed turn. Applies only to YOUR questions: an agent's " +
      "question never kills another agent's turn, because that starves the answer it is waiting for. " +
      "Raising it means fewer destroyed turns and slower answers; lowering it means the reverse.",
  },
  {
    key: "maxResumes",
    section: "turns",
    kind: "number",
    min: 0,
    max: 10,
    unit: "times",
    label: "How often work may be interrupted and resumed",
    description:
      "After this many interruptions, the app stops resuming a piece of work and says exactly what was " +
      "abandoned instead of quietly dropping it - the Retry button still runs it again from the start. " +
      "Each resume is a real billed turn that has to re-read files and rebuild context, so an agent " +
      "getting questions faster than it can work would otherwise make no progress at all. Work is also " +
      "abandoned once it has used the full turn budget above, whichever comes first. Set 0 to never resume.",
  },
  {
    key: "maxHandovers",
    section: "collaboration",
    kind: "number",
    min: 0,
    max: 5,
    unit: "times",
    label: "How often work may be handed to another agent",
    description:
      "Only has any effect while handover on exhausted usage is on, above. Each hop is a real billed turn " +
      "on a fresh agent that must re-read the files first, and agents sharing one account share one real " +
      "limit, so everybody being exhausted is the normal case. Once the limit is reached the work is left " +
      "unfinished and said so, with the reset time when the provider gave one. Set 0 and handover is " +
      "announced as declined every time, which is a slower way of turning the feature off.",
  },
  {
    key: "maxMidTurnPosts",
    section: "collaboration",
    kind: "number",
    min: 0,
    max: 50,
    unit: "posts per turn",
    label: "Mid-turn group posts one turn may make",
    description:
      "An agent can post into the group while it is still working, to announce what it is starting or hand " +
      "work off. Every such post can enqueue a real, billed turn for another agent, so this caps how much " +
      "one turn can spend narrating. Past the cap the agent is told it was refused rather than believing " +
      "it spoke - a silent drop would leave it acting on a message nobody received. The budget resets for " +
      "each turn, including a resumed one. Set 0 and agents only speak in their final answers.",
  },
  {
    key: "defaultTrustLevel",
    section: "turns",
    kind: "select",
    options: [
      { value: "plan", label: "Plan - propose, change nothing" },
      { value: "manual", label: "Manual - ask before every change" },
      { value: "acceptEdits", label: "Accept edits - auto-accept file edits" },
      { value: "bypassPermissions", label: "Bypass permissions - fully unattended" },
      { value: "auto", label: "Auto - decide for itself" },
    ],
    label: "Trust level a new agent starts on",
    description:
      "Which option the Add agent form preselects. It is a starting point, not a cap: you can still pick " +
      "any level for any agent, and changing this never touches an agent that already exists. If the " +
      "provider you pick does not offer this level, the form falls back to that provider's first supported " +
      "one rather than sending something its CLI would reject.",
  },
  {
    key: "maxMentionChainDepth",
    section: "collaboration",
    kind: "number",
    min: 0,
    max: 20,
    unit: "hops",
    label: "How far an agent-to-agent reply chain may run",
    description:
      "Two agents @mentioning each other back and forth is real collaboration, but with no cap it has no " +
      "natural stopping point, and every hop is a real billed turn. Past this many hops the chain is cut " +
      "off and the chat is told so by name, so work never just stops without explanation. Your own messages " +
      "are never affected - the count starts fresh each time you post. Set 0 and agents never trigger each " +
      "other at all: your message still reaches everyone in the chat, but their answers stop there.",
  },
  {
    key: "agentQuestionGraceMinutes",
    section: "collaboration",
    kind: "number",
    min: 1,
    max: 60,
    unit: "minutes",
    label: "How long a turn is protected from another agent's question",
    description:
      "When one agent asks a busy agent something, the busy one gets this long to finish what it is doing " +
      "before its turn is stopped to answer. Much longer than the grace YOUR questions get, on purpose: an " +
      "agent's question is rarely worth destroying a half-finished piece of work over, but leaving it for a " +
      "whole long build leaves the asker blocked. However you set it, a turn can be interrupted by agents " +
      "at most once - a second pile-up waits for the turn that answers the first, which is what stops two " +
      "agents from killing each other's work in a loop.",
  },
  {
    key: "showAgentWorkInGroupChat",
    section: "appearance",
    kind: "toggle",
    label: "Show agents' working in the group chat",
    description:
      "Group chat normally shows an agent's final answer, while its reasoning and tool-use lines go to that " +
      "agent's own hub as they happen. Turn this on to have those lines appear in the group as well. The " +
      "hub keeps the complete record either way, so this adds detail rather than moving it - with several " +
      "agents working at once it will bury the messages people actually write to each other. Affects only " +
      "turns triggered from a group chat; a turn you start in an agent's hub already shows you everything.",
  },
];

/**
 * Coerce anything (an older state file, a hand-edited one, a PATCH body) into a legal
 * AppSettings. Unknown keys are dropped and a wrong-typed value falls back to the default
 * rather than being half-believed - a setting that decides whether work moves between models
 * is not a place to guess at what the user meant.
 *
 * Numbers are REJECTED rather than clamped when out of range, for the same reason. Clamping
 * "0.1" up to 1 or "99999" down to 720 is guessing: the only thing we actually know about such
 * a value is that whoever produced it was not talking about this setting. A fractional value
 * IS rounded, because "2.5 minutes" is an unambiguous intent that the underlying timer simply
 * expresses in whole units - and it is rounded BEFORE the range check, so rounding can never
 * push a legal value outside its own bounds.
 */
export function sanitizeAppSettings(value: unknown): AppSettings {
  const raw = (value ?? {}) as Record<string, unknown>;
  const out = { ...DEFAULT_APP_SETTINGS };
  // Writing through a widened view: the union of value types means TS cannot prove that the
  // branch matching `def.kind` produces the type of `out[def.key]`. The SETTING_DEFINITIONS
  // entry and the AppSettings field are written together, and the tests pin the pairing.
  const write = out as Record<string, unknown>;
  for (const def of SETTING_DEFINITIONS) {
    const incoming = raw[def.key];
    if (def.kind === "toggle") {
      if (typeof incoming === "boolean") write[def.key] = incoming;
    } else if (def.kind === "number") {
      // NaN and Infinity are excluded by isFinite before rounding; a numeric string is not a
      // number and is not coerced, matching how the boolean path refuses "true".
      if (typeof incoming !== "number" || !Number.isFinite(incoming)) continue;
      const rounded = Math.round(incoming);
      if (rounded >= def.min && rounded <= def.max) write[def.key] = rounded;
    } else {
      if (typeof incoming === "string" && def.options.some((o) => o.value === incoming)) {
        write[def.key] = incoming;
      }
    }
  }
  return out;
}

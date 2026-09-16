import type { CliProviderId } from "@solace/shared";
import { INSTALL_COMMAND } from "./providerStatus";

/**
 * Which coding-agent CLIs the user has actually CONNECTED.
 *
 * The distinction this file exists for: **installed is not connected.** Having `gemini` on
 * your PATH is a fact about your machine; wanting Solace to treat Gemini as one of your agent
 * providers is a decision. The Connections panel used to conflate the two - it listed a row
 * for every binary it found - so a developer with six CLIs installed got six rows in a sidebar
 * where they thought of exactly three as theirs.
 *
 * So connection is an explicit, persisted opt-in list, and the sidebar renders from that list
 * and nothing else. Three consequences worth stating, because each was a bug in the old model:
 *
 *  - A state file written before this existed has no such list. That reads as NONE connected,
 *    never as "all of them" - see sanitizeConnectedProviders. Defaulting to all would silently
 *    re-create exactly the behaviour being removed, on precisely the machines that already had
 *    the problem.
 *  - Connecting is gated on a real check. ConnectedProviderStore cannot add a provider on its
 *    own; index.ts runs `<bin> --version` first and only calls `connect` if that passed. This
 *    module deliberately has no access to the probe, so there is no path through it that marks
 *    something connected without something having been run.
 *  - Disconnecting removes it from this list and nothing else. No binary is uninstalled, no
 *    credential is touched, and nothing is signed out - which is what the UI has to say.
 */

/**
 * The providers a user can connect, with the real command that signs each one in.
 *
 * `signInCommand` is the SIGN-IN command, not the install command - those are two different
 * steps and showing the npm line to somebody who already has the binary tells them nothing.
 * Every one of these was read off that CLI's own `--help` on this machine on 2026-09-16; the
 * `signInSource` field records which invocation, so a future reader can re-run it rather than
 * trust this file. Where a CLI has no sign-in subcommand at all, that is stated as the fact it
 * is ("start it and sign in from the session"), never dressed up as a command that does not
 * exist.
 */
export interface ConnectableProvider {
  provider: CliProviderId;
  /** How the provider is named in the UI. Matches ProviderIcon's providerLabel. */
  name: string;
  /** One line: what this thing actually is, in the user's terms. */
  blurb: string;
  /** The literal sign-in command to run in a terminal, or undefined when there isn't one. */
  signInCommand?: string;
  /** What to do when there is no sign-in command - rendered instead of a fake one. */
  signInNote?: string;
  /** Where signInCommand / signInNote came from, shown so "verified" is checkable. */
  signInSource: string;
  /** The real command that puts the binary on PATH, for the refusal message and the card. */
  installCommand: string;
  /**
   * A limitation the user should know BEFORE connecting - not a disclaimer, a fact about what
   * this provider cannot do in this app. Shown on the card. Left undefined when a provider has
   * no such caveat, so its presence means something.
   */
  caveat?: string;
}

export const CONNECTABLE_PROVIDERS: ConnectableProvider[] = [
  {
    provider: "claude-code",
    name: "Claude Code",
    blurb: "Anthropic's terminal agent, running on your Claude subscription or API key.",
    // `claude auth` is a real top-level command; `claude auth --help` lists login/logout/status.
    signInCommand: "claude auth login",
    signInSource: "`claude auth --help` on 2026-09-16 lists login, logout and status",
    installCommand: INSTALL_COMMAND["claude-code"],
  },
  {
    provider: "codex-cli",
    name: "Codex CLI",
    blurb: "OpenAI's terminal agent, running on your ChatGPT plan or API key.",
    // Listed under Commands in `codex --help` as "login  Manage login".
    signInCommand: "codex login",
    signInSource: "`codex --help` on 2026-09-16 lists login and logout as commands",
    installCommand: INSTALL_COMMAND["codex-cli"],
  },
  {
    provider: "copilot-cli",
    name: "GitHub Copilot CLI",
    blurb: "GitHub's terminal agent, running on your Copilot subscription.",
    // "login  Authenticate with Copilot" under Commands in `copilot --help`.
    signInCommand: "copilot login",
    signInSource: "`copilot --help` on 2026-09-16 lists login under Commands",
    installCommand: INSTALL_COMMAND["copilot-cli"],
  },
  {
    provider: "gemini-cli",
    name: "Gemini CLI",
    blurb: "Google's terminal agent, running on your Google account or an AI Studio key.",
    // No auth/login subcommand exists: `gemini --help` lists only mcp, extensions, skills,
    // hooks and gemma. So there is no command to print, and inventing one would be worse than
    // saying what actually happens.
    signInNote: "No sign-in subcommand: run gemini and sign in from the session it opens.",
    signInSource: "`gemini --help` on 2026-09-16 lists no auth or login command",
    installCommand: INSTALL_COMMAND["gemini-cli"],
  },
  {
    provider: "qwen-code",
    name: "Qwen Code",
    blurb: "Alibaba's terminal agent, running on a Qwen account or an OpenAI-compatible key.",
    // `qwen --help` does list `qwen auth`, but labels it "Configure authentication (removed)" -
    // so printing `qwen auth` as the sign-in command would be printing a command that no
    // longer does the thing.
    signInNote: "qwen auth is marked removed in its own help: run qwen and sign in from the session.",
    signInSource: '`qwen --help` on 2026-09-16 shows "qwen auth  Configure authentication (removed)"',
    installCommand: INSTALL_COMMAND["qwen-code"],
  },
  {
    provider: "opencode",
    name: "OpenCode",
    blurb: "An open-source terminal agent that brings its own provider and key.",
    // `opencode auth --help` (auth is an alias of providers) lists list/login/logout.
    signInCommand: "opencode auth login",
    signInSource: "`opencode auth --help` on 2026-09-16 lists list, login and logout",
    installCommand: INSTALL_COMMAND.opencode,
  },
  {
    provider: "crush",
    name: "Crush",
    blurb: "Charm's terminal agent, bringing whichever provider you configure it with.",
    // `crush login` exists but covers only hyper/copilot/openai; every other provider is set up
    // by running `crush` once, which is what Crush's own signed-out error says to do.
    signInNote: "crush login covers only hyper, copilot and openai: run crush once to set up any other provider.",
    signInSource: "`crush --help` on 2026-09-16, against the real v0.95.0 binary",
    installCommand: INSTALL_COMMAND.crush,
    caveat: "No live streaming: `crush run` prints only the final answer, so tool calls and usage are replayed after the turn ends rather than as they happen.",
  },
  {
    provider: "continue",
    name: "Continue",
    blurb: "The Continue CLI (cn), running whichever model your ~/.continue/config.yaml names.",
    signInNote: "No login subcommand: run cn once and it walks through configuring a model.",
    signInSource: "`cn --help` on 2026-09-16, against the real binary",
    installCommand: INSTALL_COMMAND.continue,
    caveat: "The model comes from your config.yaml and cannot be chosen here: --model is silently ignored for anything already configured.",
  },
  {
    provider: "droid",
    name: "Droid",
    blurb: "Factory's terminal agent. Paid only - there is no free tier.",
    signInNote: "Run droid once and sign in from the session with /login, or set FACTORY_API_KEY.",
    signInSource: "`droid --help` and `droid doctor` on 2026-09-16",
    installCommand: INSTALL_COMMAND.droid,
    caveat: "Never signed in on this machine, so no Solace turn has ever completed against it. It also cannot call back into the group chat: the MCP bridge could not be registered.",
  },
  {
    provider: "kilo",
    name: "Kilo",
    blurb: "Kilo Code's terminal agent, a fork of OpenCode with its own model routing.",
    // `kilo auth list` and `kilo auth login` are both real subcommands.
    signInCommand: "kilo auth login",
    signInSource: "`kilo auth --help` on 2026-09-16 lists list, login and logout",
    installCommand: INSTALL_COMMAND.kilo,
    caveat: "Never signed in on this machine, so no Solace turn has ever completed against it.",
  },
  {
    provider: "kimi",
    name: "Kimi Code",
    blurb: "Moonshot's terminal agent, running on a Kimi account.",
    signInCommand: "kimi login",
    signInSource: "`kimi --help` on 2026-09-16 lists login",
    installCommand: INSTALL_COMMAND.kimi,
    caveat: "The most limited provider here: it auto-approves every action (no plan or ask mode exists headlessly), reports no usage or cost, cannot call back into the group chat, and takes its prompt on the command line - so a long conversation is refused before it starts.",
  },
];

const KNOWN: ReadonlySet<string> = new Set(CONNECTABLE_PROVIDERS.map((p) => p.provider));

export function isConnectableProvider(id: string): id is CliProviderId {
  return KNOWN.has(id);
}

export function connectableProvider(id: CliProviderId): ConnectableProvider | undefined {
  return CONNECTABLE_PROVIDERS.find((p) => p.provider === id);
}

/**
 * Read the persisted list off whatever was on disk.
 *
 * `undefined` - the shape every state file written before this feature has - must come back as
 * an EMPTY list. That is the single most important line in this module: the alternative
 * ("no list means they had them all") would hand every existing user back the wall of rows
 * this change removes, and would do it silently, on upgrade.
 *
 * Anything else that is not a known CLI provider id is dropped rather than carried: a
 * hand-edited file naming "custom" or a provider that no longer exists must not produce a
 * sidebar row with no adapter behind it.
 */
export function sanitizeConnectedProviders(value: unknown): CliProviderId[] {
  if (!Array.isArray(value)) return [];
  const out: CliProviderId[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !isConnectableProvider(entry)) continue;
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

/**
 * The connected list, held in memory and written through to .solace-state.json by whoever sets
 * `onChange` - the same shape SettingsStore and McpServerStore use, so index.ts persists all
 * three the same way.
 *
 * Order is insertion order, not the catalogue's order: the sidebar then reads as a history of
 * what the user connected rather than as a ranking this app invented.
 */
export class ConnectedProviderStore {
  private connected: CliProviderId[];

  /** Set by index.ts, to persist. */
  onChange: (() => void) | null = null;

  constructor(initial?: unknown) {
    this.connected = sanitizeConnectedProviders(initial);
  }

  list(): CliProviderId[] {
    return [...this.connected];
  }

  isConnected(provider: CliProviderId): boolean {
    return this.connected.includes(provider);
  }

  /**
   * Add a provider to the list. The CALLER is responsible for having just verified it - see
   * the route in index.ts, which runs checkCliProvider and only reaches this on a pass.
   *
   * Returns false when it was already there, so the route can say "already connected" rather
   * than reporting a second connection that did not happen.
   */
  connect(provider: CliProviderId): boolean {
    if (this.connected.includes(provider)) return false;
    this.connected.push(provider);
    this.onChange?.();
    return true;
  }

  /** Remove it from the list. Nothing is uninstalled and nothing is signed out. */
  disconnect(provider: CliProviderId): boolean {
    const next = this.connected.filter((p) => p !== provider);
    if (next.length === this.connected.length) return false;
    this.connected = next;
    this.onChange?.();
    return true;
  }
}

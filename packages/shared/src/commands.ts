/**
 * Every slash command, defined once.
 *
 * This exists because it was previously defined twice: HELP_TEXT in server/core/commands.ts and
 * a hand-written SLASH_COMMANDS array in web/components/Composer.tsx. They drifted, and the
 * drift was silent in the worst possible way - `/trust` was implemented on the server and
 * absent from the client list, so typing it matched nothing and the autocomplete menu simply
 * never appeared. The command worked; there was just no way to discover it existed. `/agents`,
 * `/save`, `/vault` and `/deploy` were missing the same way.
 *
 * The server renders /help from this, and the composer's autocomplete filters it. Adding a
 * command is one entry here.
 */
export interface CommandDefinition {
  /** Without the leading slash. */
  name: string;
  /** The argument shape, shown greyed next to the name. Empty when it takes none. */
  hint: string;
  /** One line, shown in /help and as the menu row's description. */
  help: string;
  /**
   * "hub" commands only work from an agent's own hub page, "chat" only in a chat, "both"
   * anywhere. The menu uses this to avoid offering something that will only answer with a
   * refusal in the place the user is typing.
   */
  scope: "hub" | "chat" | "both";
}

export const COMMAND_DEFINITIONS: CommandDefinition[] = [
  { name: "task", hint: "@handle <description>", help: "set that agent's current task", scope: "both" },
  { name: "status", hint: "", help: "summarize every agent's state, model, and task", scope: "both" },
  { name: "agents", hint: "", help: "who's here: provider, model, trust level and working directory", scope: "both" },
  { name: "trust", hint: "<level> [@handle]", help: "set the permission mode for every agent at once, or just one", scope: "both" },
  { name: "usage", hint: "", help: "real rate-limit usage each provider has actually reported", scope: "both" },
  { name: "save", hint: "", help: "save a copy of this chat to Saved chats, without clearing it", scope: "chat" },
  { name: "clear", hint: "", help: "archive this channel's history (nothing is deleted - see Saved chats)", scope: "both" },
  { name: "vault", hint: "", help: "list what's saved in the vault by name (values are never shown in chat)", scope: "both" },
  { name: "github", hint: "status | init <repo-name>", help: "check gh auth, or ask an agent to init + push a repo", scope: "both" },
  { name: "deploy", hint: "list | <target> [what to do]", help: "show SSH deploy targets, or hand one to an agent", scope: "both" },
  { name: "model", hint: "<value>", help: "switch its model (from an agent's own hub)", scope: "hub" },
  { name: "effort", hint: "<value>", help: "switch its thinking effort (from an agent's own hub)", scope: "hub" },
  { name: "reset", hint: "", help: "forget its session so the next turn starts fresh (from an agent's own hub)", scope: "hub" },
  { name: "help", hint: "", help: "show this list", scope: "both" },
];

/** The /help body, built from the same definitions the autocomplete offers. */
export function helpText(): string {
  return COMMAND_DEFINITIONS.map((c) => `/${c.name}${c.hint ? ` ${c.hint}` : ""} - ${c.help}`).join("\n");
}

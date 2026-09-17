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
  // The coordination board is per chat (see CoordinationBoard's own note on why), so there is
  // no such thing as "the board" from inside one agent's hub - hence chat-only rather than a
  // command the menu offers everywhere and that then refuses half the time.
  { name: "board", hint: "", help: "the coordination board: file claims, contracts, and who is blocked on what", scope: "chat" },
  { name: "stop", hint: "[@handle]", help: "stop whatever an agent is doing right now", scope: "both" },
  { name: "retry", hint: "[@handle]", help: "re-run the turn that last failed, exactly as it was", scope: "both" },
  { name: "providers", hint: "", help: "which coding-agent CLIs are really installed, with the version each one printed", scope: "both" },
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

  // --- v1.5: saying what a message IS, rather than letting the room guess -------------------
  // Everything above routes identically: an FYI, a question and a status line all land in the
  // same stream at the same weight and all cost every addressed agent a real turn. These two
  // let the sender say which it is.
  { name: "ask", hint: "@handle <question>", help: "ask one agent a question - it interrupts their turn after the usual grace", scope: "chat" },
  { name: "fyi", hint: "<text>", help: "context for everyone that costs nobody a turn", scope: "chat" },

  // --- v1.5: the task board --------------------------------------------------------------
  { name: "assign", hint: "@handle <task>", help: "put a task on the board, owned by that agent", scope: "chat" },
  { name: "tasks", hint: "", help: "the task board for this chat: who owns what, and what is still open", scope: "chat" },
  { name: "done", hint: "<id>", help: "mark a task on the board finished", scope: "chat" },
  { name: "unassign", hint: "<id>", help: "take a task off its owner, leaving it open", scope: "chat" },

  // --- v1.5: scope you can see -------------------------------------------------------------
  // Scope today is INFERRED from the @mentions on your last message, which is invisible: there
  // is no way to see what it currently is, and no way to set it without addressing somebody.
  { name: "only", hint: "@a [@b ...]", help: "scope this chat to these agents until you clear it", scope: "chat" },
  { name: "all", hint: "", help: "clear the scope - every agent in this chat is reachable again", scope: "chat" },

  // --- v1.5: holding an agent back without removing it -------------------------------------
  { name: "mute", hint: "@handle", help: "stop routing messages to an agent, without removing it from the chat", scope: "both" },
  { name: "unmute", hint: "@handle", help: "route to a muted agent again", scope: "both" },
  { name: "pause", hint: "@handle", help: "hold an agent's queue - work piles up instead of running", scope: "both" },
  { name: "resume", hint: "@handle", help: "let a paused agent work through its queue again", scope: "both" },
  { name: "interrupt", hint: "@handle <message>", help: "stop an agent's turn right now for this message - no grace period", scope: "both" },

  // --- v1.5: the port and server registry --------------------------------------------------
  { name: "servers", hint: "[kill <id>]", help: "servers agents have started, and stop one", scope: "both" },
  { name: "ports", hint: "", help: "which port is reserved by whom", scope: "both" },

  // --- v1.5: server-derived facts, never a model summary -----------------------------------
  { name: "who", hint: "<file>", help: "who has claimed a file, and what they said they were doing to it", scope: "chat" },
  { name: "summary", hint: "", help: "what has actually happened in this chat: files touched, tests run, servers started", scope: "chat" },
  { name: "diff", hint: "[stat]", help: "git diff of this chat's project since the chat was created", scope: "both" },

  // --- v1.5: where status lines go ---------------------------------------------------------
  { name: "quiet", hint: "", help: "send status messages to each agent's hub only, not the group", scope: "chat" },
  { name: "loud", hint: "", help: "put status messages back in the group", scope: "chat" },

  // --- v1.5: multi-account -----------------------------------------------------------------
  { name: "accounts", hint: "[@handle <label>]", help: "which login each agent is on, and switch one to another account", scope: "both" },

  { name: "help", hint: "", help: "show this list", scope: "both" },
];

/** The /help body, built from the same definitions the autocomplete offers. */
export function helpText(): string {
  return COMMAND_DEFINITIONS.map((c) => `/${c.name}${c.hint ? ` ${c.hint}` : ""} - ${c.help}`).join("\n");
}

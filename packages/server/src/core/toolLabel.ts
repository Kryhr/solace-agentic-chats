import type { ToolCallSummary } from "@solace/shared";

/**
 * Turns one provider-reported tool call into a short human label.
 *
 * The hub used to print `_used Read({"file_path":"C:\\...\\styles.css"})_` for every call, so a
 * turn that touched a dozen files buried the agent's actual answer under a dozen lines of JSON.
 * This produces "Reading styles.css" instead.
 *
 * The honesty rule this file exists to enforce: a label is derived *mechanically* from the real
 * tool name and the real arguments the provider sent, by the fixed table below. Nothing here
 * describes an OUTCOME ("fixed the bug", "all resolved") - only the action the provider said it
 * was taking, in fewer words. When a tool isn't in the table the label is the provider's own
 * tool name, humanised; it is never a guess about what that tool probably does.
 *
 * Providers disagree on names for the same action (Claude Code's `Read` is Gemini's `read_file`
 * is Codex's `command_execution` running `cat`), so the table is keyed by the lowercased name
 * and covers every provider's vocabulary in one place.
 */

/** Cap on how much of a captured command output is carried into chat history.
 * Truncation is always announced in the text itself - see `clip`. Argument values are NOT
 * clipped: the old `_used name({...})_` line stored them in full and nothing should silently
 * carry less detail than it used to. */
const MAX_OUTPUT_CHARS = 4000;

function clip(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…(truncated, ${text.length - max} more characters)`;
}

/** Last path segment, for either separator - provider tool arguments carry absolute paths and
 * the directory is almost never the interesting part of "which file is it touching". */
export function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

/** First present string-valued key, so one lookup covers providers that spell the same
 * argument differently (`file_path` / `absolute_path` / `path`). */
function str(input: unknown, ...keys: string[]): string | undefined {
  const rec = asRecord(input);
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** A shell command reduced to the program being run, for labelling only. Deliberately dumb:
 * the first whitespace-separated token, with any path stripped. The full command always stays
 * in `detail`, so being wrong here costs a slightly generic label and never hides anything. */
export function commandHead(command: string): string | undefined {
  const first = command.trim().split(/\s+/)[0];
  if (!first) return undefined;
  const bare = basename(first.replace(/^["']|["']$/g, ""));
  return bare.replace(/\.(exe|cmd|bat|ps1)$/i, "") || undefined;
}

/** "search_file_content" -> "Search file content"; "TodoWrite" -> "Todo write". Used only as the
 * fallback label, so an unknown tool still reads as words rather than as an identifier - while
 * still being, literally, the name the provider reported. */
export function humanizeToolName(name: string): string {
  const spaced = name
    .replace(/[_\-.]+/g, " ")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
  if (!spaced) return name;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/** Labels for an MCP tool by its server, since `mcp__github__create_issue` is far more usefully
 * summarised as "github" than as its full mangled identifier. */
function mcpLabel(name: string): string | undefined {
  const parts = name.split("__");
  if (parts.length >= 3 && parts[0] === "mcp") return `Using ${parts[1]}`;
  return undefined;
}

type Labeller = (input: unknown) => string;

/**
 * name (lowercased) -> label builder. Every entry maps a real tool name emitted by one of the
 * adapters in ../adapters: Claude Code and qwen-code share Claude's names, Gemini CLI uses
 * snake_case names, Codex reports item *types* rather than tool names.
 */
const LABELS: Record<string, Labeller> = {
  // ---- read ----
  read: (i) => withFile("Reading", i, "file_path", "path", "absolute_path", "notebook_path"),
  read_file: (i) => withFile("Reading", i, "absolute_path", "file_path", "path"),
  read_many_files: () => "Reading files",
  notebookread: (i) => withFile("Reading", i, "notebook_path", "file_path"),

  // ---- write / edit ----
  write: (i) => withFile("Writing", i, "file_path", "path", "absolute_path"),
  write_file: (i) => withFile("Writing", i, "file_path", "absolute_path", "path"),
  edit: (i) => withFile("Editing", i, "file_path", "path", "absolute_path"),
  // The OpenAI-compatible adapter's own edit tool (adapters/custom-api.ts + core/agentTools.ts).
  edit_file: (i) => withFile("Editing", i, "path", "file_path", "absolute_path"),
  multiedit: (i) => withFile("Editing", i, "file_path", "path"),
  notebookedit: (i) => withFile("Editing", i, "notebook_path", "file_path"),
  replace: (i) => withFile("Editing", i, "file_path", "absolute_path", "path"),
  // Codex reports edits as a file_change item carrying the list of paths it changed.
  file_change: (i) => {
    const paths = changedPaths(i);
    if (paths.length === 1) return `Editing ${basename(paths[0])}`;
    if (paths.length > 1) return `Editing ${paths.length} files`;
    return "Editing files";
  },

  // ---- shell ----
  bash: (i) => withCommand(i),
  shell: (i) => withCommand(i),
  run_shell_command: (i) => withCommand(i),
  command_execution: (i) => withCommand(i),
  bashoutput: () => "Checking a running command",
  killshell: () => "Stopping a running command",

  // ---- search ----
  grep: (i) => withPattern("Searching for", i),
  search_file_content: (i) => withPattern("Searching for", i),
  glob: (i) => withPattern("Finding files matching", i),
  list_directory: (i) => {
    const path = str(i, "path", "absolute_path", "dir");
    return path ? `Listing ${basename(path)}` : "Listing a directory";
  },
  ls: (i) => {
    const path = str(i, "path", "absolute_path", "dir");
    return path ? `Listing ${basename(path)}` : "Listing a directory";
  },

  // ---- web ----
  webfetch: (i) => withHost("Fetching", i),
  web_fetch: (i) => withHost("Fetching", i),
  websearch: () => "Searching the web",
  web_search: () => "Searching the web",
  google_web_search: () => "Searching the web",

  // ---- planning / delegation / misc ----
  task: (i) => {
    const description = str(i, "description");
    return description ? `Running a subagent: ${description}` : "Running a subagent";
  },
  agent: () => "Running a subagent",
  todowrite: () => "Updating its task list",
  todo_list: () => "Updating its task list",
  save_memory: () => "Saving a memory note",
  exitplanmode: () => "Finishing planning",
  slashcommand: (i) => {
    const command = str(i, "command");
    return command ? `Running ${command.split(/\s+/)[0]}` : "Running a command";
  },
  mcp_tool_call: (i) => {
    const server = str(i, "server", "server_name");
    return server ? `Using ${server}` : "Using a connected tool";
  },
};

function withFile(verb: string, input: unknown, ...keys: string[]): string {
  const path = str(input, ...keys);
  return path ? `${verb} ${basename(path)}` : `${verb} a file`;
}

function withPattern(verb: string, input: unknown): string {
  const pattern = str(input, "pattern", "query", "glob");
  return pattern ? `${verb} ${pattern}` : "Searching files";
}

function withHost(verb: string, input: unknown): string {
  const url = str(input, "url", "prompt");
  if (!url) return `${verb} a page`;
  try {
    return `${verb} ${new URL(url).host}`;
  } catch {
    return `${verb} a page`;
  }
}

function withCommand(input: unknown): string {
  const command = str(input, "command", "cmd", "script");
  const head = command ? commandHead(command) : undefined;
  return head ? `Running ${head}` : "Running a command";
}

function changedPaths(input: unknown): string[] {
  const rec = asRecord(input);
  const changes = rec.changes ?? rec.files ?? rec.paths;
  if (!Array.isArray(changes)) return [];
  const out: string[] = [];
  for (const change of changes) {
    if (typeof change === "string") out.push(change);
    else {
      const path = str(change, "path", "file_path", "absolute_path");
      if (path) out.push(path);
    }
  }
  return out;
}

/** Number, only when the provider genuinely reported one - `null`/absent stays undefined so
 * "still running" is never rendered as "exited 0". */
function exitCodeOf(input: unknown): number | undefined {
  const value = asRecord(input).exit_code ?? asRecord(input).exitCode;
  return typeof value === "number" ? value : undefined;
}

/**
 * The full call, for the disclosure. Arguments are reproduced verbatim; only a captured command
 * output is clipped, and clipping says so in the text.
 */
function buildDetail(name: string, input: unknown): string {
  const rec = asRecord(input);
  const command = str(input, "command", "cmd", "script");
  if (command) {
    const output = typeof rec.aggregated_output === "string" ? rec.aggregated_output : undefined;
    // The exit code is deliberately NOT repeated here: it travels as `exitCode` on the summary
    // and the UI renders it from that, so putting it in the text too just prints it twice.
    const lines = [command];
    if (output && output.trim()) lines.push(clip(output.trimEnd()));
    return lines.join("\n");
  }
  if (input === undefined || input === null) return name;
  try {
    return `${name}(${JSON.stringify(input)})`;
  } catch {
    return name;
  }
}

/**
 * The one entry point. `name` must be the provider's own tool/item name and `input` its own
 * arguments object - pass them through unchanged rather than pre-formatting, because the label
 * is derived from the argument VALUES, not from a string the adapter already flattened.
 */
export function describeToolCall(name: string, input?: unknown): ToolCallSummary {
  const trimmed = (name ?? "").trim();
  const key = trimmed.toLowerCase();
  const builder = LABELS[key];
  const label = builder ? builder(input) : mcpLabel(trimmed) ?? (humanizeToolName(trimmed) || "Working");
  return {
    name: trimmed || "unknown",
    label,
    detail: buildDetail(trimmed || "unknown", input),
    exitCode: exitCodeOf(input),
  };
}

/**
 * The single line shown while a run of calls is collapsed.
 *
 * It is the most recent call's own label, never a synthesis of them - "Reading 4 files and
 * editing 2" would be a claim about the whole run that nothing verified, and the point of this
 * indicator is to say what the agent is doing right now.
 */
export function activityLabel(summaries: ToolCallSummary[]): string {
  const last = summaries[summaries.length - 1];
  return last?.label ?? "Working";
}

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { TrustLevel } from "@solace/shared";
import { killCliTree } from "./spawnCli";

/**
 * The tool surface an OpenAI-compatible model (Ollama, LM Studio, llama.cpp, DeepSeek, Groq,
 * OpenRouter, ...) gets when it runs as a Solace agent, plus the executor that runs those tools
 * ON THIS MACHINE.
 *
 * Why this file exists at all: every other provider in this app is a CLI that already ships its
 * own sandbox, its own permission prompt and its own filesystem tools - adapters/claude-code.ts
 * and friends only have to translate a trust level onto a flag the CLI already understands. An
 * OpenAI-compatible endpoint ships none of that. It returns `tool_calls` and expects the CALLER
 * to be the sandbox. So everything those CLIs enforce for us has to be enforced here instead,
 * and this file is the whole of it.
 *
 * Two rules govern the code below, and both exist because the thing on the other end of the
 * wire is an arbitrary model the user downloaded:
 *
 *  1. A tool call is a REQUEST, never a permission. Trust level is checked here, server-side,
 *     immediately before the side effect - not in the prompt, not in the tool description, and
 *     not by trusting a flag the model set. A model that asks to run `rm -rf` in plan mode gets
 *     a refusal it can read, not a shell.
 *  2. A refusal is reported to the model as a tool RESULT, so it can adapt ("I can't write in
 *     plan mode, here's the patch instead"), and never as a fabricated success. Nothing in here
 *     ever invents a tool result: if the tool didn't run, the result says it didn't run.
 */

/** Per-tool capability class. The trust gate keys off this, never off the tool name. */
export type ToolCapability = "read" | "write" | "exec";

export interface ToolSpec {
  name: string;
  capability: ToolCapability;
  description: string;
  parameters: Record<string, unknown>;
}

/** Cap on a single tool result fed back into the model's context. A 50MB log pasted verbatim
 * into the message array blows the context window and, on a hosted endpoint, the user's bill.
 * Truncation is always stated in the text so the model knows it is seeing part of something. */
const MAX_RESULT_CHARS = 20_000;
const MAX_SEARCH_RESULTS = 200;
const MAX_SEARCH_FILES = 20_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_TIMEOUT_MS = 600_000;

/** Directories never walked by search/list-recursive. Not a security control (the containment
 * check is) - purely to stop a search burning minutes inside node_modules or .git. */
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".venv", "__pycache__", ".cache"]);

function clip(text: string, max = MAX_RESULT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…(truncated, ${text.length - max} more characters)`;
}

// ---------------------------------------------------------------------------------------------
// Containment
// ---------------------------------------------------------------------------------------------

/**
 * Windows reserved device names. `resolve(cwd, "NUL")` produces a path that LOOKS contained -
 * it is literally `<cwd>\NUL` - but Windows resolves that name to the null device no matter
 * which directory it appears in, so a "write" to it silently succeeds and goes nowhere, and a
 * read of `<cwd>\CON` blocks on console input. Every one of these has to be rejected by NAME,
 * because no amount of path arithmetic reveals them.
 */
const WINDOWS_DEVICE_NAMES = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

export type ContainmentResult = { ok: true; path: string } | { ok: false; reason: string };

/**
 * Resolve `input` and prove the result is inside `root`.
 *
 * The rule is REJECT, never sanitise. Stripping `..` segments out of a path and using whatever
 * is left is how containment checks get bypassed: the caller ends up operating on a path the
 * requester never named, and any mistake in the stripping is a silent escape. Here a path that
 * does not land inside the root produces an error the model reads, and no filesystem call
 * happens at all.
 *
 * Windows-specific cases this handles, each of which defeats a naive `startsWith` check:
 *
 *  - **Case.** NTFS is case-insensitive, so `c:\work\x` and `C:\Work\X` are the same file but
 *    are not the same string. Comparison is case-folded on win32 and case-sensitive elsewhere.
 *  - **Sibling prefix.** Root `C:\work` must not admit `C:\work-other\x`, which literally does
 *    start with the root string. The check requires an exact match or the root plus a separator.
 *  - **Other drives.** `D:\anything` resolves to a path that shares no prefix with a root on C:,
 *    so it falls out of the same check rather than needing a special case.
 *  - **Drive-relative paths.** `C:foo` is NOT `C:\foo` - it means "foo relative to the current
 *    directory ON drive C", a per-drive cursor this process does not control and cannot predict.
 *    `path.resolve` will happily invent an answer for it. Rejected outright instead.
 *  - **UNC and extended-length paths.** `\\server\share\x` and `\\?\C:\x` bypass normalisation
 *    entirely (`\\?\` in particular tells Win32 to skip `..` collapsing), so neither is accepted.
 *  - **Device names.** See WINDOWS_DEVICE_NAMES above.
 *  - **Junctions and symlinks.** The real bypass: `<cwd>\escape` can be a directory junction to
 *    `C:\Windows`, and every string-level check passes. Both the root and the deepest EXISTING
 *    ancestor of the target are realpath'd before comparing, so a link is followed to where it
 *    actually goes. Resolving only the existing part is what lets `write_file` create a new file
 *    (whose own path can't be realpath'd yet) while still proving the directory it lands in is
 *    contained.
 *  - **Trailing dots/spaces.** Win32 strips them when opening (`"x.txt "` opens `x.txt`), which
 *    is harmless for containment but means the name checked must be the name used - so the
 *    resolved path is what callers get back, never the raw input.
 */
export function resolveInside(root: string, input: unknown): ContainmentResult {
  if (typeof input !== "string" || !input.trim()) {
    return { ok: false, reason: "path must be a non-empty string" };
  }
  const raw = input.trim();

  if (raw.includes("\0")) return { ok: false, reason: "path contains a NUL byte" };

  if (process.platform === "win32") {
    if (/^[\\/]{2}/.test(raw)) {
      return { ok: false, reason: `refusing UNC or extended-length path "${raw}" - only paths inside the agent's working directory are allowed` };
    }
    // "C:foo" (drive letter, no separator) - drive-relative, not absolute.
    if (/^[A-Za-z]:[^\\/]/.test(raw)) {
      return { ok: false, reason: `refusing drive-relative path "${raw}" - write it as a full path or as a path relative to the working directory` };
    }
  }

  let resolvedRoot: string;
  try {
    resolvedRoot = realpathSync.native(resolve(root));
  } catch {
    resolvedRoot = resolve(root);
  }

  const target = isAbsolute(raw) ? resolve(raw) : resolve(resolvedRoot, raw);

  // Device-name check runs on every segment, not just the last: `<cwd>\NUL\..\x` is as bad.
  if (process.platform === "win32") {
    for (const segment of target.split(/[\\/]/)) {
      const bare = segment.split(".")[0]?.toLowerCase() ?? "";
      if (WINDOWS_DEVICE_NAMES.has(bare)) {
        return { ok: false, reason: `refusing path "${raw}" - "${segment}" is a reserved Windows device name` };
      }
    }
  }

  const real = realpathOfExistingAncestor(target);
  if (!isInside(resolvedRoot, real)) {
    return {
      ok: false,
      reason:
        `refusing "${raw}": it resolves to ${real}, which is outside this agent's working directory ` +
        `(${resolvedRoot}). Work only on paths inside that directory.`,
    };
  }
  // Hand back the string-resolved target, not `real`: if the working directory itself is reached
  // through a junction (every git worktree here is), `real` is a different but equivalent path,
  // and returning it would make every path the agent sees disagree with the one it asked for.
  return { ok: true, path: target };
}

/**
 * realpath as much of `target` as exists, then re-append the parts that don't. A plain
 * realpathSync throws ENOENT for a file about to be created, which would make every create
 * unreachable; skipping realpath entirely would make every junction an escape hatch.
 */
function realpathOfExistingAncestor(target: string): string {
  const tail: string[] = [];
  let current = target;
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(current);
      // parse().root is the drive/UNC root ("C:\\", "/"): stop there rather than looping on
      // dirname("C:\\") === "C:\\" forever.
      if (parent === current || current === parse(current).root) return target;
      tail.push(current.slice(parent.length).replace(/^[\\/]+/, ""));
      current = parent;
    }
  }
}

function isInside(root: string, candidate: string): boolean {
  const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const a = fold(root.replace(/[\\/]+$/, "")) || fold(root);
  const b = fold(candidate);
  return b === a || b.startsWith(a + sep) || b.startsWith(a + "/");
}

// ---------------------------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------------------------

/**
 * The tool set, in the OpenAI `tools[].function` shape.
 *
 * Names are chosen to match entries that already exist in core/toolLabel.ts's table, so a local
 * model's calls render in the activity UI with the same labels ("Reading x.ts", "Running git")
 * the CLI providers produce, with no per-provider special-casing anywhere downstream.
 *
 * There is deliberately no git tool. Git is a program, `run_shell_command` runs programs, and a
 * bespoke git tool would be a second, weaker permission surface to keep in sync with the first.
 */
export const AGENT_TOOLS: ToolSpec[] = [
  {
    name: "read_file",
    capability: "read",
    description:
      "Read a UTF-8 text file from the agent's working directory. Returns the file's contents. " +
      "Use start_line/max_lines for a large file rather than reading it whole.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path, or a path relative to the working directory." },
        start_line: { type: "integer", description: "1-based first line to return. Default 1." },
        max_lines: { type: "integer", description: "Maximum number of lines to return." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    capability: "write",
    description:
      "Create a file, or overwrite it completely, inside the agent's working directory. " +
      "Parent directories are created as needed. To change part of an existing file prefer edit_file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path, or a path relative to the working directory." },
        content: { type: "string", description: "The complete new contents of the file." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_file",
    capability: "write",
    description:
      "Replace an exact string in an existing file. old_text must appear in the file, and must " +
      "appear exactly once unless replace_all is true. Include enough surrounding context to " +
      "make old_text unique.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path, or a path relative to the working directory." },
        old_text: { type: "string", description: "Exact text to replace, including whitespace and indentation." },
        new_text: { type: "string", description: "Replacement text. Use an empty string to delete." },
        replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring exactly one." },
      },
      required: ["path", "old_text", "new_text"],
      additionalProperties: false,
    },
  },
  {
    name: "list_directory",
    capability: "read",
    description: "List the entries of a directory inside the agent's working directory.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory to list. Defaults to the working directory." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "search_file_content",
    capability: "read",
    description:
      "Search file contents under the working directory for a JavaScript regular expression. " +
      "Returns matching lines as path:line: text. Skips .git, node_modules and build output.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression source." },
        path: { type: "string", description: "Directory to search under. Defaults to the working directory." },
        glob: { type: "string", description: 'Only search files whose name matches this glob, e.g. "*.ts".' },
        max_results: { type: "integer", description: `Maximum matching lines to return. Default 50, cap ${MAX_SEARCH_RESULTS}.` },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "run_shell_command",
    capability: "exec",
    description:
      "Run one shell command with the agent's working directory as the current directory, and " +
      "return its combined stdout/stderr and exit code. This is how you use git, package " +
      "managers, compilers, test runners and any other program. The command must be a single " +
      "line - chain steps with && rather than newlines.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command line to run. Single line only." },
        timeout_ms: { type: "integer", description: `Kill the command after this long. Default ${DEFAULT_COMMAND_TIMEOUT_MS}, cap ${MAX_COMMAND_TIMEOUT_MS}.` },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
];

/** The `tools` array sent on the wire. Separate from AGENT_TOOLS so `capability` - which is ours
 * and means nothing to the endpoint - never leaks into the request body. */
export function toolsWireFormat(): unknown[] {
  return AGENT_TOOLS.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

export function toolByName(name: string): ToolSpec | undefined {
  return AGENT_TOOLS.find((tool) => tool.name === name);
}

// ---------------------------------------------------------------------------------------------
// Trust gating
// ---------------------------------------------------------------------------------------------

export type GateDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "ask" };

/**
 * Trust level x capability -> what happens, as a pure function so it can be tested exhaustively
 * without a filesystem or an HTTP server. The executor calls this and obeys it; there is no
 * other path to a side effect.
 *
 *  - `plan`     reads only. Plan mode is what the user picks when they want thinking and not
 *               acting, so a write or a command is refused outright - not queued for approval,
 *               because the user already answered the question by choosing plan.
 *  - `manual`   reads freely; every write and every command blocks on a real human click.
 *  - `acceptEdits` reads and writes freely; commands still block. (An edit is reviewable and
 *               reversible in a git working tree; an arbitrary command is neither.)
 *  - `bypassPermissions` / `auto` proceed.
 */
export function gateFor(trustLevel: TrustLevel, capability: ToolCapability): GateDecision {
  if (capability === "read") return { kind: "allow" };
  switch (trustLevel) {
    case "plan":
      return {
        kind: "deny",
        reason:
          capability === "write"
            ? "this agent is in plan mode, which is read-only - it cannot write files. Describe the change instead, or ask the user to change the agent's permission mode."
            : "this agent is in plan mode, which is read-only - it cannot run commands. Describe what you would run instead, or ask the user to change the agent's permission mode.",
      };
    case "manual":
      return { kind: "ask" };
    case "acceptEdits":
      return capability === "write" ? { kind: "allow" } : { kind: "ask" };
    case "bypassPermissions":
    case "auto":
      return { kind: "allow" };
    default:
      // An unrecognised trust level fails CLOSED. validateAgentConfig should make this
      // unreachable, but "unknown level" must never be the one that grants a shell.
      return { kind: "deny", reason: `unrecognised permission mode "${String(trustLevel)}" - refusing` };
  }
}

// ---------------------------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------------------------

export interface ToolResult {
  /** Text handed back to the model as the `role: "tool"` message content. Always truthful about
   * whether the tool ran: a refusal says so, and never resembles a success. */
  content: string;
  /** True when the tool did not do what was asked (refused, denied, failed, contained). Used by
   * the caller for logging/labelling only - the model sees `content` either way. */
  isError: boolean;
  /** Present only for run_shell_command, and only when the process actually exited. */
  exitCode?: number;
}

export interface ToolExecutorOptions {
  cwd: string;
  trustLevel: TrustLevel;
  agentId: string;
  /** Proves to /internal/approvals that a turn is really running. Absent means no approval can
   * be raised, and anything needing one is denied - fail closed. */
  turnToken?: string;
  signal?: AbortSignal;
  /** Injectable for tests. Defaults to the real loopback call to this server's own
   * /internal/approvals - the SAME endpoint approval/bridgeScript.mjs drives for Claude Code, so
   * a local model's write raises the identical Allow/Deny card in the UI rather than a second,
   * parallel approval mechanism that would have to be built, styled and kept in sync. */
  requestApproval?: (description: string) => Promise<boolean>;
}

export interface ToolExecutor {
  execute(name: string, rawArguments: string): Promise<ToolResult>;
}

/** The loopback approval call. Mirrors bridgeScript.mjs's body exactly. */
function defaultRequestApproval(agentId: string, turnToken: string | undefined) {
  return async (description: string): Promise<boolean> => {
    // No token means we cannot prove an in-flight turn, and the route would 403 anyway. Deny
    // rather than treating an unanswerable question as a yes.
    if (!turnToken) return false;
    const port = Number(process.env.PORT ?? 4310);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/internal/approvals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId, turnToken, description }),
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { approved?: boolean };
      return body.approved === true;
    } catch {
      // A failed approval round-trip is a denial, never a default-allow.
      return false;
    }
  };
}

export function createToolExecutor(options: ToolExecutorOptions): ToolExecutor {
  const { cwd, trustLevel, agentId, turnToken, signal } = options;
  const requestApproval = options.requestApproval ?? defaultRequestApproval(agentId, turnToken);

  async function execute(name: string, rawArguments: string): Promise<ToolResult> {
    const spec = toolByName(name);
    if (!spec) {
      return {
        content: `error: no tool named "${name}" exists. Available tools: ${AGENT_TOOLS.map((t) => t.name).join(", ")}.`,
        isError: true,
      };
    }

    let args: Record<string, unknown>;
    try {
      const parsed = rawArguments && rawArguments.trim() ? JSON.parse(rawArguments) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      args = parsed as Record<string, unknown>;
    } catch (err) {
      return {
        content: `error: arguments for ${name} were not a JSON object (${(err as Error).message}). Send arguments as a JSON object matching the tool's schema.`,
        isError: true,
      };
    }

    // THE GATE. Every side effect in this file is downstream of this check, and nothing below
    // re-derives permission from the arguments - a "read-only" looking command is still exec.
    const gate = gateFor(trustLevel, spec.capability);
    if (gate.kind === "deny") return { content: `refused: ${gate.reason}`, isError: true };
    if (gate.kind === "ask") {
      // A THROW HERE IS A DENIAL. The approval round-trip is an HTTP call to our own server; if
      // it throws (server mid-restart, socket closed, the route 403'd an expired turn token)
      // the exception must not escape execute() - it would propagate out of the adapter's tool
      // loop as an unhandled turn failure, and, far worse, any future refactor that caught it
      // higher up would be one `catch` away from treating "we could not ask" as "yes".
      const approved = await requestApproval(describeForApproval(name, args)).catch(() => false);
      if (!approved) {
        return { content: "refused: the user denied this action. Do not retry it; ask them what to do instead.", isError: true };
      }
    }

    try {
      switch (name) {
        case "read_file":
          return doReadFile(cwd, args);
        case "write_file":
          return doWriteFile(cwd, args);
        case "edit_file":
          return doEditFile(cwd, args);
        case "list_directory":
          return doListDirectory(cwd, args);
        case "search_file_content":
          return doSearch(cwd, args);
        case "run_shell_command":
          return await doRunCommand(cwd, args, signal);
        default:
          return { content: `error: tool "${name}" is declared but not implemented`, isError: true };
      }
    } catch (err) {
      return { content: `error: ${name} failed: ${(err as Error).message}`, isError: true };
    }
  }

  return { execute };
}

/** The one line a human sees on the Allow/Deny card. Built from the real name and real arguments
 * - for a command it leads with the command itself, because that is the thing being decided. */
export function describeForApproval(name: string, args: Record<string, unknown>): string {
  if (name === "run_shell_command" && typeof args.command === "string") {
    return `run_shell_command: ${args.command}`;
  }
  if (typeof args.path === "string") return `${name}: ${args.path}`;
  return `${name}(${safeJson(args)})`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[unserialisable arguments]";
  }
}

// ---- individual tools ----

function doReadFile(cwd: string, args: Record<string, unknown>): ToolResult {
  const contained = resolveInside(cwd, args.path);
  if (!contained.ok) return { content: `refused: ${contained.reason}`, isError: true };
  let stat;
  try {
    stat = statSync(contained.path);
  } catch {
    return { content: `error: no such file: ${contained.path}`, isError: true };
  }
  if (stat.isDirectory()) return { content: `error: ${contained.path} is a directory - use list_directory`, isError: true };

  const text = readFileSync(contained.path, "utf8");
  const start = numberArg(args.start_line, 1);
  const max = numberArg(args.max_lines, 0);
  if (start <= 1 && !max) return { content: clip(text), isError: false };
  const lines = text.split("\n");
  const from = Math.max(0, start - 1);
  const slice = max > 0 ? lines.slice(from, from + max) : lines.slice(from);
  return {
    content: clip(`(lines ${from + 1}-${from + slice.length} of ${lines.length})\n${slice.join("\n")}`),
    isError: false,
  };
}

function doWriteFile(cwd: string, args: Record<string, unknown>): ToolResult {
  const contained = resolveInside(cwd, args.path);
  if (!contained.ok) return { content: `refused: ${contained.reason}`, isError: true };
  if (typeof args.content !== "string") return { content: "error: write_file needs a string `content`", isError: true };
  mkdirSync(dirname(contained.path), { recursive: true });
  const existed = existsSync(contained.path);
  writeFileSync(contained.path, args.content, "utf8");
  return {
    content: `${existed ? "Overwrote" : "Created"} ${contained.path} (${args.content.length} characters).`,
    isError: false,
  };
}

function doEditFile(cwd: string, args: Record<string, unknown>): ToolResult {
  const contained = resolveInside(cwd, args.path);
  if (!contained.ok) return { content: `refused: ${contained.reason}`, isError: true };
  if (typeof args.old_text !== "string" || typeof args.new_text !== "string") {
    return { content: "error: edit_file needs string `old_text` and `new_text`", isError: true };
  }
  if (!existsSync(contained.path)) return { content: `error: no such file: ${contained.path}`, isError: true };
  const before = readFileSync(contained.path, "utf8");
  const parts = before.split(args.old_text);
  const occurrences = parts.length - 1;
  if (occurrences === 0) {
    return { content: `error: old_text was not found in ${contained.path}. Read the file and copy the exact text, including whitespace.`, isError: true };
  }
  if (occurrences > 1 && args.replace_all !== true) {
    return {
      content: `error: old_text appears ${occurrences} times in ${contained.path}. Add surrounding context to make it unique, or pass replace_all: true.`,
      isError: true,
    };
  }
  const after = args.replace_all === true ? parts.join(args.new_text) : before.replace(args.old_text, args.new_text);
  writeFileSync(contained.path, after, "utf8");
  return { content: `Edited ${contained.path} (${occurrences} replacement${occurrences === 1 ? "" : "s"}).`, isError: false };
}

function doListDirectory(cwd: string, args: Record<string, unknown>): ToolResult {
  const contained = resolveInside(cwd, typeof args.path === "string" && args.path.trim() ? args.path : ".");
  if (!contained.ok) return { content: `refused: ${contained.reason}`, isError: true };
  let entries;
  try {
    entries = readdirSync(contained.path, { withFileTypes: true });
  } catch (err) {
    return { content: `error: cannot list ${contained.path}: ${(err as Error).message}`, isError: true };
  }
  if (!entries.length) return { content: `${contained.path} is empty.`, isError: false };
  const lines = entries
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort((a, b) => a.localeCompare(b));
  return { content: clip(`${contained.path}\n${lines.join("\n")}`), isError: false };
}

/** Minimal glob -> RegExp for a FILE NAME (no path separators): `*` and `?` only. Deliberately
 * not a full glob implementation - anything more is what search's `path` argument is for. */
function globToRegExp(glob: string): RegExp {
  const source = glob
    .split("")
    .map((ch) => (ch === "*" ? ".*" : ch === "?" ? "." : ch.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${source}$`, process.platform === "win32" ? "i" : "");
}

function doSearch(cwd: string, args: Record<string, unknown>): ToolResult {
  if (typeof args.pattern !== "string" || !args.pattern) {
    return { content: "error: search_file_content needs a string `pattern`", isError: true };
  }
  const contained = resolveInside(cwd, typeof args.path === "string" && args.path.trim() ? args.path : ".");
  if (!contained.ok) return { content: `refused: ${contained.reason}`, isError: true };

  let re: RegExp;
  try {
    re = new RegExp(args.pattern);
  } catch (err) {
    return { content: `error: pattern is not a valid regular expression: ${(err as Error).message}`, isError: true };
  }
  const nameFilter = typeof args.glob === "string" && args.glob.trim() ? globToRegExp(args.glob.trim()) : undefined;
  const limit = Math.min(numberArg(args.max_results, 50) || 50, MAX_SEARCH_RESULTS);

  const hits: string[] = [];
  let filesScanned = 0;
  let truncated = false;

  const walk = (dir: string) => {
    if (hits.length >= limit || filesScanned >= MAX_SEARCH_FILES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (hits.length >= limit || filesScanned >= MAX_SEARCH_FILES) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        // Don't follow a link out of the tree mid-walk; the containment rule is the same here
        // as everywhere else in this file.
        if (entry.isSymbolicLink()) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (nameFilter && !nameFilter.test(entry.name)) continue;
      filesScanned += 1;
      let text: string;
      try {
        const stat = statSync(full);
        if (stat.size > 2_000_000) continue;
        text = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      // A NUL in the first chunk means binary; grepping it produces noise, not answers.
      if (text.slice(0, 4096).includes("\0")) continue;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        if (!re.test(lines[i])) continue;
        if (hits.length >= limit) {
          truncated = true;
          return;
        }
        hits.push(`${relative(cwd, full) || full}:${i + 1}: ${lines[i].slice(0, 400)}`);
      }
    }
  };

  try {
    if (statSync(contained.path).isDirectory()) walk(contained.path);
    else walk(dirname(contained.path));
  } catch {
    return { content: `error: cannot search ${contained.path}`, isError: true };
  }

  if (!hits.length) return { content: `No matches for /${args.pattern}/ under ${contained.path}.`, isError: false };
  const note = truncated ? `\n…(stopped at ${limit} matches; narrow the pattern or raise max_results)` : "";
  return { content: clip(`${hits.join("\n")}${note}`), isError: false };
}

/**
 * Run one command line with `cwd` as the current directory.
 *
 * NOT `shell: true`. Node's shell:true on Windows joins the argv array with spaces and no
 * quoting whatsoever (the DEP0190 warning is about exactly this), which mangles any argument
 * containing whitespace and, worse, lets a `"` in an argument close cmd.exe's quoting early and
 * expose the rest to cmd.exe's own operators. Here the interpreter is named explicitly and its
 * ONE argument is the command line, built in the exact form cmd.exe documents:
 * `cmd.exe /d /s /c "<command>"` with windowsVerbatimArguments, where /s means "strip the first
 * and last quote and take the rest literally". That is the only construction on Windows that
 * passes an arbitrary command line through unaltered.
 *
 * cross-spawn (core/spawnCli.ts) is deliberately NOT used for this one call: it applies standard
 * Windows argv quoting, which is the right thing for a program's argv and the wrong thing for a
 * cmd.exe command line, and it would re-escape the string we just built.
 *
 * A newline in the command is rejected rather than truncated - a cmd.exe command line ends at
 * the first literal newline, silently discarding everything after it AND exiting zero, which is
 * the single worst failure mode available here (the model is told its script succeeded when most
 * of it never ran). Same reasoning as spawnCli's own newline guard.
 */
function doRunCommand(cwd: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (!command) return Promise.resolve({ content: "error: run_shell_command needs a non-empty `command`", isError: true });
  if (/[\r\n]/.test(command)) {
    return Promise.resolve({
      content:
        "error: the command contains a newline. Windows command lines end at the first newline, so the rest would be silently discarded. Chain steps with && on one line, or write a script file with write_file and run that.",
      isError: true,
    });
  }
  if (command.includes("\0")) return Promise.resolve({ content: "error: the command contains a NUL byte", isError: true });

  const timeoutMs = Math.min(numberArg(args.timeout_ms, DEFAULT_COMMAND_TIMEOUT_MS) || DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS);

  return new Promise<ToolResult>((resolvePromise) => {
    const isWindows = process.platform === "win32";
    const child = isWindows
      ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${command}"`], {
          cwd,
          windowsVerbatimArguments: true,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        })
      : spawn(process.env.SHELL ?? "/bin/sh", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });

    let output = "";
    let settled = false;
    const append = (chunk: Buffer) => {
      // Bounded in memory, not just on the way out: a runaway command producing gigabytes
      // would otherwise take the whole server down before it ever got clipped.
      if (output.length < MAX_RESULT_CHARS * 2) output += chunk.toString("utf8");
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const finish = (result: ToolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolvePromise(result);
    };

    const timer = setTimeout(() => {
      killCliTree(child);
      finish({
        content: clip(`${output}\n\n[killed: no exit after ${timeoutMs}ms]`),
        isError: true,
      });
    }, timeoutMs);

    // The turn was aborted (Stop, timeout, interrupt). killCliTree, not child.kill: on Windows
    // the handle we hold is cmd.exe, and killing it leaves whatever it launched running - real
    // writes and real billed work continuing against a turn the user already stopped.
    const onAbort = () => {
      killCliTree(child);
      finish({ content: clip(`${output}\n\n[stopped: the turn was cancelled]`), isError: true });
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => finish({ content: `error: could not run the command: ${err.message}`, isError: true }));
    child.on("close", (code) => {
      const exitCode = typeof code === "number" ? code : undefined;
      const body = output.trim() ? clip(output.trimEnd()) : "(no output)";
      finish({
        content: `exit code: ${exitCode ?? "unknown"}\n${body}`,
        isError: exitCode !== 0,
        exitCode,
      });
    });
  });
}

function numberArg(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Math.trunc(Number(value));
  return fallback;
}

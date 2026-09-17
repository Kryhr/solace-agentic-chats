import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TrustLevel, TurnUsage } from "@solace/shared";
import { isEmptyUsage, num, put } from "../core/usage";
import { SERVER_PORT } from "../core/serverPort";
import { killCliTree, spawnCli } from "../core/spawnCli";
import { mcpServersForAgent, type ResolvedMcpServer } from "../core/mcpServers";
import type { AdapterEvent, ProviderAdapter, RunTurnOptions } from "./types";

/** Same resolution rule as claude-code.ts: re-anchor from the package root so the plain-JS
 * bridge works identically under `tsx` (src/) and the compiled build (dist/). */
const SOLACE_BRIDGE_SCRIPT = join(__dirname, "..", "..", "src", "mcp", "solaceBridge.mjs");

/* -------------------------------------------------------------------------- */
/* Trust levels                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Crush's real headless tool inventory, read back FROM THE BINARY rather than from docs: a
 * turn whose model called a tool named "nope" came back with
 *
 *   tool not found: nope. Available tools: agent, agentic_fetch, bash, crush_info, crush_logs,
 *   download, edit, fetch, glob, grep, job_kill, job_output, list_mcp_resources, ls, lsp_*,
 *   multiedit, read_mcp_resource, sourcegraph, todos, view, write
 *
 * Only the entries that can actually change this machine are named below; everything else is
 * read-only and stays available at every trust level.
 */
/** Tools that write to disk. */
const EDIT_TOOLS = ["write", "edit", "multiedit"];
/** Tools that execute code, fetch to disk, or spawn a sub-agent that can do either.
 * `job_kill`/`job_output` only inspect jobs `bash` started, so with bash gone they are inert. */
const EXEC_TOOLS = ["bash", "download", "agent"];

/**
 * Trust level -> Crush's `options.disabled_tools`.
 *
 * THE IMPORTANT FINDING, verified live against crush v0.95.0 on 2026-09-16: `crush run` has NO
 * approval mechanism at all. `--yolo` exists only on the interactive TUI root command and is
 * rejected by `run` ("Unknown flag: --yolo"), and a headless turn with no permissions config
 * whatsoever happily executed `bash {"command":"echo hello-from-tool"}` and wrote a brand-new
 * file to disk via `write` without asking anyone. Headless Crush is ALWAYS in yolo mode.
 *
 * `permissions.allowed_tools` does NOT help: it is a *pre-approval* list (skip the TUI prompt
 * for these), not a restrictive allowlist. Setting `allowed_tools: ["view"]` and then asking
 * for a `write` still wrote the file - tested, file created.
 *
 * `options.disabled_tools` is the only lever that genuinely restricts, and it does work: with
 * write disabled the same turn came back "tool not found: write. Available tools: ..." and the
 * file was NOT created. It is also not defeatable from the project side - a repo-local
 * crush.json carrying `"disabled_tools": []` did not re-enable anything.
 *
 * So the three levels below are the only ones that are true statements about what the agent
 * can do. Deliberately absent, and why:
 *   - "manual": Crush headless has no external approval hook (nothing like Claude Code's
 *     --permission-prompt-tool). Offering it would promise a human gate that does not exist.
 *   - "auto": there is no classifier-judged middle ground distinct from full access, so it
 *     would just be a gentler-sounding second name for "bypassPermissions" - the same reason
 *     it is omitted for Gemini and Copilot.
 */
export function disabledToolsForTrustLevel(trustLevel: TrustLevel): string[] {
  switch (trustLevel) {
    case "plan":
      return [...EDIT_TOOLS, ...EXEC_TOOLS];
    case "acceptEdits":
      return [...EXEC_TOOLS];
    default:
      // bypassPermissions - and, defensively, anything the catalog should never hand us.
      return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Per-turn config                                                            */
/* -------------------------------------------------------------------------- */

export interface CrushConfig {
  mcp?: Record<string, { type: "stdio"; command: string; args: string[]; env?: Record<string, string> }>;
  options?: { disabled_tools?: string[] };
  [key: string]: unknown;
}

/**
 * Crush's MCP entry shape, verified live: `{ "type": "stdio", "command", "args", "env" }` under
 * a top-level `"mcp"` object. Confirmed by registering solaceBridge.mjs this way and reading
 * the resulting tool list back out of a real turn - Crush addresses MCP tools as
 * `mcp_<server>_<tool>` (underscores, not Claude Code's `mcp__server__tool`), e.g.
 * `mcp_solace_post_to_group`.
 *
 * No pre-allow list is written alongside it, unlike claude-code.ts: `permissions.allowed_tools`
 * is a no-op headless (see above), and every tool is auto-approved anyway, so writing one would
 * be decoration that implied a gate exists.
 */
export function buildCrushConfig(trustLevel: TrustLevel, userServers: ResolvedMcpServer[] = []): CrushConfig {
  const mcp: NonNullable<CrushConfig["mcp"]> = {
    solace: { type: "stdio", command: "node", args: [SOLACE_BRIDGE_SCRIPT] },
  };
  // Same merge-don't-append rule as claude-code.ts, and the same reserved-name guard: a user
  // server may not displace the group-chat bridge.
  for (const server of userServers) {
    if (server.name === "solace" || server.name === "approval-bridge") continue;
    mcp[server.name] = { type: "stdio", command: server.command, args: server.args, env: server.env };
  }

  const disabled = disabledToolsForTrustLevel(trustLevel);
  const config: CrushConfig = { $schema: "https://charm.land/crush.json", mcp };
  // Only written when it says something. An empty array is not "no restriction" to a reader of
  // the file, it looks like a restriction someone forgot to fill in.
  if (disabled.length) config.options = { disabled_tools: disabled };
  return config;
}

/**
 * Crush merges a *global config directory* with the project's own crush.json, and the directory
 * is overridable per-process via CRUSH_GLOBAL_CONFIG (verified: it must be a DIRECTORY
 * containing crush.json - pointing it at the file itself fails with "No providers configured").
 *
 * That is what lets this adapter inject MCP servers and disabled_tools WITHOUT ever writing to
 * the user's real ~/.config/crush/crush.json or dropping a crush.json into the repo it is
 * working on. Any existing global config is copied in first so the user's own providers and
 * settings still apply; our keys are merged on top of that copy, and the whole directory is
 * deleted when the turn ends.
 *
 * Auth is untouched by this: Crush keeps credentials in its DATA directory
 * (%LOCALAPPDATA%\crush / XDG data home), which this adapter never overrides.
 */
export function writeTurnConfigDir(config: CrushConfig, userGlobalDir?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "solace-crush-"));
  let merged: Record<string, unknown> = { ...config };
  if (userGlobalDir && existsSync(userGlobalDir)) {
    for (const name of readdirSync(userGlobalDir)) {
      const src = join(userGlobalDir, name);
      if (name === "crush.json") continue;
      try {
        copyFileSync(src, join(dir, name));
      } catch {
        // A subdirectory or an unreadable file - not fatal, the config below is what matters.
      }
    }
    const existing = join(userGlobalDir, "crush.json");
    if (existsSync(existing)) {
      try {
        const base = JSON.parse(readFileSync(existing, "utf8")) as Record<string, unknown>;
        merged = {
          ...base,
          ...config,
          // The user may already have their own MCP servers globally; ours are added to them
          // rather than replacing the lot.
          mcp: { ...((base.mcp as object) ?? {}), ...(config.mcp ?? {}) },
          options: { ...((base.options as object) ?? {}), ...(config.options ?? {}) },
        };
      } catch {
        // Malformed user config - fall back to ours alone rather than failing the turn. Crush
        // would have rejected theirs too.
      }
    }
  }
  writeFileSync(join(dir, "crush.json"), JSON.stringify(merged, null, 2), "utf8");
  return dir;
}

/** Where Crush looks for its global config when CRUSH_GLOBAL_CONFIG is not set. */
export function defaultGlobalConfigDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.CRUSH_GLOBAL_CONFIG) return env.CRUSH_GLOBAL_CONFIG;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "crush");
  const home = env.HOME ?? env.USERPROFILE;
  return home ? join(home, ".config", "crush") : undefined;
}

/* -------------------------------------------------------------------------- */
/* Argv                                                                       */
/* -------------------------------------------------------------------------- */

export interface CrushArgsInput {
  cwd: string;
  sessionId?: string;
  model?: string;
  effort?: string;
}

/**
 * `crush run` with NO positional prompt reads the prompt from stdin - verified with a real turn
 * (`echo "Reply with exactly: OK" | crush run` answered correctly). The prompt therefore never
 * appears in argv, which is not a stylistic choice: on Windows `crush` resolves to an
 * npm-installed .ps1/.cmd shim, so a multi-line prompt in argv would be truncated at the first
 * newline by cmd.exe exactly as it was for Claude Code, and a long one risks the
 * spawn ENAMETOOLONG that Codex and Copilot hit here. spawnCli would throw on a newline argv
 * element through a .cmd shim anyway; this keeps us well clear of both.
 *
 * `-q` hides the spinner. stdout is then EXACTLY the final assistant text and nothing else -
 * verified by running with and without -q and with --verbose, capturing stdout separately from
 * stderr each time; the spinner and all logging go to stderr in every case.
 */
export function buildCrushArgs({ cwd, sessionId, model, effort }: CrushArgsInput): string[] {
  return [
    "run",
    "-q",
    "--cwd",
    cwd,
    // Crush gives no way to choose a session id up front (there is no --session-id; the
    // CRUSH_SESSION_ID env var in the binary was tested and does not set it either), so a first
    // turn cannot pre-declare one and the id is discovered afterwards instead. Resuming takes
    // the id Crush itself minted - "-s" accepts its short hash, the full hash, or the UUID.
    ...(sessionId ? ["-s", sessionId] : []),
    // `-m` accepts "model" or "provider/model" to disambiguate. `crush models` lists every id
    // in exactly that "provider/model" form.
    ...(model ? ["-m", model] : []),
    ...(effort ? ["--reasoning-effort", effort] : []),
  ];
}

/* -------------------------------------------------------------------------- */
/* Session JSON                                                               */
/* -------------------------------------------------------------------------- */

/** One entry of `crush session list --json`. */
export interface CrushSessionMeta {
  id: string;
  uuid: string;
  title?: string;
  created?: string;
  modified?: string;
  cost?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/** `crush session show <id> --json` / `crush session last --json`. */
export interface CrushSessionDetail {
  meta: CrushSessionMeta;
  messages: Array<{
    id: string;
    role: "user" | "assistant" | "tool";
    model?: string;
    provider?: string;
    parts?: Array<{
      type: string;
      text?: string;
      name?: string;
      input?: string;
      content?: string;
      is_error?: boolean;
    }>;
  }>;
}

/**
 * Turn one Crush session document into our events, in the session's own order.
 *
 * `crush run` emits no machine-readable stream - there is no --json/--format equivalent on it,
 * and stdout is only the final answer text - so the structured half of a turn (which tools ran,
 * what the model actually was, real token usage) can only be recovered afterwards from
 * `crush session show --json`. That is why this replays rather than streams: replaying gives
 * the true interleaving of tool calls and prose, which a text-only stdout cannot express at all.
 *
 * A resumed session's document contains the WHOLE conversation, so the replay has to start at
 * this turn and not at the beginning - otherwise the second turn of a chat re-emits the first
 * turn's answer and tool calls, which was the observed behaviour before this cut existed.
 *
 * The cut is taken from the document itself - everything after the LAST user message - rather
 * than from a message id remembered in this process. `crush run` appends exactly one user
 * message per turn, so that boundary is exact, and unlike in-memory bookkeeping it still holds
 * after a server restart mid-conversation.
 */
/**
 * Crush's session totals, mapped onto TurnUsage.
 *
 * Crush is the one provider here that publishes NO per-turn figure at all. `crush run` emits no
 * machine-readable stream, and the only structured numbers are on the session record read back
 * by `crush session show --json`, which is cumulative for the whole conversation. Reported as-is
 * rather than differenced, because the numbers Crush itself shows in `crush stats` are these -
 * but marked `scope: "session"` so the running total upstream replaces rather than adds them.
 * Without that mark an agent's third turn claimed roughly three times the tokens Crush would
 * show for the same session, because Crush had already done the adding.
 *
 * What is NOT here is as load-bearing as what is. Crush's own SQLite schema, read out of the
 * shipped crush.exe, is the complete list of what it stores per session:
 *
 *   CREATE TABLE IF NOT EXISTS sessions (
 *     id TEXT PRIMARY KEY, parent_session_id TEXT, title TEXT NOT NULL,
 *     message_count INTEGER ..., prompt_tokens INTEGER ..., completion_tokens INTEGER ...,
 *     cost REAL ..., updated_at INTEGER, created_at INTEGER);
 *
 * So there are no cache buckets and no reasoning count to report, and `total_tokens` in the JSON
 * is Crush's own field rather than something derived here. `cost` is a real dollar figure that
 * Crush computes from its own provider rate card, so it maps to totalCostUsd.
 */
export function crushUsage(meta: CrushSessionMeta | undefined): TurnUsage | undefined {
  if (!meta) return undefined;
  const usage: TurnUsage = {};
  put(usage, "inputTokens", num(meta.prompt_tokens));
  put(usage, "outputTokens", num(meta.completion_tokens));
  put(usage, "totalTokens", num((meta as { total_tokens?: unknown }).total_tokens));
  put(usage, "totalCostUsd", num(meta.cost));
  if (isEmptyUsage(usage)) return undefined;
  usage.scope = "session";
  return usage;
}

export function eventsFromSession(detail: CrushSessionDetail): AdapterEvent[] {
  const events: AdapterEvent[] = [];
  const messages = detail.messages ?? [];
  let startAt = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      startAt = i + 1;
      break;
    }
  }
  let reportedModel: string | undefined;

  for (const message of messages.slice(startAt)) {
    if (message.role === "user") continue;
    if (message.role === "assistant" && message.model && message.model !== reportedModel) {
      reportedModel = message.model;
      // Crush reports provider and model separately; "provider/model" is the same form its own
      // `-m` flag and `crush models` use, so it round-trips.
      events.push({ type: "model", model: message.provider ? `${message.provider}/${message.model}` : message.model });
    }
    for (const part of message.parts ?? []) {
      if (part.type === "text" && part.text) {
        events.push({ type: "text", text: part.text });
      } else if (part.type === "reasoning" && part.text) {
        events.push({ type: "reasoning", text: part.text });
      } else if (part.type === "tool_call" && part.name) {
        // Crush stores tool arguments as a JSON *string*, not an object - parsed here so
        // core/toolLabel.ts sees real argument values and can build a human label.
        let input: unknown = part.input;
        if (typeof part.input === "string") {
          try {
            input = JSON.parse(part.input);
          } catch {
            input = part.input;
          }
        }
        events.push({
          type: "tool-use",
          description: `${part.name}(${typeof part.input === "string" ? part.input : JSON.stringify(part.input)})`,
          toolName: part.name,
          input,
        });
      }
    }
  }

  const usage = crushUsage(detail.meta);
  if (usage) events.push({ type: "usage", usage });
  return events;
}

/**
 * Pick this turn's session out of `crush session list --json`.
 *
 * Needed because Crush mints the id itself and prints it nowhere: not on stdout (which is only
 * the answer text), not on stderr. Snapshotting the ids before the turn and taking the one that
 * appeared is exact. The newest-by-`modified` fallback only matters if the before-snapshot
 * failed, and is noted rather than silently relied on.
 */
export function pickNewSession(before: CrushSessionMeta[], after: CrushSessionMeta[]): CrushSessionMeta | undefined {
  const known = new Set(before.map((s) => s.id));
  const fresh = after.filter((s) => !known.has(s.id));
  const pool = fresh.length ? fresh : after;
  return pool.reduce<CrushSessionMeta | undefined>((newest, candidate) => {
    if (!newest) return candidate;
    return (candidate.modified ?? "") > (newest.modified ?? "") ? candidate : newest;
  }, undefined);
}

/* -------------------------------------------------------------------------- */
/* Runtime                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Read one of Crush's `--json` subcommands.
 *
 * Goes through spawnCli, NOT execFile with `shell: true`. On Windows `crush` is an npm .cmd
 * shim, so a plain spawn needs a shell - and `shell: true` concatenates argv with no quoting at
 * all (Node warns about exactly this in DEP0190), which would put the agent's own working
 * directory path straight onto a cmd.exe command line where `&` or `%VAR%` in it would be
 * interpreted. spawnCli/cross-spawn applies the real Windows quoting rules instead; this is the
 * same reasoning that already governs the turn itself.
 */
function crushJson<T>(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<T | undefined> {
  return new Promise((resolve) => {
    let stdout = "";
    try {
      const child = spawnCli("crush", args, { cwd, env, stdio: ["ignore", "pipe", "ignore"] });
      child.stdout!.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.on("error", () => resolve(undefined));
      child.on("close", () => {
        try {
          resolve(JSON.parse(stdout.trim()) as T);
        } catch {
          resolve(undefined);
        }
      });
    } catch {
      resolve(undefined);
    }
  });
}

/** `crush run` prints this, verbatim and helpfully, when nothing is signed in. */
export function isNoProviderError(text: string): boolean {
  return /No providers configured/i.test(text);
}

export const crushAdapter: ProviderAdapter = {
  id: "crush",
  async runTurn({ cwd, prompt, trustLevel, model, effort, agentId, turnToken, sessionId, onEvent, signal }: RunTurnOptions): Promise<void> {
    const serverPort = SERVER_PORT;
    const config = buildCrushConfig(trustLevel, mcpServersForAgent(agentId));
    const configDir = writeTurnConfigDir(config, defaultGlobalConfigDir());
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CRUSH_GLOBAL_CONFIG: configDir,
      SOLACE_AGENT_ID: agentId,
      SOLACE_SERVER_PORT: String(serverPort),
      ...(turnToken ? { SOLACE_TURN_TOKEN: turnToken } : {}),
    };

    try {
      const before = sessionId
        ? []
        : (await crushJson<CrushSessionMeta[]>(["session", "list", "--json", "--cwd", cwd], cwd, env)) ?? [];

      const args = buildCrushArgs({ cwd, sessionId, model, effort });
      let stdoutBuffer = "";
      let stderrBuffer = "";
      let aborted = false;
      let exitCode: number | null = null;

      await new Promise<void>((resolve) => {
        const child = spawnCli("crush", args, { cwd, stdio: ["pipe", "pipe", "pipe"], env });
        child.stdin!.on("error", () => {});
        // Crush starts the turn once stdin reaches EOF, exactly like Claude Code's -p.
        child.stdin!.end(prompt);
        child.stdout!.on("data", (chunk) => {
          stdoutBuffer += chunk.toString();
        });
        child.stderr!.on("data", (chunk) => {
          stderrBuffer += chunk.toString();
        });

        const onAbort = () => {
          aborted = true;
          killCliTree(child);
        };
        signal?.addEventListener("abort", onAbort);

        child.on("close", (code) => {
          signal?.removeEventListener("abort", onAbort);
          exitCode = code;
          resolve();
        });
        child.on("error", (err) => {
          signal?.removeEventListener("abort", onAbort);
          stderrBuffer += `failed to start crush CLI: ${err.message}`;
          exitCode = -1;
          resolve();
        });
      });

      if (aborted) {
        onEvent({ type: "cancelled" });
        onEvent({ type: "done" });
        return;
      }

      // Resolve which session this turn belongs to before anything is replayed from it.
      let resolvedSessionId = sessionId;
      if (!resolvedSessionId) {
        const after = (await crushJson<CrushSessionMeta[]>(["session", "list", "--json", "--cwd", cwd], cwd, env)) ?? [];
        resolvedSessionId = pickNewSession(before, after)?.id;
        if (resolvedSessionId) onEvent({ type: "session", sessionId: resolvedSessionId });
      }

      const detail = resolvedSessionId
        ? await crushJson<CrushSessionDetail>(["session", "show", resolvedSessionId, "--json", "--cwd", cwd], cwd, env)
        : undefined;

      if (detail?.messages?.length) {
        for (const event of eventsFromSession(detail)) onEvent(event);
      } else if (stdoutBuffer.trim()) {
        // Session read failed (Crush rejected the id, the data dir is locked, ...). stdout is
        // still the real answer, so report it rather than losing the turn - just without the
        // tool calls and usage that only the session document carries.
        onEvent({ type: "text", text: stdoutBuffer.trim() });
      }

      if (exitCode !== 0 && stderrBuffer.trim()) {
        onEvent({ type: "error", message: stderrBuffer.trim() });
      }
      onEvent({ type: "done" });
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  },
};

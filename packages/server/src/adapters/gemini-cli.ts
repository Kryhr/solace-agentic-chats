import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as readline from "node:readline";
import { join } from "node:path";
import type { TrustLevel } from "@solace/shared";
import { killCliTree, spawnCli } from "../core/spawnCli";
import { mcpServersForAgent, type ResolvedMcpServer } from "../core/mcpServers";
import type { ProviderAdapter, RunTurnOptions } from "./types";

/** The group-chat MCP bridge, re-anchored to the *source* copy from the package root exactly as
 * claude-code.ts does - it's plain JS with no compile step, so the same path works under
 * `tsx watch` and in `dist/`. */
const SOLACE_BRIDGE_SCRIPT = join(__dirname, "..", "..", "src", "mcp", "solaceBridge.mjs");

/**
 * Trust level -> Gemini CLI's own --approval-mode. Verified against the real choice list the
 * CLI itself prints when handed an invalid value (`gemini --approval-mode __bogus__`):
 * "default", "auto_edit", "yolo", "plan". Four of our five map exactly.
 *
 * "auto" is the one approximation: Gemini has no LLM-classifier middle ground the way Qwen
 * does, so it collapses onto "yolo" - the same place "bypassPermissions" lands. That is a
 * widening, not a narrowing, so the permission catalog still offers both and the UI wording is
 * what distinguishes them; there is no safer flag that would still let an agent work unattended.
 *
 * Note the underscore: Gemini spells it "auto_edit" while Qwen's fork spells the same mode
 * "auto-edit". They are NOT interchangeable - passing the other CLI's spelling is a hard yargs
 * rejection before the turn starts.
 */
export function geminiApprovalMode(trustLevel: TrustLevel): string {
  switch (trustLevel) {
    case "bypassPermissions":
    case "auto":
      return "yolo";
    case "acceptEdits":
      return "auto_edit";
    case "manual":
      return "default";
    case "plan":
    default:
      return "plan";
  }
}

/**
 * Gemini has no --mcp-config flag (confirmed: `gemini --mcp-config '{}'` exits with "Unknown
 * arguments: mcp-config, mcpConfig"), so the only way to register the solace bridge for one
 * invocation is through a settings file. Gemini reads four settings layers and lets an env var
 * relocate two of them.
 *
 * GEMINI_CLI_SYSTEM_DEFAULTS_PATH is deliberately the one we use even though
 * GEMINI_CLI_SYSTEM_SETTINGS_PATH also exists: system-defaults is the LOWEST-precedence layer
 * and system-settings is the HIGHEST. Pointing the highest layer at a file of ours would mean
 * that if gemini ever replaced (rather than deep-merged) the mcpServers object, it would drop
 * the user's own MCP servers for every turn we run. Pointed at the lowest layer the same
 * failure mode instead drops OURS, which costs a feature rather than breaking the user's setup.
 * In practice gemini deep-merges these layers (mergeSettings -> customDeepMerge), so
 * mcpServers.solace coexists with whatever the user configured.
 *
 * Written to a fresh per-turn temp file, never to ~/.gemini/settings.json or
 * C:\ProgramData\gemini-cli\ - changing a real config file would alter every other gemini run
 * on this machine, including ones this app knows nothing about.
 *
 * Verified end to end on 2026-09-15: with this env var set, `gemini mcp list` reports the
 * solace server, and with the workspace trusted it is listed as enabled rather than "Disabled".
 *
 * `trust: true` is gemini's own documented per-server field for bypassing tool-call
 * confirmations, and is the non-deprecated equivalent of the pre-allow claude-code.ts does with
 * --allowedTools. Without it, in "default"/"plan" mode an agent asking its teammates a question
 * would raise an approval prompt nobody is there to answer. It widens nothing else: every other
 * tool is still governed by --approval-mode. (Gemini's own --allowed-tools is marked DEPRECATED
 * in favour of the policy engine, so it is deliberately not used here.)
 */
/**
 * The settings object itself, split out from the write so it can be asserted on without
 * touching the filesystem - see mcpServers.adapters.test.ts.
 */
export function geminiSettings(
  agentId: string,
  serverPort: number,
  turnToken?: string,
  userServers: ResolvedMcpServer[] = [],
): { mcpServers: Record<string, unknown> } {
  const mcpServers: Record<string, unknown> = {
    // No underscore in the alias on purpose: gemini's policy engine parses the fully
    // qualified name at the first underscore after the "mcp_" prefix, and an underscore in
    // the server alias makes security policies fail silently (its own documented warning).
    solace: {
      command: process.execPath,
      args: [SOLACE_BRIDGE_SCRIPT],
      env: {
        SOLACE_AGENT_ID: agentId,
        SOLACE_SERVER_PORT: String(serverPort),
        ...(turnToken ? { SOLACE_TURN_TOKEN: turnToken } : {}),
      },
      trust: true,
      description: "Solace group chat",
    },
  };
  // The user's servers go into the SAME system-defaults file, which is the lowest-precedence
  // settings layer gemini reads. That is the right layer for both: gemini deep-merges the
  // layers (mergeSettings -> customDeepMerge), so these coexist with anything in the user's own
  // ~/.gemini/settings.json - and if a future gemini ever replaced rather than merged, it would
  // drop OUR entries rather than the user's, which is the failure direction we can live with.
  //
  // `trust: true` is set only on the solace bridge, for the reason the block above explains. A
  // user server gets no trust flag, so --approval-mode still governs every one of its tools.
  //
  // The underscore caveat above applies to a user server's name too: a name containing "_" is
  // accepted here (the name is the user's, and silently rewriting it would break every other
  // adapter's tool ids) but gemini's policy engine may mis-parse it, which is why the UI warns
  // about underscores at the point the name is typed rather than here.
  for (const server of userServers) {
    if (server.name === "solace") continue;
    mcpServers[server.name] = { command: server.command, args: server.args, env: server.env };
  }
  return { mcpServers };
}

function writeSolaceSettings(
  agentId: string,
  serverPort: number,
  turnToken?: string,
  userServers: ResolvedMcpServer[] = [],
): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "solace-gemini-"));
  const path = join(dir, "system-defaults.json");
  writeFileSync(path, JSON.stringify(geminiSettings(agentId, serverPort, turnToken, userServers)), "utf-8");
  return { dir, path };
}

/**
 * Pure so it can be asserted on without spawning anything - see approvalMode.test.ts. The
 * prompt is deliberately NOT a parameter: it never belongs in argv (see the stdin note in
 * runTurn), and leaving it out of this signature is what makes that impossible to get wrong.
 */
export function buildGeminiArgs(opts: {
  trustLevel: TrustLevel;
  model?: string;
  /** The id to resume, or undefined on a first turn. */
  sessionId?: string;
  /** The id to register when this is a first turn. */
  newSessionId: string;
}): string[] {
  return [
    // Empty string, not a bare `-p`: gemini declares --prompt as a string option with nargs 1,
    // so a bare flag would swallow the next argument. The real prompt arrives on stdin, which
    // --prompt's own help confirms is supported ("Appended to input on stdin (if any)").
    // Verified through cross-spawn on Windows, where an empty argv element survives the
    // cmd.exe shim intact.
    "-p",
    "",
    "--output-format",
    "stream-json",
    // Without this, gemini refuses to run headless in any directory the user has not
    // interactively trusted - and observed on this machine, when folder trust is merely
    // advisory it silently downgrades the approval mode instead: "Approval mode overridden to
    // 'default' because the current folder is not trusted", which in headless mode means every
    // tool call is auto-denied. It also suppresses ALL configured MCP servers, so the solace
    // bridge would never connect. The workspace here is one the user explicitly picked for this
    // agent and assigned a trust level to, so re-asking gemini for consent it has no way to
    // obtain is not a safety gain. --skip-trust is scoped to this one session (it sets
    // GEMINI_CLI_TRUST_WORKSPACE for the child only).
    "--skip-trust",
    "--approval-mode",
    geminiApprovalMode(opts.trustLevel),
    ...(opts.sessionId ? ["--resume", opts.sessionId] : ["--session-id", opts.newSessionId]),
    ...(opts.model ? ["-m", opts.model] : []),
    // No reasoning-effort flag: `gemini --help` has none, so nothing is passed for `effort`
    // rather than inventing one. modelCatalog.ts reports no effort levels for this provider
    // for the same reason.
  ];
}

export const geminiCliAdapter: ProviderAdapter = {
  id: "gemini-cli",
  async runTurn({ cwd, prompt, trustLevel, model, agentId, turnToken, sessionId, onEvent, signal }: RunTurnOptions): Promise<void> {
    const serverPort = Number(process.env.PORT ?? 4310);
    // Same session model as claude-code.ts: gemini records every session automatically and
    // documents `gemini --resume <full session UUID>` alongside the index/"latest" forms, so we
    // pick the UUID ourselves on the first turn (--session-id takes "a manually provided UUID")
    // and resume it by id after that. Deliberately NOT `--resume latest`: like codex's `--last`
    // that is scoped to the whole project, so two gemini agents in the same workspace would
    // resume each other's conversation.
    const resolvedSessionId = sessionId ?? randomUUID();
    if (!sessionId) onEvent({ type: "session", sessionId: resolvedSessionId });

    const args = buildGeminiArgs({ trustLevel, model, sessionId, newSessionId: resolvedSessionId });

    const settings = writeSolaceSettings(agentId, serverPort, turnToken, mcpServersForAgent(agentId));

    await new Promise<void>((resolve) => {
      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        try {
          rmSync(settings.dir, { recursive: true, force: true });
        } catch {
          // A leftover file in the OS temp dir is not worth failing a completed turn over.
        }
      };

      const child = spawnCli("gemini", args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          GEMINI_CLI_SYSTEM_DEFAULTS_PATH: settings.path,
          SOLACE_AGENT_ID: agentId,
          SOLACE_SERVER_PORT: String(serverPort),
          ...(turnToken ? { SOLACE_TURN_TOKEN: turnToken } : {}),
        },
      });
      // gemini only starts the turn once stdin reaches EOF, so this must always end(). An
      // EPIPE here (child died before reading) is not worth crashing the server over - the
      // close/error handlers below already report the real failure.
      child.stdin!.on("error", () => {});
      child.stdin!.end(prompt);
      const rl = readline.createInterface({ input: child.stdout! });

      let aborted = false;
      const onAbort = () => {
        aborted = true;
        // Not child.kill(): on Windows that leaves the real CLI (and the per-turn MCP bridge it
        // spawned) running against a turn we already gave up on. See killCliTree.
        killCliTree(child);
      };
      signal?.addEventListener("abort", onAbort);

      let reportedError = false;
      rl.on("line", (line) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line);
          // Gemini's stream-json schema, read off the emitEvent call sites in the installed
          // bundle (v0.59.0) rather than guessed - it is NOT Claude Code's schema:
          //   {"type":"init","session_id":...,"model":...}
          //   {"type":"message","role":"user"|"assistant","content":...,"delta":true}
          //   {"type":"tool_use","tool_name":...,"tool_id":...,"parameters":{...}}
          //   {"type":"tool_result","tool_id":...,"status":"success"|"error","output":...}
          //   {"type":"error","severity":"error"|"warning","message":...}
          //   {"type":"result","status":"success"|"error","error":{...},"stats":{...}}
          switch (event.type) {
            case "init": {
              // The stream is the authority on what the session actually is: if gemini ever
              // rejects our id or forks the session, resuming the id we invented would silently
              // start a fresh conversation every turn.
              if (typeof event.session_id === "string" && event.session_id && event.session_id !== resolvedSessionId) {
                onEvent({ type: "session", sessionId: event.session_id });
              }
              // The model gemini actually resolved the request to. "auto-gemini-2.5" is a
              // routing alias, so this is the only honest way to say which model answered.
              if (typeof event.model === "string" && event.model) onEvent({ type: "model", model: event.model });
              break;
            }
            case "message": {
              // role "user" is our own prompt echoed back; only the assistant's side is output.
              if (event.role === "assistant" && typeof event.content === "string" && event.content) {
                onEvent({ type: "text", text: event.content });
              }
              break;
            }
            case "tool_use": {
              onEvent({
                type: "tool-use",
                description: `${event.tool_name}(${JSON.stringify(event.parameters ?? {})})`,
                toolName: typeof event.tool_name === "string" ? event.tool_name : undefined,
                input: event.parameters ?? {},
              });
              break;
            }
            case "error": {
              // severity is genuinely part of the event: "warning" is an in-stream notice the
              // turn survives, and reporting it as an error would fail a turn that succeeded.
              if (event.severity === "error" && event.message) {
                reportedError = true;
                onEvent({ type: "error", message: String(event.message) });
              } else if (event.message) {
                onEvent({ type: "tool-use", description: `note: ${event.message}` });
              }
              break;
            }
            case "result": {
              if (event.status === "error" && event.error?.message && !reportedError) {
                reportedError = true;
                onEvent({ type: "error", message: String(event.error.message) });
              }
              const stats = event.stats;
              if (stats && (typeof stats.input_tokens === "number" || typeof stats.output_tokens === "number")) {
                // No cost field: gemini reports tokens per model and in aggregate but never a
                // price, so totalCostUsd stays absent rather than being derived from a rate
                // card this app has no way to know is current.
                onEvent({
                  type: "usage",
                  usage: { inputTokens: stats.input_tokens, outputTokens: stats.output_tokens },
                });
              }
              break;
            }
            default:
              break;
          }
        } catch {
          // Non-JSON line (shouldn't normally happen with --output-format stream-json) -
          // surface it as plain text rather than dropping it silently.
          onEvent({ type: "text", text: line });
        }
      });

      // gemini writes informational notices to stderr even on success (the YOLO-mode banner,
      // for one), so don't treat stderr output itself as failure - only report it if the
      // process exits non-zero and the stream didn't already say something more specific.
      let stderrBuffer = "";
      child.stderr!.on("data", (chunk) => {
        stderrBuffer += chunk.toString();
      });

      child.on("close", (code) => {
        signal?.removeEventListener("abort", onAbort);
        cleanup();
        if (aborted) {
          // Why it was aborted is the caller's knowledge, not ours - see AdapterEvent.cancelled.
          onEvent({ type: "cancelled" });
        } else if (code !== 0 && !reportedError && stderrBuffer.trim()) {
          onEvent({ type: "error", message: stderrBuffer.trim() });
        }
        onEvent({ type: "done" });
        resolve();
      });

      child.on("error", (err) => {
        signal?.removeEventListener("abort", onAbort);
        cleanup();
        onEvent({ type: "error", message: `failed to start gemini CLI: ${err.message}` });
        onEvent({ type: "done" });
        resolve();
      });
    });
  },
};

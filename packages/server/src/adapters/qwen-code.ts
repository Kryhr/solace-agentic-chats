import { randomUUID } from "node:crypto";
import * as readline from "node:readline";
import { join } from "node:path";
import type { TrustLevel } from "@solace/shared";
import { killCliTree, spawnCli } from "../core/spawnCli";
import type { ProviderAdapter, RunTurnOptions } from "./types";

/** The group-chat MCP bridge, re-anchored to the *source* copy from the package root exactly as
 * claude-code.ts does - it's plain JS with no compile step, so the same path works under
 * `tsx watch` and in `dist/`. */
const SOLACE_BRIDGE_SCRIPT = join(__dirname, "..", "..", "src", "mcp", "solaceBridge.mjs");

/** Qwen addresses MCP tools as mcp__<server>__<tool>, same as Claude Code (confirmed: the
 * template literal `mcp__${serverName}__${serverToolName}` in the installed bundle). Gemini,
 * despite the shared ancestry, uses a single-underscore form - which is why gemini-cli.ts
 * grants the bridge through its server config instead of a tool allowlist. */
const SOLACE_TOOLS = [
  "mcp__solace__post_to_group",
  "mcp__solace__list_agents",
  // Coordination tools are pre-allowed for the same reason post_to_group is: they are
  // bookkeeping inside this app - a claim, a contract, an announcement, a wake-up - with no
  // effect on the user's machine. get_secret is deliberately NOT here; that one reads real
  // credentials and goes through approval.
  "mcp__solace__claim_files",
  "mcp__solace__release_files",
  "mcp__solace__post_contract",
  "mcp__solace__announce",
  "mcp__solace__block_on",
];

/**
 * Trust level -> Qwen Code's own --approval-mode. This is a true 1:1 mapping, not an
 * approximation: Qwen's five modes are exactly our five TrustLevel values.
 *
 * Verified empirically rather than from --help, which matters here: `qwen --help` prints a
 * hand-curated subset (TOP_LEVEL_HELP_OPTIONS in its cli.js) that omits --approval-mode,
 * --mcp-config, --session-id and --allowed-tools entirely, while the real parser accepts all of
 * them. Handing the CLI an invalid value makes it print the authoritative list:
 *
 *   $ qwen --approval-mode __bogus__ -p ""
 *   Argument: approval-mode, Given: "__bogus__", Choices: "plan", "default", "auto-edit", "auto", "yolo"
 *
 * Qwen's "auto" is a real mode, not a synonym for yolo: an LLM classifier judges each tool call
 * and auto-approves the safe ones while blocking risky ones. That is genuinely our "auto"
 * (unattended but not unrestricted), so unlike Gemini this provider does not have to collapse
 * "auto" onto "yolo".
 *
 * Note the spelling: Qwen takes "auto-edit" with a hyphen where Gemini takes "auto_edit" with
 * an underscore. Passing the other CLI's spelling is a hard yargs rejection before the turn
 * starts, so the two mappings stay separate functions rather than one shared one.
 */
export function qwenApprovalMode(trustLevel: TrustLevel): string {
  switch (trustLevel) {
    case "bypassPermissions":
      return "yolo";
    case "auto":
      return "auto";
    case "acceptEdits":
      return "auto-edit";
    case "manual":
      return "default";
    case "plan":
    default:
      return "plan";
  }
}

/**
 * Qwen does have a real --mcp-config, taking the same {"mcpServers": {...}} JSON string Claude
 * Code's does (confirmed by running a turn with it: qwen accepted the flag and got as far as
 * its auth check). So unlike codex-cli.ts there is nothing inferred here and no fallback
 * re-run is needed, and unlike gemini-cli.ts nothing has to be written to a settings file.
 *
 * env is passed explicitly inside the server entry rather than relied upon through inheritance,
 * for the reason codex-cli.ts documents: an MCP server the CLI spawns is not guaranteed to
 * inherit our environment, and without SOLACE_AGENT_ID / SOLACE_TURN_TOKEN the bridge has no
 * identity and the server refuses every tool call.
 *
 * process.execPath rather than "node" so this doesn't depend on whatever PATH qwen hands its
 * MCP child.
 */
function solaceMcpConfig(agentId: string, serverPort: number, turnToken?: string): string {
  return JSON.stringify({
    mcpServers: {
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
    },
  });
}

/**
 * Pure so it can be asserted on without spawning anything - see approvalMode.test.ts. The
 * prompt is deliberately NOT a parameter: it never belongs in argv (see the stdin note below),
 * and leaving it out of this signature is what makes that impossible to get wrong.
 */
export function buildQwenArgs(opts: {
  trustLevel: TrustLevel;
  model?: string;
  /** The id to resume, or undefined on a first turn. */
  sessionId?: string;
  /** The id to register when this is a first turn. */
  newSessionId: string;
  agentId: string;
  serverPort: number;
  turnToken?: string;
}): string[] {
  return [
    // Empty string, not a bare `-p`: --prompt is a string option, so a bare flag would swallow
    // the next argument. The prompt itself goes on STDIN and never as an argv element - `qwen`
    // installs as qwen.cmd on Windows (confirmed: it resolves to
    // AppData\Local\qwen-code\bin\qwen.cmd), so cross-spawn routes it through cmd.exe, whose
    // command line is TERMINATED by a literal newline with everything after it silently
    // discarded. Every group prompt is multi-line, so passing it as an argument would deliver
    // only the context header and none of the task; see the long note in core/spawnCli.ts for
    // the real debugging session that cost. --prompt's own help confirms stdin is the supported
    // channel ("Appended to input on stdin (if any)").
    "-p",
    "",
    "--output-format",
    "stream-json",
    "--approval-mode",
    qwenApprovalMode(opts.trustLevel),
    "--mcp-config",
    solaceMcpConfig(opts.agentId, opts.serverPort, opts.turnToken),
    // Pre-allow only our own two coordination tools, exactly as claude-code.ts does: without
    // it, in "default" mode every post_to_group call would raise an approval card - i.e. the
    // user would have to click to let one agent talk to another, which defeats the point - and
    // headless runs auto-deny anything still unapproved. This is an allowlist; the approval
    // mode still governs every other tool.
    "--allowed-tools",
    SOLACE_TOOLS.join(","),
    ...(opts.sessionId ? ["--resume", opts.sessionId] : ["--session-id", opts.newSessionId]),
    ...(opts.model ? ["-m", opts.model] : []),
    // No reasoning-effort flag on the top-level command (`qwen review` has an --effort, the
    // agent command does not), so nothing is passed for `effort` rather than inventing one.
    // modelCatalog.ts reports no effort levels for this provider for the same reason.
  ];
}

export const qwenCodeAdapter: ProviderAdapter = {
  id: "qwen-code",
  async runTurn({ cwd, prompt, trustLevel, model, agentId, turnToken, sessionId, onEvent, signal }: RunTurnOptions): Promise<void> {
    const serverPort = Number(process.env.PORT ?? 4310);
    // Qwen accepts BOTH --session-id (undocumented in --help: "Specify a session ID for this
    // run") and --resume <id>, so this is the same first-turn-picks-the-id pattern as
    // claude-code.ts. Deliberately NOT -c/--continue: like codex's `--last` that resumes "the
    // most recent session for the current project", so two qwen agents sharing a workspace
    // would resume each other's conversation. Confirmed working: qwen echoed our chosen id back
    // as session_id in its stream output.
    const resolvedSessionId = sessionId ?? randomUUID();
    if (!sessionId) onEvent({ type: "session", sessionId: resolvedSessionId });

    const args = buildQwenArgs({
      trustLevel,
      model,
      sessionId,
      newSessionId: resolvedSessionId,
      agentId,
      serverPort,
      turnToken,
    });

    await new Promise<void>((resolve) => {
      const child = spawnCli("qwen", args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          SOLACE_AGENT_ID: agentId,
          SOLACE_SERVER_PORT: String(serverPort),
          ...(turnToken ? { SOLACE_TURN_TOKEN: turnToken } : {}),
          // Silences the "running headless with yolo and no sandbox" banner qwen writes to
          // stderr on every bypassPermissions turn. It is not suppressing a real problem: the
          // user chose that trust level in the UI, and leaving it on meant a stderr buffer that
          // a non-zero exit would then report to the group chat as if it were the failure.
          QWEN_CODE_SUPPRESS_YOLO_WARNING: "1",
        },
      });
      // qwen only starts the turn once stdin reaches EOF, so this must always end(). An EPIPE
      // here (child died before reading) is not worth crashing the server over - the
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
      let reportedModel: string | undefined;
      rl.on("line", (line) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line);
          // Qwen's stream-json is the Claude Code Agent SDK schema, NOT its Gemini ancestor's -
          // {"type":"assistant","message":{"content":[...]}} blocks and a terminal
          // {"type":"result","session_id":...,"usage":{...}}. Read off the message builders in
          // the installed bundle (v0.22.3) and confirmed against a real invocation, whose error
          // result came back as
          // {"type":"result","subtype":"error_during_execution","session_id":...,"is_error":true,
          //  "usage":{"input_tokens":0,"output_tokens":0},"error":{"message":...}}.
          if (typeof event.session_id === "string" && event.session_id && event.session_id !== resolvedSessionId) {
            // Belt and braces: if the CLI ever rejects our id or forks the session, the stream
            // is the authority on what the session actually is.
            onEvent({ type: "session", sessionId: event.session_id });
          }
          const model = event?.message?.model;
          if (typeof model === "string" && model && model !== reportedModel) {
            reportedModel = model;
            onEvent({ type: "model", model });
          }
          // Only the assistant's own blocks are output; type "user" carries tool results being
          // fed back in, which are not this agent's speech.
          const content = event.type === "assistant" ? event?.message?.content : undefined;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text" && block.text) {
                onEvent({ type: "text", text: block.text });
              } else if (block.type === "thinking" && block.thinking) {
                onEvent({ type: "reasoning", text: block.thinking });
              } else if (block.type === "tool_use") {
                onEvent({
                  type: "tool-use",
                  description: `${block.name}(${JSON.stringify(block.input)})`,
                  toolName: block.name,
                  input: block.input,
                });
              }
            }
          } else if (event.type === "result") {
            if (event.is_error && event.error?.message) {
              reportedError = true;
              onEvent({ type: "error", message: String(event.error.message) });
            }
            if (event.usage) {
              // No cost field: qwen reports tokens but never a price, so totalCostUsd stays
              // absent rather than being derived from a rate card this app has no way to know
              // is current.
              onEvent({
                type: "usage",
                usage: { inputTokens: event.usage.input_tokens, outputTokens: event.usage.output_tokens },
              });
            }
          }
        } catch {
          // Non-JSON line (shouldn't normally happen with --output-format stream-json) -
          // surface it as plain text rather than dropping it silently.
          onEvent({ type: "text", text: line });
        }
      });

      // qwen writes informational notices to stderr even on success, so don't treat stderr
      // output itself as failure - only report it if the process exits non-zero and the stream
      // didn't already say something more specific.
      let stderrBuffer = "";
      child.stderr!.on("data", (chunk) => {
        stderrBuffer += chunk.toString();
      });

      child.on("close", (code) => {
        signal?.removeEventListener("abort", onAbort);
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
        onEvent({ type: "error", message: `failed to start qwen CLI: ${err.message}` });
        onEvent({ type: "done" });
        resolve();
      });
    });
  },
};

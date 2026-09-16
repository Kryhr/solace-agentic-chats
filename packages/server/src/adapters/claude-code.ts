import { randomUUID } from "node:crypto";
import * as readline from "node:readline";
import { join } from "node:path";
import type { TrustLevel } from "@solace/shared";
import { killCliTree, spawnCli } from "../core/spawnCli";
import { parseClaudeRateLimitEvent } from "../core/rateLimits";
import { mcpServersForAgent, type ResolvedMcpServer } from "../core/mcpServers";
import type { ProviderAdapter, RunTurnOptions } from "./types";

// Always re-anchor from the package root (two levels up from this compiled/ts-node file,
// whether that's dist/adapters/ in a production build or src/adapters/ under tsx) to the
// *source* copy of the bridge script - it's plain JS with no compile step, so referencing it
// directly works identically in both dev and prod.
const BRIDGE_SCRIPT = join(__dirname, "..", "..", "src", "approval", "bridgeScript.mjs");
/** The group-chat bridge, resolved the same way and for the same reason as BRIDGE_SCRIPT. */
const SOLACE_BRIDGE_SCRIPT = join(__dirname, "..", "..", "src", "mcp", "solaceBridge.mjs");

/** Claude Code addresses MCP tools as mcp__<server>__<tool>. */
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
 * Trust level -> Claude Code's own --permission-mode flag. Our TrustLevel enum now IS Claude
 * Code's real enum (verified via `claude --help`), so this is a direct 1:1 pass-through
 * rather than an approximation. "manual" additionally gets the live approval-bridge flags
 * wiring Claude's own --permission-prompt-tool to our approval/bridgeScript.mjs (see
 * ARCHITECTURE.md#trust-levels for the full mechanism, verified empirically 2026-09-15).
 *
 * The solace group-chat bridge (mcp/solaceBridge.mjs) is included at EVERY trust level, not
 * just "manual": talking to your teammates mid-turn is not a privileged operation, and gating
 * it on trust level would mean most agents silently kept the old behaviour of only ever
 * reaching the group after their turn already ended. --strict-mcp-config still means these are
 * the only MCP servers in play.
 *
 * That bridge also carries get_secret, which IS privileged - so it is gated where the decision
 * can actually be trusted, in the server's /internal/solace/secret route, rather than by which
 * tools this flag list happens to expose. A tool list is a suggestion to the model; the route
 * check is the thing an agent cannot talk its way past.
 */
export function flagsForTrustLevel(trustLevel: TrustLevel, userServers: ResolvedMcpServer[] = []): string[] {
  const manual = trustLevel === "manual";
  const mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {
    solace: { command: "node", args: [SOLACE_BRIDGE_SCRIPT] },
  };
  if (manual) mcpServers["approval-bridge"] = { command: "node", args: [BRIDGE_SCRIPT] };
  // The user's own servers are MERGED into the object we build, never appended as a second
  // flag, because --strict-mcp-config below means this JSON is the COMPLETE set of MCP servers
  // for the turn - Claude Code ignores ~/.claude.json entirely when it is set. So a user server
  // that is not in here does not "also" get loaded from the user's config; it simply does not
  // exist for this turn. Written after the two bridges so a name collision cannot displace
  // them - though validateMcpServer already rejects both reserved names at the write boundary,
  // which is where a collision should be explained to a human rather than silently resolved.
  for (const server of userServers) {
    if (server.name === "solace" || server.name === "approval-bridge") continue;
    mcpServers[server.name] = { command: server.command, args: server.args, env: server.env };
  }

  return [
    "--permission-mode",
    trustLevel,
    ...(manual ? ["--permission-prompt-tool", "mcp__approval-bridge__permission", "--permission-prompts", "host"] : []),
    "--mcp-config",
    JSON.stringify({ mcpServers }),
    "--strict-mcp-config",
    // Pre-allow only our own two coordination tools. Without this, in "manual" mode every
    // post_to_group call would raise a human approval card - i.e. the user would have to click
    // to let one agent talk to another, which defeats the point - and in "plan" mode it isn't
    // obvious the tools are reachable at all. This is an allowlist: it does not widen anything
    // else, and the permission mode still governs every other tool.
    // Deliberately only OUR tools. A user MCP server's tools are not added here: they go
    // through whatever --permission-mode the agent's trust level set, exactly like the CLI's
    // own built-in tools do. Pre-allowing them would mean registering a server silently
    // widened what an agent may do without asking - and unlike post_to_group, we cannot see
    // what a third-party tool actually touches.
    "--allowedTools",
    SOLACE_TOOLS.join(","),
  ];
}

export const claudeCodeAdapter: ProviderAdapter = {
  id: "claude-code",
  async runTurn({ cwd, prompt, trustLevel, model, effort, agentId, turnToken, sessionId, onEvent, signal }: RunTurnOptions): Promise<void> {
    const serverPort = Number(process.env.PORT ?? 4310);
    // The prompt goes in on STDIN, never as an argv element. On Windows `claude` resolves to
    // an npm .cmd shim, so cross-spawn has to route it through `cmd.exe /d /s /c` - and a
    // cmd.exe command line is TERMINATED by a literal newline, with everything after it
    // silently discarded. Every group-chat prompt is multi-line (buildGroupPrompt puts the
    // roster/identity block, then a blank line, then the actual message), so Claude Code was
    // receiving ONLY the context header and none of the real task - which is exactly what it
    // reported live: "I don't see an actual message or task in this turn, just system
    // context." Codex was unaffected purely because it installs as a native codex.exe that
    // bypasses cmd.exe entirely. Reproduced through a .cmd shim and re-verified against the
    // real CLI via stdin on 2026-09-15. `claude -p` with no positional prompt reads stdin,
    // which has no length or newline limits at all.
    // Every turn used to be a brand-new stateless process, so an agent had no memory of its
    // own previous turns: one said "I'll make both fixes and ping back when done", exited, and
    // later truthfully answered that it had no task in progress. Claude Code persists print-mode
    // sessions by default, so we pick the id ourselves on the first turn (--session-id wants a
    // real UUID) and resume it after that. Choosing the id up front means we know it even if the
    // turn dies before we parse a single line of output.
    const resolvedSessionId = sessionId ?? randomUUID();
    if (!sessionId) onEvent({ type: "session", sessionId: resolvedSessionId });
    const args = [
      "-p",
      ...(sessionId ? ["--resume", sessionId] : ["--session-id", resolvedSessionId]),
      "--output-format",
      "stream-json",
      "--verbose",
      ...flagsForTrustLevel(trustLevel, mcpServersForAgent(agentId)),
      ...(model ? ["--model", model] : []),
      ...(effort ? ["--effort", effort] : []),
    ];

    await new Promise<void>((resolve) => {
      const child = spawnCli("claude", args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          SOLACE_AGENT_ID: agentId,
          SOLACE_SERVER_PORT: String(serverPort),
          ...(turnToken ? { SOLACE_TURN_TOKEN: turnToken } : {}),
        },
      });
      // Claude Code only starts the turn once stdin reaches EOF, so this must always end().
      // An EPIPE here (child died before reading) is not worth crashing the server over - the
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

      let reportedModel: string | undefined;
      rl.on("line", (line) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line);
          // Claude Code interleaves {"type":"rate_limit_event"} lines into the same stream,
          // carrying the real utilization of the account's 5-hour and 7-day windows. It is
          // undocumented, so the parser returns null for anything it doesn't fully recognise
          // and we simply emit nothing in that case.
          const rateLimit = parseClaudeRateLimitEvent(event, new Date().toISOString());
          if (rateLimit) onEvent({ type: "rate-limit", rateLimit });
          // The model the provider actually resolved the request to. "sonnet" is an alias, so
          // this is the only way to say which Sonnet a message really came from.
          // Belt and braces: if the CLI ever rejects our id or forks the session, the stream is
          // the authority on what the session actually is.
          const streamSessionId = event?.session_id;
          if (typeof streamSessionId === "string" && streamSessionId && streamSessionId !== resolvedSessionId) {
            onEvent({ type: "session", sessionId: streamSessionId });
          }
          const model = event?.message?.model;
          if (typeof model === "string" && model && model !== reportedModel) {
            reportedModel = model;
            onEvent({ type: "model", model });
          }
          // Claude Code's stream-json emits {type: "assistant", message: {content: [...]}}
          // and tool-use blocks inside that content array. Schema per code.claude.com/docs/en/headless.
          const content = event?.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text" && block.text) {
                onEvent({ type: "text", text: block.text });
              } else if (block.type === "thinking" && block.thinking) {
                // Extended-thinking blocks used to fall through this loop entirely (only "text"
                // and "tool_use" were handled), so an agent's reasoning was simply dropped -
                // which is exactly the "it doesn't show their whole thinking" complaint.
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
          } else if (event.type === "result" && event.usage) {
            // Final message of the stream - real per-turn cost/token usage as Claude Code
            // itself reports it. See code.claude.com/docs/en/headless.
            onEvent({
              type: "usage",
              usage: {
                inputTokens: event.usage.input_tokens,
                outputTokens: event.usage.output_tokens,
                totalCostUsd: event.total_cost_usd,
              },
            });
          }
        } catch {
          // Non-JSON line (shouldn't normally happen with --output-format stream-json) -
          // surface it as plain text rather than dropping it silently.
          onEvent({ type: "text", text: line });
        }
      });

      // Claude Code can write informational notices to stderr even on success, so don't
      // treat stderr output itself as failure - only report it if the process exits non-zero.
      let stderrBuffer = "";
      child.stderr!.on("data", (chunk) => {
        stderrBuffer += chunk.toString();
      });

      child.on("close", (code) => {
        signal?.removeEventListener("abort", onAbort);
        if (aborted) {
          // Why it was aborted is the caller's knowledge, not ours - see AdapterEvent.cancelled.
          onEvent({ type: "cancelled" });
        } else if (code !== 0 && stderrBuffer.trim()) {
          onEvent({ type: "error", message: stderrBuffer.trim() });
        }
        onEvent({ type: "done" });
        resolve();
      });

      child.on("error", (err) => {
        signal?.removeEventListener("abort", onAbort);
        onEvent({ type: "error", message: `failed to start claude CLI: ${err.message}` });
        onEvent({ type: "done" });
        resolve();
      });
    });
  },
};

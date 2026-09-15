import * as readline from "node:readline";
import { join } from "node:path";
import type { TrustLevel } from "@solace/shared";
import { spawnCli } from "../core/spawnCli";
import type { ProviderAdapter, RunTurnOptions } from "./types";

// Always re-anchor from the package root (two levels up from this compiled/ts-node file,
// whether that's dist/adapters/ in a production build or src/adapters/ under tsx) to the
// *source* copy of the bridge script - it's plain JS with no compile step, so referencing it
// directly works identically in both dev and prod.
const BRIDGE_SCRIPT = join(__dirname, "..", "..", "src", "approval", "bridgeScript.mjs");

/**
 * Trust level -> Claude Code's own --permission-mode flag. Our TrustLevel enum now IS Claude
 * Code's real enum (verified via `claude --help`), so this is a direct 1:1 pass-through
 * rather than an approximation. "manual" additionally gets the live approval-bridge flags
 * wiring Claude's own --permission-prompt-tool to our approval/bridgeScript.mjs (see
 * ARCHITECTURE.md#trust-levels for the full mechanism, verified empirically 2026-09-15).
 */
function flagsForTrustLevel(trustLevel: TrustLevel): string[] {
  const base = ["--permission-mode", trustLevel];
  if (trustLevel !== "manual") return base;

  const mcpConfig = JSON.stringify({
    mcpServers: { "approval-bridge": { command: "node", args: [BRIDGE_SCRIPT] } },
  });
  return [
    ...base,
    "--permission-prompt-tool",
    "mcp__approval-bridge__permission",
    "--permission-prompts",
    "host",
    "--mcp-config",
    mcpConfig,
    "--strict-mcp-config",
  ];
}

export const claudeCodeAdapter: ProviderAdapter = {
  id: "claude-code",
  async runTurn({ cwd, prompt, trustLevel, model, effort, agentId, onEvent, signal }: RunTurnOptions): Promise<void> {
    const serverPort = Number(process.env.PORT ?? 4310);
    const args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      ...flagsForTrustLevel(trustLevel),
      ...(model ? ["--model", model] : []),
      ...(effort ? ["--effort", effort] : []),
    ];

    await new Promise<void>((resolve) => {
      const child = spawnCli("claude", args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, SOLACE_AGENT_ID: agentId, SOLACE_SERVER_PORT: String(serverPort) },
      });
      const rl = readline.createInterface({ input: child.stdout! });

      let timedOut = false;
      const onAbort = () => {
        timedOut = true;
        child.kill();
      };
      signal?.addEventListener("abort", onAbort);

      rl.on("line", (line) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line);
          // Claude Code's stream-json emits {type: "assistant", message: {content: [...]}}
          // and tool-use blocks inside that content array. Schema per code.claude.com/docs/en/headless.
          const content = event?.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text" && block.text) {
                onEvent({ type: "text", text: block.text });
              } else if (block.type === "tool_use") {
                onEvent({ type: "tool-use", description: `${block.name}(${JSON.stringify(block.input)})` });
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
        if (timedOut) {
          onEvent({ type: "error", message: "turn cancelled: exceeded the maximum turn duration" });
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

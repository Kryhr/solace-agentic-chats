import * as readline from "node:readline";
import type { TrustLevel } from "@solace/shared";
import { spawnCli } from "../core/spawnCli";
import type { ProviderAdapter, RunTurnOptions } from "./types";

/**
 * Trust level -> Claude Code CLI flags for this turn.
 *
 * v1 semantics (deliberately simple, see ARCHITECTURE.md#trust-levels):
 *   confirm-all    -> read-only tools only, nothing can be changed without a human doing it
 *   confirm-risky  -> read + edit/write files, but no shell/network access
 *   auto-approve   -> full --dangerously-skip-permissions, agent runs unattended
 *
 * True per-action human approval (an "approve this one tool call" popup in the UI) needs
 * Claude Code's --permission-prompt-tool / hooks wiring and is tracked as a roadmap item,
 * not implemented in this skeleton.
 */
function flagsForTrustLevel(trustLevel: TrustLevel): string[] {
  switch (trustLevel) {
    case "auto-approve":
      return ["--dangerously-skip-permissions"];
    case "confirm-risky":
      return ["--allowedTools", "Read,Grep,Glob,Edit,Write"];
    case "confirm-all":
    default:
      return ["--allowedTools", "Read,Grep,Glob"];
  }
}

export const claudeCodeAdapter: ProviderAdapter = {
  id: "claude-code",
  async runTurn({ cwd, prompt, trustLevel, model, effort, onEvent, signal }: RunTurnOptions): Promise<void> {
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
      const child = spawnCli("claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
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

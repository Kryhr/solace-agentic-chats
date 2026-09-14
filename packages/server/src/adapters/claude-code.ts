import { spawn } from "node:child_process";
import * as readline from "node:readline";
import type { TrustLevel } from "@solace/shared";
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
  async runTurn({ cwd, prompt, trustLevel, onEvent }: RunTurnOptions): Promise<void> {
    const args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      ...flagsForTrustLevel(trustLevel),
    ];

    await new Promise<void>((resolve) => {
      const child = spawn("claude", args, { cwd, shell: process.platform === "win32" });
      const rl = readline.createInterface({ input: child.stdout });

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
          }
        } catch {
          // Non-JSON line (shouldn't normally happen with --output-format stream-json) -
          // surface it as plain text rather than dropping it silently.
          onEvent({ type: "text", text: line });
        }
      });

      child.stderr.on("data", (chunk) => {
        onEvent({ type: "error", message: chunk.toString() });
      });

      child.on("close", () => {
        onEvent({ type: "done" });
        resolve();
      });

      child.on("error", (err) => {
        onEvent({ type: "error", message: `failed to start claude CLI: ${err.message}` });
        onEvent({ type: "done" });
        resolve();
      });
    });
  },
};

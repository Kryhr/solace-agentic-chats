import * as readline from "node:readline";
import type { TrustLevel } from "@solace/shared";
import { spawnCli } from "../core/spawnCli";
import type { ProviderAdapter, RunTurnOptions } from "./types";

/**
 * Trust level -> Codex CLI `codex exec` sandbox flags, same three-tier approximation as
 * the Claude Code adapter (see ARCHITECTURE.md#trust-levels).
 */
function sandboxFlagsForTrustLevel(trustLevel: TrustLevel): string[] {
  switch (trustLevel) {
    case "auto-approve":
      return ["--dangerously-bypass-approvals-and-sandbox"];
    case "confirm-risky":
      return ["--sandbox", "workspace-write"];
    case "confirm-all":
    default:
      return ["--sandbox", "read-only"];
  }
}

export const codexCliAdapter: ProviderAdapter = {
  id: "codex-cli",
  async runTurn({ cwd, prompt, trustLevel, onEvent, signal }: RunTurnOptions): Promise<void> {
    const args = [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-C",
      cwd,
      ...sandboxFlagsForTrustLevel(trustLevel),
      prompt,
    ];

    await new Promise<void>((resolve) => {
      const child = spawnCli("codex", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      const rl = readline.createInterface({ input: child.stdout! });

      let reportedError = false;
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
          // Schema: {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
          // plus item types like command_execution/file_change/reasoning we surface as tool-use
          // ("error" items are non-fatal in-stream notices, e.g. truncated skill descriptions -
          // shown as a note, not a failure), and top-level {"type":"turn.failed", ...} for the
          // terminal failure of the whole turn - "turn.failed" always follows a top-level
          // {"type":"error"} with the same message, so only act on turn.failed to avoid
          // reporting the same failure twice.
          if (event.type === "item.completed" && event.item) {
            if (event.item.type === "agent_message" && event.item.text) {
              onEvent({ type: "text", text: event.item.text });
            } else if (event.item.type === "error") {
              onEvent({ type: "tool-use", description: `note: ${event.item.message ?? "codex reported a notice"}` });
            } else {
              onEvent({ type: "tool-use", description: event.item.type });
            }
          } else if (event.type === "turn.failed") {
            reportedError = true;
            onEvent({ type: "error", message: event.error?.message ?? "codex exec reported an error" });
          }
        } catch {
          onEvent({ type: "text", text: line });
        }
      });

      // codex exec writes informational notices to stderr even on success, so don't treat
      // stderr output itself as failure - only fall back to it if the process exited non-zero
      // and nothing more specific was already reported from the JSONL stream above.
      let stderrBuffer = "";
      child.stderr!.on("data", (chunk) => {
        stderrBuffer += chunk.toString();
      });

      child.on("close", (code) => {
        signal?.removeEventListener("abort", onAbort);
        if (timedOut) {
          onEvent({ type: "error", message: "turn cancelled: exceeded the maximum turn duration" });
        } else if (code !== 0 && !reportedError && stderrBuffer.trim()) {
          onEvent({ type: "error", message: stderrBuffer.trim() });
        }
        onEvent({ type: "done" });
        resolve();
      });

      child.on("error", (err) => {
        signal?.removeEventListener("abort", onAbort);
        onEvent({ type: "error", message: `failed to start codex CLI: ${err.message}` });
        onEvent({ type: "done" });
        resolve();
      });
    });
  },
};

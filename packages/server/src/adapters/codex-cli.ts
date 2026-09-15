import * as readline from "node:readline";
import type { TrustLevel } from "@solace/shared";
import { spawnCli } from "../core/spawnCli";
import type { ProviderAdapter, RunTurnOptions } from "./types";

/**
 * Trust level -> Codex CLI flags. Codex has no single mode flag equivalent to Claude Code's
 * --permission-mode, so this approximates our five shared TrustLevel values onto Codex's own
 * --sandbox / --ask-for-approval / --approve-for-me / --dangerously-bypass-approvals-and-sandbox
 * (see ARCHITECTURE.md#trust-levels). No native "plan" mode exists for Codex - the permission
 * catalog (core/permissionCatalog.ts) doesn't offer it for this provider, so that case here is
 * unreachable in practice, but falls back to the safest option rather than throwing.
 *
 * IMPORTANT: --ask-for-approval is a top-level flag, NOT accepted by `codex exec` itself
 * (confirmed via `codex exec --help`, which doesn't list it) - it must come BEFORE the `exec`
 * subcommand: `codex --ask-for-approval <policy> exec ...`. Verified empirically on this
 * machine.
 */
function flagsForTrustLevel(trustLevel: TrustLevel): { beforeExec: string[]; forExec: string[] } {
  switch (trustLevel) {
    case "bypassPermissions":
      return { beforeExec: [], forExec: ["--dangerously-bypass-approvals-and-sandbox"] };
    case "auto":
      return { beforeExec: [], forExec: ["--approve-for-me"] };
    case "acceptEdits":
      return { beforeExec: [], forExec: ["--sandbox", "workspace-write"] };
    case "manual":
      // Best-effort only: Codex has no external approval-decision hook analogous to Claude
      // Code's --permission-prompt-tool (confirmed against learn.chatgpt.com/docs/
      // agent-approvals-security), so this can't be a live UI popup - the CLI's own
      // internal approval routing decides.
      return { beforeExec: ["--ask-for-approval", "on-request"], forExec: ["--sandbox", "workspace-write"] };
    case "plan":
    default:
      return { beforeExec: [], forExec: ["--sandbox", "read-only"] };
  }
}

export const codexCliAdapter: ProviderAdapter = {
  id: "codex-cli",
  async runTurn({ cwd, prompt, trustLevel, model, effort, agentId, turnToken, sessionId, onEvent, signal }: RunTurnOptions): Promise<void> {
    const { beforeExec, forExec } = flagsForTrustLevel(trustLevel);
    // Resume this agent's own prior conversation so it remembers its own work across turns.
    // Deliberately NOT `--last`: that is scoped to the user's entire codex session store, so
    // with two codex agents configured it would silently resume the other one's conversation.
    // No captured id means we run cold rather than guess.
    const args = [
      ...beforeExec,
      "exec",
      ...(sessionId ? ["resume", sessionId] : []),
      "--json",
      "--skip-git-repo-check",
      "-C",
      cwd,
      ...forExec,
      ...(model ? ["-m", model] : []),
      // model_reasoning_effort is a TOML string value, hence the literal embedded quotes -
      // see the -c examples in `codex exec --help`.
      ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []),
      prompt,
    ];

    await new Promise<void>((resolve) => {
      const child = spawnCli("codex", args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          SOLACE_AGENT_ID: agentId,
          SOLACE_SERVER_PORT: String(process.env.PORT ?? 4310),
          ...(turnToken ? { SOLACE_TURN_TOKEN: turnToken } : {}),
        },
      });
      const rl = readline.createInterface({ input: child.stdout! });

      let reportedError = false;
      let seenSessionId: string | undefined;
      let aborted = false;
      const onAbort = () => {
        aborted = true;
        child.kill();
      };
      signal?.addEventListener("abort", onAbort);

      rl.on("line", (line) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line);
          // Codex does not document its JSONL event schema, and the field carrying the session
          // id is not published - so rather than hardcode a guess, take the first plausible id
          // we see from any of the shapes observed on disk and stop looking.
          if (!seenSessionId) {
            const candidate =
              event?.session_id ?? event?.thread_id ?? event?.session?.id ?? event?.item?.thread_id;
            if (typeof candidate === "string" && candidate) {
              seenSessionId = candidate;
              onEvent({ type: "session", sessionId: candidate });
            }
          }
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
          } else if (event.type === "turn.completed" && event.usage) {
            onEvent({
              type: "usage",
              usage: {
                inputTokens: event.usage.input_tokens,
                outputTokens: event.usage.output_tokens,
              },
            });
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
        onEvent({ type: "error", message: `failed to start codex CLI: ${err.message}` });
        onEvent({ type: "done" });
        resolve();
      });
    });
  },
};

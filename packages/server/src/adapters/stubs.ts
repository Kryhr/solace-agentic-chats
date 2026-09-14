import type { ProviderAdapter } from "./types";

/**
 * Not implemented yet. Should follow the same pattern as claude-code.ts / codex-cli.ts:
 * spawn the provider's own headless/non-interactive CLI mode, map trust levels onto its
 * permission flags, and translate its output into AdapterEvents.
 *
 *   gemini-cli -> `gemini -p`  (Gemini CLI's non-interactive mode)
 *   qwen-code  -> `qwen -p`    (Qwen Code CLI, Gemini-CLI-compatible flags)
 *
 * Both support signing in with an existing subscription/account the same way Claude Code
 * and Codex CLI do, so no API-key handling belongs here either.
 */
function notImplemented(id: ProviderAdapter["id"]): ProviderAdapter {
  return {
    id,
    async runTurn({ onEvent }) {
      onEvent({ type: "error", message: `${id} adapter is not implemented yet - see packages/server/src/adapters/stubs.ts` });
      onEvent({ type: "done" });
    },
  };
}

export const geminiCliAdapter = notImplemented("gemini-cli");
export const qwenCodeAdapter = notImplemented("qwen-code");

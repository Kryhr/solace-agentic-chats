import type { ProviderId, ProviderStatus } from "@solace/shared";
import { getAdapter } from "../adapters";
import { spawnCliSync } from "./spawnCli";

const CLI_BIN: Record<Exclude<ProviderId, "custom">, string> = {
  "claude-code": "claude",
  "codex-cli": "codex",
  "gemini-cli": "gemini",
  "qwen-code": "qwen",
};

const INSTALL_HINT: Record<Exclude<ProviderId, "custom">, string> = {
  "claude-code": "npm install -g @anthropic-ai/claude-code, then run `claude` once to log in",
  "codex-cli": "npm install -g @openai/codex, then run `codex login` to sign in",
  "gemini-cli": "npm install -g @google/gemini-cli, then run `gemini` once to log in",
  "qwen-code": "npm install -g @qwen-code/qwen-code, then run `qwen` once to log in",
};

function isInstalled(bin: string): boolean {
  try {
    const result = spawnCliSync(bin, ["--version"], { timeout: 5000 });
    return result.error === undefined && result.status === 0;
  } catch {
    return false;
  }
}

export function checkAllProviders(): ProviderStatus[] {
  return (Object.keys(CLI_BIN) as Exclude<ProviderId, "custom">[]).map((provider) => {
    const installed = isInstalled(CLI_BIN[provider]);
    return {
      provider,
      installed,
      detail: installed ? undefined : INSTALL_HINT[provider],
    };
  });
}

/** Actually runs a trivial real turn through the provider's CLI - proves sign-in end to end. */
export async function testProvider(provider: ProviderId, cwd: string): Promise<{ ok: boolean; message: string }> {
  const adapter = getAdapter(provider);
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, message: "timed out waiting for a response (30s)" });
    }, 30_000);

    adapter
      .runTurn({
        cwd,
        prompt: "Reply with exactly the single word: OK",
        trustLevel: "confirm-all",
        onEvent: (event) => {
          if (settled) return;
          if (event.type === "text" && event.text.trim()) {
            settled = true;
            clearTimeout(timeout);
            resolve({ ok: true, message: event.text.trim() });
          } else if (event.type === "error" && event.message.trim()) {
            settled = true;
            clearTimeout(timeout);
            resolve({ ok: false, message: event.message.trim() });
          }
        },
      })
      .then(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve({ ok: false, message: "no response from the CLI" });
        }
      });
  });
}

import type { ProviderId, ProviderStatus } from "@solace/shared";
import { getAdapter } from "../adapters";
import { spawnCli } from "./spawnCli";

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

/**
 * Runs `<bin> --version` asynchronously - this MUST NOT be spawnSync. A synchronous spawn
 * blocks Node's entire single-threaded event loop for as long as the subprocess takes, and on
 * Windows that's routed through cmd.exe (slow to start); with 4 providers checked back-to-back
 * that was stalling everything else on the server, including in-flight WebSocket handshakes,
 * for several seconds on every page load.
 */
function isInstalled(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawnCli(bin, ["--version"], { stdio: ["ignore", "ignore", "ignore"] });
      const timeout = setTimeout(() => {
        child.kill();
        resolve(false);
      }, 5000);
      child.on("close", (code) => {
        clearTimeout(timeout);
        resolve(code === 0);
      });
      child.on("error", () => {
        clearTimeout(timeout);
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}

export async function checkAllProviders(): Promise<ProviderStatus[]> {
  const providers = Object.keys(CLI_BIN) as Exclude<ProviderId, "custom">[];
  const installedFlags = await Promise.all(providers.map((provider) => isInstalled(CLI_BIN[provider])));
  return providers.map((provider, i) => ({
    provider,
    installed: installedFlags[i],
    detail: installedFlags[i] ? undefined : INSTALL_HINT[provider],
  }));
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
        // bypassPermissions guarantees this trivial connectivity check never blocks on an
        // approval prompt (which "manual" would, with no one there to answer it).
        trustLevel: "bypassPermissions",
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

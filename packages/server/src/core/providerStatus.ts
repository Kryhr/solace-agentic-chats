import type { CliProviderId, ConnectionCheck, ProviderId, ProviderStatus } from "@solace/shared";
import { getAdapter } from "../adapters";
import { spawnCli } from "./spawnCli";

const CLI_BIN: Record<CliProviderId, string> = {
  "claude-code": "claude",
  "codex-cli": "codex",
  "gemini-cli": "gemini",
  "qwen-code": "qwen",
  "copilot-cli": "copilot",
  opencode: "opencode",
};

/** The actual command, on its own, so the UI can show something copy-pasteable rather than a
 * sentence about installing. Kept separate from LOGIN_COMMAND because they are two different
 * steps and a user who has done the first needs to be told the second, not the whole line
 * again. */
export const INSTALL_COMMAND: Record<CliProviderId, string> = {
  "claude-code": "npm install -g @anthropic-ai/claude-code",
  "codex-cli": "npm install -g @openai/codex",
  "gemini-cli": "npm install -g @google/gemini-cli",
  "qwen-code": "npm install -g @qwen-code/qwen-code",
  "copilot-cli": "npm install -g @github/copilot",
  opencode: "npm install -g opencode-ai",
};

export const LOGIN_COMMAND: Record<CliProviderId, string> = {
  "claude-code": "claude",
  "codex-cli": "codex login",
  "gemini-cli": "gemini",
  "qwen-code": "qwen",
  // A real top-level subcommand, unlike the CLIs above that sign in from their interactive
  // session (confirmed in `copilot --help`; there is no `copilot logout` counterpart).
  "copilot-cli": "copilot login",
  // A real top-level subcommand (confirmed in `opencode --help`, which also lists the
  // `opencode auth logout` counterpart), not an interactive-session sign-in like claude/gemini.
  opencode: "opencode auth login",
};

const INSTALL_HINT: Record<CliProviderId, string> = {
  "claude-code": "npm install -g @anthropic-ai/claude-code, then run `claude` once to log in",
  "codex-cli": "npm install -g @openai/codex, then run `codex login` to sign in",
  "gemini-cli": "npm install -g @google/gemini-cli, then run `gemini` once to log in",
  "qwen-code": "npm install -g @qwen-code/qwen-code, then run `qwen` once to log in",
  "copilot-cli": "npm install -g @github/copilot, then run `copilot login` to sign in",
  opencode: "npm install -g opencode-ai, then run `opencode auth login` to sign in",
};

export function isCliProvider(provider: ProviderId): provider is CliProviderId {
  return provider in CLI_BIN;
}

interface VersionProbe {
  ok: boolean;
  output: string;
  /** The binary genuinely is not on PATH (ENOENT). Only this justifies an install hint. */
  notFound?: boolean;
  /** It was there and did not answer in time. Says nothing about whether it is installed. */
  timedOut?: boolean;
}

/**
 * Runs `<bin> --version` asynchronously - this MUST NOT be spawnSync. A synchronous spawn
 * blocks Node's entire single-threaded event loop for as long as the subprocess takes, and on
 * Windows that's routed through cmd.exe (slow to start); with 4 providers checked back-to-back
 * that was stalling everything else on the server, including in-flight WebSocket handshakes,
 * for several seconds on every page load.
 *
 * Output is captured now (it used to be discarded to /dev/null) because the version line is
 * the evidence. "Installed" with nothing behind it is the kind of unbacked green state this
 * panel is being rebuilt to remove; "claude 2.1.4" is a thing the CLI actually printed.
 */
function probeVersion(bin: string): Promise<VersionProbe> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    try {
      const child = spawnCli(bin, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
      child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
      child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
      // 5s was too short and the consequence was worse than the wait. Measured on a real
      // machine: gemini --version takes 4.4-7.2s and copilot 3.6-5.3s, and a COLD first run
      // right after an install is slower still - the binary is being unpacked. A probe that
      // timed out was recorded as installed:false, so the app told the user to reinstall
      // software that was already there and working. Reported by the user for opencode.
      const timeout = setTimeout(() => {
        child.kill();
        resolve({
          ok: false,
          timedOut: true,
          output: `\`${bin} --version\` did not answer within ${PROBE_TIMEOUT_MS / 1000}s`,
        });
      }, PROBE_TIMEOUT_MS);
      child.on("close", (code) => {
        clearTimeout(timeout);
        const first = (text: string) => text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
        if (code === 0) {
          // Some CLIs print their version on stderr; take whichever actually said something.
          resolve({ ok: true, output: first(stdout) || first(stderr) || `\`${bin} --version\` exited 0 but printed nothing` });
        } else {
          resolve({ ok: false, output: first(stderr) || first(stdout) || `\`${bin} --version\` exited with code ${code}` });
        }
      });
      child.on("error", (err) => {
        clearTimeout(timeout);
        // ENOENT is the one error that really does mean "not on PATH". Anything else (EACCES,
        // EBUSY, a broken shim) is a failure to RUN it, not proof it is absent.
        const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
        resolve({ ok: false, notFound: missing, output: (err as Error).message });
      });
    } catch (err) {
      resolve({ ok: false, output: (err as Error).message });
    }
  });
}

/** Long enough for a cold start on a slow machine. The cost of waiting is a spinner; the cost
 * of being too short is telling someone their working install is missing. */
const PROBE_TIMEOUT_MS = 20_000;

export async function checkAllProviders(): Promise<ProviderStatus[]> {
  const providers = Object.keys(CLI_BIN) as CliProviderId[];
  const probes = await Promise.all(providers.map((provider) => probeVersion(CLI_BIN[provider])));
  const checkedAt = new Date().toISOString();
  return providers.map((provider, i) => ({
    provider,
    installed: probes[i].ok,
    // Only offer the install command when the binary genuinely could not be found. A timeout or
    // a crash means something IS there and did not answer - saying "install it" then is both
    // wrong and actively unhelpful, because reinstalling will not fix it.
    detail: probes[i].ok ? undefined : probes[i].notFound ? INSTALL_HINT[provider] : probes[i].output,
    version: probes[i].ok ? probes[i].output : undefined,
    checkedAt,
    installCommand: INSTALL_COMMAND[provider],
    loginCommand: LOGIN_COMMAND[provider],
  }));
}

/**
 * The per-row "Check" in Connections. Cheap and honest: it proves the binary resolves on PATH
 * and that `--version` exited 0, and says so in those words. It deliberately does NOT prove
 * the CLI is signed in - that needs a real turn, which costs the user tokens and is a separate,
 * explicitly-labelled action (testProvider below).
 */
export async function checkCliProvider(provider: CliProviderId): Promise<ConnectionCheck> {
  const bin = CLI_BIN[provider];
  const probe = await probeVersion(bin);
  return {
    ok: probe.ok,
    detail: probe.ok
      ? `\`${bin} --version\` → ${probe.output}`
      : `\`${bin} --version\` failed: ${probe.output}`,
    checkedAt: new Date().toISOString(),
  };
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
        agentId: "connectivity-test",
        agentHandle: "test",
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

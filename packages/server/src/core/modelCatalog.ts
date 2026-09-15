import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliProviderId, ProviderModelInfo } from "@solace/shared";

/**
 * What each provider's CLI actually supports, verified against its own --help output rather
 * than guessed:
 *   - Claude Code: `--model <alias|full-id>` (aliases like "sonnet"/"opus"/"fable") and
 *     `--effort <level>` with a fixed, documented set of levels.
 *   - Codex CLI: `-m/--model <MODEL>` and `-c model_reasoning_effort="<level>"` (undocumented
 *     in --help but confirmed via OpenAI's own config reference).
 *   - Gemini CLI / Qwen Code: `-m/--model`, and NO reasoning-effort flag on either - neither
 *     CLI's agent command has one (Qwen has an `--effort` on its separate `qwen review`
 *     subcommand only), so effortLevels stays empty rather than borrowing another provider's
 *     levels. The UI hides the effort control entirely when this list is empty.
 *
 * modelExamples is deliberately NOT an exhaustive catalog - available models depend on the
 * user's plan/account and change over time, so the UI treats this as example text next to a
 * free-text field rather than a dropdown that could go stale or claim false precision.
 * currentDefaultModel is different: it's read live from the CLI's own config file on disk,
 * so it's always this machine's actual current default, never a guess.
 */
function detectClaudeDefault(): string | undefined {
  try {
    const path = join(homedir(), ".claude.json");
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return typeof parsed.model === "string" ? parsed.model : undefined;
  } catch {
    return undefined;
  }
}

function detectCodexDefault(): { model?: string; effort?: string } {
  try {
    const path = join(homedir(), ".codex", "config.toml");
    if (!existsSync(path)) return {};
    const raw = readFileSync(path, "utf-8");
    const model = raw.match(/^model\s*=\s*"([^"]+)"/m)?.[1];
    const effort = raw.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m)?.[1];
    return { model, effort };
  } catch {
    return {};
  }
}

/**
 * Gemini CLI and Qwen Code both store the user's chosen default under `model.name` in their own
 * settings.json (`~/.gemini/` and `~/.qwen/` respectively) - Qwen is a Gemini CLI fork and kept
 * the key. Same live-read-from-disk rule as the two above: this is whatever is actually
 * configured on this machine right now, and undefined when nothing is, never a stand-in value.
 */
function detectSettingsJsonModel(dir: string): string | undefined {
  try {
    const path = join(homedir(), dir, "settings.json");
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return typeof parsed?.model?.name === "string" ? parsed.model.name : undefined;
  } catch {
    return undefined;
  }
}

export function getModelCatalog(): ProviderModelInfo[] {
  const claudeDefault = detectClaudeDefault();
  const codexDefault = detectCodexDefault();

  const catalog: Record<CliProviderId, ProviderModelInfo> = {
    "claude-code": {
      provider: "claude-code",
      // "fable" deliberately left out: which model aliases actually resolve to something
      // depends on the signed-in account's plan/access, which isn't something this app can
      // query - listing an alias the current plan can't use would be presenting a guess as
      // fact. Keep the suggestions to the aliases every plan can use; a user who does have
      // access to something else can still type it directly, this is example text next to a
      // free-text field, not a restrictive dropdown.
      modelExamples: ["sonnet", "opus", "claude-haiku-4-5-20251001"],
      effortLevels: ["low", "medium", "high", "xhigh", "max"],
      currentDefaultModel: claudeDefault,
    },
    "codex-cli": {
      provider: "codex-cli",
      modelExamples: ["gpt-5.1-codex", "gpt-5.1-codex-mini", "o3"],
      effortLevels: ["minimal", "low", "medium", "high", "xhigh"],
      currentDefaultModel: codexDefault.model,
      currentDefaultEffort: codexDefault.effort,
    },
    "gemini-cli": {
      provider: "gemini-cli",
      // Read out of the installed CLI's own DEFAULT_GEMINI_*_MODEL constants (v0.59.0) rather
      // than from memory of what Google has shipped - these are ids that build actually knows.
      modelExamples: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-3.1-flash-lite"],
      effortLevels: [],
      currentDefaultModel: detectSettingsJsonModel(".gemini"),
    },
    "qwen-code": {
      provider: "qwen-code",
      // Likewise from the installed Qwen Code build (v0.22.3). "coder-model" is its own
      // DEFAULT_QWEN_MODEL - an alias the OAuth plan resolves for you - and the other two are
      // concrete ids it knows; which of them a given account can actually reach depends on that
      // account, so as with the other providers this is example text next to a free-text field.
      modelExamples: ["coder-model", "qwen3-coder-plus", "qwen3-max"],
      effortLevels: [],
      currentDefaultModel: detectSettingsJsonModel(".qwen"),
    },
  };

  return Object.values(catalog);
}

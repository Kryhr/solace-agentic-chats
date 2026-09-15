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
 *   - Gemini CLI / Qwen Code: `-m/--model` exists but these adapters aren't implemented yet
 *     (see adapters/stubs.ts), so no effort levels are claimed for them.
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
      modelExamples: [],
      effortLevels: [],
    },
    "qwen-code": {
      provider: "qwen-code",
      modelExamples: [],
      effortLevels: [],
    },
  };

  return Object.values(catalog);
}

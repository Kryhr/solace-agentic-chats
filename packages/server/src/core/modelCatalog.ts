import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { CliProviderId, ModelCatalogSource, ModelOption, ProviderModelInfo } from "@solace/shared";
import { spawnCli } from "./spawnCli";
import {
  applyClaudeSections,
  claudeAliasOptions,
  mergeSourcedOptions,
  parseClaudeAdditionalModelOptions,
  parseClaudeBuildChunk,
  parseCodexModelCatalog,
  parseGeminiBundleModels,
  parseQwenBundleModels,
} from "./cliModelSources";

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
 * ---------------------------------------------------------------------------------------
 * On the model LIST itself.
 *
 * This file used to offer three or four aliases per provider and say, in a comment, that an
 * exhaustive catalog could not be presented honestly. That was half right. Inventing model ids
 * from memory is dishonest; reading them out of an authoritative source is not. So every id
 * this file now returns was read, at runtime, from one of:
 *
 *   1. the CLI asking its own service and answering (Codex: `codex debug models`),
 *   2. the installed CLI's own shipped build (Claude Code's embedded model registry; the
 *      Gemini and Qwen bundles' own model tables),
 *   3. the CLI's own on-disk cache of something its server said about THIS account
 *      (~/.claude.json's additionalModelOptionsCache).
 *
 * Nothing is hardcoded. Grep this file for a model id and you will not find one. That matters
 * for staleness as much as for honesty: a user who updates their CLI gets the new list for
 * free, and a user on an old build is shown what their old build actually knows.
 *
 * What this still cannot know is whether the signed-in plan may RUN any given model. No CLI
 * here exposes an entitlement API, and guessing would be exactly the failure this whole
 * approach exists to avoid. So ProviderModelInfo carries its `sources` to the UI, the UI
 * labels the list as models that exist rather than models you have, the model field stays
 * free text so an id we never listed is always reachable, and a rejection is surfaced as the
 * provider's own verbatim error (see AgentStatus.lastError) instead of being pre-empted here.
 *
 * currentDefaultModel is unchanged: read live from the CLI's own config file on disk, so it is
 * always this machine's actual current default, never a guess.
 */
function detectClaudeDefault(): string | undefined {
  try {
    const parsed = readClaudeConfig();
    return typeof parsed?.model === "string" ? parsed.model : undefined;
  } catch {
    return undefined;
  }
}

function readClaudeConfig(): Record<string, unknown> | undefined {
  const path = join(homedir(), ".claude.json");
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf-8"));
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

// ---------------------------------------------------------------------------------------
// Locating each CLI's own files
// ---------------------------------------------------------------------------------------

/** Same PATH/PATHEXT walk spawnCli uses to decide what a bare command name resolves to, so the
 * build this file reads is the build the adapters will actually run. */
function whichOnPath(bin: string): string | undefined {
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(delimiter).filter(Boolean);
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const ext of [...exts, "", ".ps1"]) {
      const candidate = join(dir, bin + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Every place a given npm-installed package's files could sit, given where its shim resolved.
 * Covers the Windows npm-global layout (`<prefix>/node_modules/<pkg>`) and the POSIX one
 * (`<prefix>/lib/node_modules/<pkg>`), plus the user-local install path. */
function npmPackageDirs(bin: string, pkg: string): string[] {
  const shim = whichOnPath(bin);
  const roots: string[] = [];
  if (shim) {
    const dir = dirname(shim);
    roots.push(join(dir, "node_modules", pkg), join(dir, "..", "lib", "node_modules", pkg));
  }
  roots.push(join(homedir(), ".claude", "local", "node_modules", pkg));
  return roots.filter((p) => existsSync(p));
}

function packageVersion(dir: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

/** Files under `dir` matching `filter`, smallest first. Ascending size matters: every scan
 * below stops as soon as it has what it needs, and the model tables live in the smaller
 * chunks, so this routinely avoids reading tens of megabytes of unrelated bundle. */
function jsFilesBySize(dir: string, filter: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter(filter)
      .map((name) => join(dir, name))
      .map((path) => ({ path, size: statSync(path).size }))
      .sort((a, b) => a.size - b.size)
      .map((f) => f.path);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------------------

/**
 * Claude Code's shipped build is a ~230MB native binary with its model registry embedded as
 * plain text, so it is streamed rather than read whole: 4MB at a time with a small overlap, so
 * an entry straddling a chunk boundary is still seen. Measured at ~350ms for the full binary
 * on this machine, and the result is cached, so it is paid once.
 */
async function scanClaudeBuild(path: string) {
  const models: ModelOption[] = [];
  const seen = new Set<string>();
  let aliases: Record<string, string> = {};
  let sections: Record<string, string> = {};
  let tail = "";
  const stream = createReadStream(path, { encoding: "latin1", highWaterMark: 1 << 22 });
  for await (const chunk of stream) {
    const text = tail + (chunk as unknown as string);
    const parsed = parseClaudeBuildChunk(text);
    for (const model of parsed.models) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      models.push(model);
    }
    if (Object.keys(parsed.aliases).length > 0) aliases = parsed.aliases;
    Object.assign(sections, parsed.sections);
    // 2KB is comfortably longer than the longest header this parser anchors on, so no entry
    // can be lost to a chunk boundary.
    tail = text.slice(-2048);
  }
  return { models, aliases, sections };
}

function claudeBuildCandidates(): string[] {
  const candidates: string[] = [];
  for (const dir of npmPackageDirs("claude", join("@anthropic-ai", "claude-code"))) {
    candidates.push(join(dir, "cli.js"), join(dir, "bin", "claude.exe"), join(dir, "bin", "claude"));
  }
  // Native installs keep one directory per version; newest by name, which is how the installer
  // orders them.
  const versions = join(homedir(), ".local", "share", "claude", "versions");
  if (existsSync(versions)) {
    try {
      const newest = readdirSync(versions).sort().reverse()[0];
      if (newest) candidates.push(join(versions, newest));
    } catch {
      /* unreadable install dir is just one candidate fewer */
    }
  }
  return candidates.filter((p) => existsSync(p) && statSync(p).isFile());
}

async function claudeModels(): Promise<{ models: ModelOption[]; sources: ModelCatalogSource[]; error?: string }> {
  const sources: ModelCatalogSource[] = [];
  const groups: ModelOption[][] = [];
  let error: string | undefined;

  const path = claudeBuildCandidates()[0];
  if (!path) {
    error = "Couldn't find the installed Claude Code build on this machine, so no model list could be read from it.";
  } else {
    try {
      const { models, aliases, sections } = await scanClaudeBuild(path);
      // Aliases lead - they are the "always the current one" choice - and the build's own
      // sectioning then decides the rest of the order, so this app never has to rank models.
      const withAliases = applyClaudeSections([...claudeAliasOptions(aliases, models), ...models], sections);
      if (withAliases.length === 0) {
        error = `Read ${path} but found no model registry in it - this build may store its models differently.`;
      } else {
        groups.push(withAliases);
        sources.push({
          kind: "cli-artifact",
          origin: path,
          version: npmPackageDirs("claude", join("@anthropic-ai", "claude-code")).map(packageVersion).find(Boolean),
          readAt: new Date().toISOString(),
          count: withAliases.length,
        });
      }
    } catch (err) {
      error = `Couldn't read ${path}: ${(err as Error).message}`;
    }
  }

  // The one account-scoped model fact available locally. Listed after the build's own registry
  // so a duplicate id keeps the richer entry, but its source is still reported separately.
  try {
    const extra = parseClaudeAdditionalModelOptions(readClaudeConfig()?.additionalModelOptionsCache);
    if (extra.length > 0) {
      groups.push(extra);
      sources.push({
        kind: "account-cache",
        origin: join(homedir(), ".claude.json") + " · additionalModelOptionsCache",
        readAt: new Date().toISOString(),
        count: extra.length,
      });
    }
  } catch {
    /* no cache, or unparseable - simply contributes nothing */
  }

  return { models: mergeSourcedOptions(groups), sources, error };
}

// ---------------------------------------------------------------------------------------
// Codex CLI
// ---------------------------------------------------------------------------------------

/** Runs a CLI read-only and returns its stdout, or throws with whatever it said. Never used
 * for anything that costs tokens - see the one caller. */
function runForStdout(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawnCli(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`\`${bin} ${args.join(" ")}\` did not answer within ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      // The CLI's own words, not a paraphrase - the user should see what it actually said.
      else reject(new Error(`\`${bin} ${args.join(" ")}\` exited ${code}: ${(stderr || stdout).trim().slice(0, 300)}`));
    });
  });
}

/**
 * `codex debug models` renders Codex's catalog as JSON, refreshing it from the service first.
 * Proven live on 2026-09-15: running it rewrote ~/.codex/models_cache.json, and its output
 * differs from `--bundled` (which skips the refresh) - the refreshed list dropped three models
 * the shipped binary still carries and added one the binary does not. So the refreshed form is
 * the real answer and `--bundled` is the honest fallback when the refresh can't happen offline.
 */
async function codexModels(): Promise<{ models: ModelOption[]; sources: ModelCatalogSource[]; error?: string }> {
  const attempts: Array<{ args: string[]; kind: ModelCatalogSource["kind"]; origin: string }> = [
    { args: ["debug", "models"], kind: "cli-live", origin: "codex debug models (refreshed from the Codex service)" },
    { args: ["debug", "models", "--bundled"], kind: "cli-artifact", origin: "codex debug models --bundled (the list shipped inside the installed Codex build)" },
  ];
  let error: string | undefined;
  for (const attempt of attempts) {
    try {
      const models = parseCodexModelCatalog(JSON.parse(await runForStdout("codex", attempt.args, 20_000)));
      if (models.length === 0) throw new Error("returned no model slugs");
      return {
        models: mergeSourcedOptions([models]),
        sources: [{ kind: attempt.kind, origin: attempt.origin, readAt: new Date().toISOString(), count: models.length }],
        // A fallback that worked still has to say the first thing failed, or the UI would
        // present a shipped snapshot as if it were a live answer.
        error,
      };
    } catch (err) {
      error = error ? `${error} Then: ${(err as Error).message}` : (err as Error).message;
    }
  }
  return { models: [], sources: [], error };
}

// ---------------------------------------------------------------------------------------
// Gemini CLI / Qwen Code
// ---------------------------------------------------------------------------------------

async function geminiModels(): Promise<{ models: ModelOption[]; sources: ModelCatalogSource[]; error?: string }> {
  const dir = npmPackageDirs("gemini", join("@google", "gemini-cli"))[0];
  if (!dir) return { models: [], sources: [], error: "Gemini CLI doesn't appear to be installed, so no model list could be read from it." };
  for (const path of jsFilesBySize(join(dir, "bundle"), (n) => n.endsWith(".js"))) {
    try {
      const { models } = parseGeminiBundleModels(readFileSync(path, "utf-8"));
      if (models.length === 0) continue;
      return {
        models: mergeSourcedOptions([models]),
        sources: [{ kind: "cli-artifact", origin: path, version: packageVersion(dir), readAt: new Date().toISOString(), count: models.length }],
      };
    } catch {
      /* a chunk we can't read is just not the chunk with the model table */
    }
  }
  return {
    models: [],
    sources: [],
    error: `Found Gemini CLI at ${dir} but couldn't locate a model table in its bundle. Gemini CLI has no model-listing command and caches no model list on disk, so there is nothing else to read.`,
  };
}

/** Qwen Code installs outside npm on Windows (its own %LOCALAPPDATA%\\qwen-code tree), so its
 * bundle is located from the shim it actually installs rather than assumed. */
function qwenChunkDirs(): string[] {
  const dirs: string[] = [];
  const shim = whichOnPath("qwen");
  if (shim) {
    const base = dirname(dirname(shim));
    dirs.push(join(base, "lib", "chunks"), join(base, "qwen-code", "lib", "chunks"));
  }
  dirs.push(join(homedir(), "AppData", "Local", "qwen-code", "qwen-code", "lib", "chunks"));
  for (const dir of npmPackageDirs("qwen", join("@qwen-code", "qwen-code"))) dirs.push(join(dir, "dist", "chunks"), join(dir, "lib", "chunks"));
  return dirs.filter((d) => existsSync(d));
}

async function qwenModels(): Promise<{ models: ModelOption[]; sources: ModelCatalogSource[]; error?: string }> {
  const dir = qwenChunkDirs()[0];
  if (!dir) return { models: [], sources: [], error: "Qwen Code doesn't appear to be installed, so no model list could be read from it." };
  const groups: ModelOption[][] = [];
  const sources: ModelCatalogSource[] = [];
  for (const path of jsFilesBySize(join(dir), (n) => n.endsWith(".js"))) {
    let text: string;
    try {
      text = readFileSync(path, "utf-8");
    } catch {
      continue;
    }
    // Cheap string tests first so 46MB of chunks isn't handed to the parsers.
    if (!text.includes("_MODELS = [") && !text.includes("Provider = {")) continue;
    const models = parseQwenBundleModels(text);
    if (models.length === 0) continue;
    groups.push(models);
    sources.push({ kind: "cli-artifact", origin: path, readAt: new Date().toISOString(), count: models.length });
  }
  if (groups.length === 0) {
    return {
      models: [],
      sources: [],
      error: `Found Qwen Code at ${dir} but couldn't locate a model table in its bundle. Qwen Code has no model-listing command, so there is nothing else to read.`,
    };
  }
  return { models: mergeSourcedOptions(groups), sources };
}

// ---------------------------------------------------------------------------------------
// Assembly + cache
// ---------------------------------------------------------------------------------------

/** Reading a 230MB binary and spawning a CLI are not per-keystroke operations, so the result
 * is memoised. In memory only and short-lived, for the same reason modelDiscovery.ts refuses
 * to persist: a model list read back off disk on a later launch would be presented as current
 * while being a stale snapshot of a CLI that may since have been updated. */
const CACHE_TTL_MS = 10 * 60_000;
let cached: { at: number; value: ProviderModelInfo[] } | undefined;

export function clearModelCatalogCache(): void {
  cached = undefined;
}

export async function getModelCatalog(): Promise<ProviderModelInfo[]> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const codexDefault = detectCodexDefault();
  const [claude, codex, gemini, qwen] = await Promise.all([
    claudeModels().catch((err) => ({ models: [], sources: [], error: (err as Error).message })),
    codexModels().catch((err) => ({ models: [], sources: [], error: (err as Error).message })),
    geminiModels().catch((err) => ({ models: [], sources: [], error: (err as Error).message })),
    qwenModels().catch((err) => ({ models: [], sources: [], error: (err as Error).message })),
  ]);

  const catalog: Record<CliProviderId, ProviderModelInfo> = {
    "claude-code": {
      provider: "claude-code",
      models: claude.models,
      sources: claude.sources,
      sourceError: claude.error,
      // From `claude --help`, which documents exactly these five for --effort. Kept global
      // rather than per-model: the build's per-model `capabilities` array hints at which
      // models take xhigh/max, but hinting is not stating, and narrowing the list on an
      // inference could hide a level that actually works.
      effortLevels: ["low", "medium", "high", "xhigh", "max"],
      currentDefaultModel: detectClaudeDefault(),
    },
    "codex-cli": {
      provider: "codex-cli",
      models: codex.models,
      sources: codex.sources,
      sourceError: codex.error,
      // Codex states these per model in its own catalog (see ModelOption.effortLevels); this
      // is the union, used only for a model the catalog didn't describe.
      effortLevels: [...new Set(codex.models.flatMap((m) => m.effortLevels ?? []))],
      currentDefaultModel: codexDefault.model,
      currentDefaultEffort: codexDefault.effort,
    },
    "gemini-cli": {
      provider: "gemini-cli",
      models: gemini.models,
      sources: gemini.sources,
      sourceError: gemini.error,
      effortLevels: [],
      currentDefaultModel: detectSettingsJsonModel(".gemini"),
    },
    "qwen-code": {
      provider: "qwen-code",
      models: qwen.models,
      sources: qwen.sources,
      sourceError: qwen.error,
      effortLevels: [],
      currentDefaultModel: detectSettingsJsonModel(".qwen"),
    },
  };

  const value = Object.values(catalog);
  cached = { at: Date.now(), value };
  return value;
}

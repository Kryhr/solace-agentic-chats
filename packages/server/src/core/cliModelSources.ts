import type { ModelOption } from "@solace/shared";

/**
 * Parsers for the model lists that the installed provider CLIs genuinely carry, kept separate
 * from modelCatalog.ts so each one can be unit-tested against a captured real artifact rather
 * than trusted on sight.
 *
 * The rule these exist to satisfy: this app may list a model id only if it read that id from
 * something authoritative - the CLI's own shipped build, the CLI's own live answer, or the
 * CLI's own cache of what its server said. None of these functions contains a model id.
 * Everything they return came out of their input.
 */

/** Title-cases a family key the source gave us ("opus" -> "Opus"). Not a lookup table on
 * purpose: a new family shipped by a provider must show up by itself, not go missing until
 * someone remembers to add it here. */
export function familyLabel(family: string): string {
  return family
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => {
      if (/^gpt$/i.test(part)) return "GPT";
      if (/^oauth$/i.test(part)) return "OAuth";
      return /^[a-z]/.test(part) ? part[0].toUpperCase() + part.slice(1) : part;
    })
    .join(" ");
}

// ---------------------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------------------

/**
 * Claude Code ships a structured model registry inside its own build. Verified on 2026-09-15
 * against the installed 2.1.272 Windows binary, where entries appear literally as:
 *
 *   {id:"claude-sonnet-4-6",family:"sonnet",display_name:"Sonnet 4.6",
 *    knowledge_cutoff:"August 2025",provider_ids:{...},
 *    context:{window:200000,supports_1m_beta:!0,supports_1m_suffix:!0},...}
 *
 * There is no `claude models` subcommand and no account-scoped roster on disk (checked every
 * subcommand in `claude --help` and every key in ~/.claude.json), so this - the shipped build's
 * own table - is the most authoritative source that exists locally. It is a list of models the
 * INSTALLED CLI KNOWS, which is not the same as models this login may run; the UI says so.
 */
const CLAUDE_MODEL_ENTRY =
  /\{id:"(claude-[A-Za-z0-9._-]+)",family:"([A-Za-z0-9_]+)",display_name:"([^"]{1,60})"(?:,knowledge_cutoff:"([^"]{1,40})")?/g;

/**
 * The same build's alias table, e.g. {fable:"claude-fable-5-1",opus:"claude-opus-5",
 * sonnet:"claude-sonnet-5",haiku:"claude-haiku-4-5"}. This is exactly the mapping that made
 * an alias dishonest to offer alone: a turn requesting "sonnet" came back reporting
 * "claude-sonnet-5", and nothing in the UI had said so.
 */
const CLAUDE_ALIAS_TABLE = /\{fable:"(claude-[A-Za-z0-9._-]+)",opus:"(claude-[A-Za-z0-9._-]+)",sonnet:"(claude-[A-Za-z0-9._-]+)",haiku:"(claude-[A-Za-z0-9._-]+)"\}/;

/** `supports_1m_suffix:!0` inside an entry means the build accepts `<id>[1m]` as a real,
 * separately-selectable model value - the suffixed forms occur verbatim in the binary too. */
const SUPPORTS_1M_SUFFIX = /supports_1m_suffix:!0/;

/**
 * The same build carries a second, picker-oriented table that sections each model as "main",
 * "overflow" or "deprecated" - the build's own words for what it foregrounds and what it
 * considers superseded. Worth reading because the alternative is this app deciding which Opus
 * is the good one, which it has no basis for. Models keep their place in the list either way;
 * a deprecated one is labelled and sorted last, never hidden.
 */
const CLAUDE_SECTION = /\{id:"(claude-[A-Za-z0-9._-]+)",name:"[^"]{1,30}",short_name:"[^"]{1,20}",section:"([a-z]+)"/g;

const SECTION_RANK: Record<string, number> = { main: 0, overflow: 1, deprecated: 2 };

export interface ClaudeRegistry {
  models: ModelOption[];
  /** alias -> concrete id, exactly as the build's own table states it. Empty if not found. */
  aliases: Record<string, string>;
  /** model id -> the build's own section for it ("main"/"overflow"/"deprecated"). */
  sections: Record<string, string>;
}

/**
 * Applies the build's own sectioning: deprecated models say so and sort last, and within a
 * family the models the build foregrounds come first. Pure re-ordering and labelling - nothing
 * is added or removed, because "this build de-emphasises it" is not "you cannot use it".
 */
export function applyClaudeSections(models: ModelOption[], sections: Record<string, string>): ModelOption[] {
  const rankOf = (m: ModelOption) => SECTION_RANK[sections[m.aliasFor ?? m.id.replace(/\[1m\]$/, "")] ?? ""] ?? 1;
  return models
    .map((m) => {
      const section = sections[m.aliasFor ?? m.id.replace(/\[1m\]$/, "")];
      if (section !== "deprecated") return m;
      const marker = "this build marks it deprecated";
      return { ...m, note: m.note ? `${m.note} · ${marker}` : marker[0].toUpperCase() + marker.slice(1) };
    })
    .map((m, i) => ({ m, i }))
    .sort((a, b) => rankOf(a.m) - rankOf(b.m) || a.i - b.i)
    .map(({ m }) => m);
}

/**
 * Parses one chunk of Claude Code build text. Callers stream a large binary through this and
 * merge, so it must be safe to call on an arbitrary slice: everything is anchored on a
 * complete `{id:"claude-...` header, and a header split across a chunk boundary is simply not
 * matched (the streaming caller overlaps chunks so it is seen on the next pass instead).
 */
export function parseClaudeBuildChunk(text: string): ClaudeRegistry {
  const models: ModelOption[] = [];
  const aliases: Record<string, string> = {};
  const sections: Record<string, string> = {};

  for (const match of text.matchAll(CLAUDE_SECTION)) sections[match[1]] = match[2];

  for (const match of text.matchAll(CLAUDE_MODEL_ENTRY)) {
    const [, id, family, display, cutoff] = match;
    // The fields we care about all sit in the first few hundred characters of an entry, and
    // entries are concatenated, so the window is cut at the start of the next one. Without
    // that cut a flag belonging to the NEXT model could be read as this one's.
    const window = text.slice(match.index, match.index + 900).split(',{id:"')[0];
    const note = cutoff ? `Knowledge cutoff ${cutoff}` : undefined;
    models.push({
      id,
      label: display,
      family,
      familyLabel: familyLabel(family),
      note,
      sourceIndex: 0,
    });
    if (SUPPORTS_1M_SUFFIX.test(window)) {
      models.push({
        id: `${id}[1m]`,
        label: `${display} (1M context)`,
        family,
        familyLabel: familyLabel(family),
        // Stated by the build itself via supports_1m_suffix, not inferred from the name.
        note: note ? `${note} · 1M-token context variant` : "1M-token context variant",
        sourceIndex: 0,
      });
    }
  }

  const aliasMatch = text.match(CLAUDE_ALIAS_TABLE);
  if (aliasMatch) {
    aliases.fable = aliasMatch[1];
    aliases.opus = aliasMatch[2];
    aliases.sonnet = aliasMatch[3];
    aliases.haiku = aliasMatch[4];
  }

  return { models, aliases, sections };
}

/**
 * Turns the build's alias table into selectable options, each carrying what it resolves to
 * right now. Offered alongside the concrete ids rather than instead of them - an alias is the
 * right choice for "always the current best Opus", and a concrete id is the right choice for
 * "that specific Opus", and the app has no business deciding which the user meant.
 *
 * `known` is the set of concrete ids the same build listed: an alias whose target isn't in it
 * is still offered (the build clearly accepts it) but its resolution is reported exactly as
 * read, never repaired.
 */
export function claudeAliasOptions(aliases: Record<string, string>, models: ModelOption[]): ModelOption[] {
  const byId = new Map(models.map((m) => [m.id, m]));
  return Object.entries(aliases).map(([alias, target]) => ({
    id: alias,
    label: familyLabel(alias),
    family: alias,
    familyLabel: familyLabel(alias),
    aliasFor: target,
    note: `Whatever this build currently maps "${alias}" to: ${byId.get(target)?.label ?? target}`,
    sourceIndex: 0,
  }));
}

/**
 * ~/.claude.json's `additionalModelOptionsCache` is Claude Code's own cache of an extra model
 * option its server offered THIS login - the one genuinely account-scoped model fact available
 * on this machine. Observed shape (2026-09-15):
 *   {"value":"claude-fable-5-1[1m]","label":"Fable","description":"Fable 5.1 · Most capable…"}
 * Older/newer builds may store an array; both are handled, and anything else yields nothing
 * rather than a guess.
 */
export function parseClaudeAdditionalModelOptions(raw: unknown): ModelOption[] {
  const entries = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  const out: ModelOption[] = [];
  for (const entry of entries) {
    const e = entry as { value?: unknown; label?: unknown; description?: unknown };
    if (typeof e?.value !== "string" || !e.value) continue;
    const family = e.value.replace(/^claude-/, "").split("-")[0] || "other";
    out.push({
      id: e.value,
      label: typeof e.label === "string" && e.label ? e.label : e.value,
      family,
      familyLabel: familyLabel(family),
      note: typeof e.description === "string" && e.description ? e.description : undefined,
      sourceIndex: 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Codex CLI
// ---------------------------------------------------------------------------------------

/**
 * `codex debug models` renders Codex's own model catalog as JSON, refreshing it from the
 * service first (pass --bundled to skip the refresh). Verified on 2026-09-15 against Codex's
 * installed build: the refreshed list and the bundled list genuinely differ, and running it
 * rewrote ~/.codex/models_cache.json - so this is a live answer, not a shipped constant.
 *
 * Real entry shape:
 *   {"slug":"gpt-5.6-luna","display_name":"GPT-5.6-Luna","description":"...",
 *    "default_reasoning_level":"medium",
 *    "supported_reasoning_levels":[{"effort":"low","description":"..."},...],
 *    "visibility":"list","supported_in_api":true,"priority":8}
 *
 * `visibility:"hide"` means Codex's own picker does not list it. Those are kept, flagged, and
 * grouped separately: the user asked to be able to select anything they can reach, and
 * silently dropping an entry the service itself sent would be its own small lie.
 */
export function parseCodexModelCatalog(body: unknown): ModelOption[] {
  const models = (body as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return [];
  const out: ModelOption[] = [];
  for (const raw of models) {
    const m = raw as {
      slug?: unknown;
      display_name?: unknown;
      description?: unknown;
      visibility?: unknown;
      default_reasoning_level?: unknown;
      supported_reasoning_levels?: unknown;
      priority?: unknown;
    };
    if (typeof m?.slug !== "string" || !m.slug) continue;
    const efforts = Array.isArray(m.supported_reasoning_levels)
      ? m.supported_reasoning_levels
          .map((l) => (l && typeof l === "object" ? (l as { effort?: unknown }).effort : undefined))
          .filter((e): e is string => typeof e === "string" && e.length > 0)
      : [];
    // Family from the version prefix Codex's own slugs use ("gpt-5.6-luna" -> "gpt-5.6"), so
    // the three 5.6 variants group together instead of sitting in a flat list of ids.
    const family = m.slug.match(/^([a-z]+-\d+(?:\.\d+)?)/)?.[1] ?? m.slug;
    out.push({
      id: m.slug,
      label: typeof m.display_name === "string" && m.display_name ? m.display_name : m.slug,
      family,
      familyLabel: familyLabel(family),
      note: typeof m.description === "string" && m.description ? m.description : undefined,
      effortLevels: efforts.length > 0 ? efforts : undefined,
      defaultEffort: typeof m.default_reasoning_level === "string" ? m.default_reasoning_level : undefined,
      hiddenBySource: m.visibility === "hide",
      sourceIndex: 0,
    });
  }
  // Codex's own `priority` orders its picker; preserved so the list reads the way Codex means it.
  return out.sort((a, b) => {
    const pa = (models as Array<{ slug?: string; priority?: number }>).find((m) => m.slug === a.id)?.priority ?? 999;
    const pb = (models as Array<{ slug?: string; priority?: number }>).find((m) => m.slug === b.id)?.priority ?? 999;
    return pa - pb;
  });
}

// ---------------------------------------------------------------------------------------
// Gemini CLI / Qwen Code
// ---------------------------------------------------------------------------------------

/**
 * Gemini CLI has no model-listing subcommand (checked every subcommand of `gemini --help` on
 * 0.59.0) and stores no model or entitlement cache on disk. What its bundle does carry is the
 * inlined `packages/core/src/config/models.ts`, whose `VALID_GEMINI_MODELS` set is the build's
 * own answer to "which model ids are valid" - which is precisely the list to offer.
 *
 * The set holds identifier references, not literals, so the constants are resolved first. Only
 * ids the build itself put in VALID_GEMINI_MODELS are returned: the bundle also contains
 * one-off ids used for feature detection and an obvious test fixture, and offering those would
 * be inventing a model out of an incidental string.
 */
export function parseGeminiBundleModels(text: string): { models: ModelOption[]; aliases: Record<string, string> } {
  // The bundle is pretty-printed with `// packages/...` provenance comments, so the models
  // module can be isolated exactly rather than scraped out of 3.6MB of unrelated code.
  const start = text.indexOf("// packages/core/src/config/models.ts");
  const region = start === -1 ? text : text.slice(start, text.indexOf("\n// packages/", start + 10) + 1 || undefined);

  const constants = new Map<string, string>();
  for (const m of region.matchAll(/var ([A-Za-z0-9_$]+) = "([^"]{1,60})";/g)) constants.set(m[1], m[2]);

  const valid = region.match(/var VALID_GEMINI_MODELS = [^[]*\[([^\]]*)\]/);
  const ids = new Set<string>();
  if (valid) {
    for (const ref of valid[1].split(",")) {
      const literal = constants.get(ref.trim());
      // "none" is a real value of PREVIEW_GEMINI_FLASH_LITE_MODEL meaning "no preview exists",
      // not a model - passing it to --model would be nonsense.
      if (literal && literal !== "none") ids.add(literal);
    }
  }

  const aliases: Record<string, string> = {};
  // GEMINI_MODEL_ALIAS_AUTO/"auto" etc. are the shorthands the build accepts. The auto ones
  // point at DEFAULT/PREVIEW_GEMINI_MODEL_AUTO; the rest the build resolves server-side, so
  // they are offered with no claimed target rather than a made-up one.
  for (const m of region.matchAll(/var GEMINI_MODEL_ALIAS_[A-Z_]+ = "([a-z-]{1,20})";/g)) aliases[m[1]] = "";
  for (const m of region.matchAll(/var [A-Z_]*GEMINI_MODEL_AUTO = "([^"]{1,40})";/g)) ids.add(m[1]);

  const models = [...ids].sort().map((id) => {
    // The "auto-*" ids are routing pointers rather than a model line of their own, so they sit
    // with the shorthands instead of each becoming a family of one.
    const family = id.startsWith("auto-") ? "auto" : (id.match(/^(gemini(?:-\d+(?:\.\d+)?)?|gemma-\d+)/)?.[1] ?? id);
    return {
      id,
      label: id,
      family,
      familyLabel: family === "auto" ? "Automatic routing" : familyLabel(family.replace(/-/g, " ")),
      sourceIndex: 0,
    };
  });

  const aliasOptions: ModelOption[] = Object.keys(aliases).map((alias) => ({
    id: alias,
    label: alias,
    family: "alias",
    familyLabel: "Aliases",
    // No aliasFor: unlike Claude Code, this build does not state locally what these resolve
    // to, and a resolution nobody told us is exactly the kind of guess this app refuses.
    note: "Shorthand this build accepts; it resolves server-side, so which model answers is not knowable from here",
    sourceIndex: 0,
  }));

  return { models: [...models, ...aliasOptions], aliases };
}

/**
 * Qwen Code (0.22.3) likewise has no model-listing subcommand, but its bundle carries a real
 * structured registry: one entry per provider preset, each with its own `models:` array of
 * `{id, description?, contextWindowSize, ...}`, plus a standalone QWEN_OAUTH_MODELS for the
 * default qwen.ai login.
 *
 * Which of these a given `qwen -m <id>` accepts depends on the channel the user has configured,
 * so they are grouped by the provider preset that declares them and never presented as one
 * undifferentiated pool. Qwen's own live path is `GET {baseUrl}/models` with the account's
 * bearer token - the same call core/modelDiscovery.ts already makes for endpoint providers -
 * but that needs a logged-in resource_url, so it is not reachable from the catalog endpoint.
 */
export function parseQwenBundleModels(text: string, groupLabel?: string): ModelOption[] {
  const out: ModelOption[] = [];
  const seen = new Set<string>();

  const push = (id: string, label: string, note: string | undefined) => {
    if (seen.has(`${label}::${id}`)) return;
    seen.add(`${label}::${id}`);
    out.push({ id, label: id, family: label, familyLabel: label, note, sourceIndex: 0 });
  };

  // Provider presets: `var fooProvider = { id: "...", label: "...", ..., models: [ ... ] }`.
  const providerStarts = [...text.matchAll(/var ([A-Za-z0-9_$]+)Provider = \{/g)];
  providerStarts.forEach((match, i) => {
    const end = providerStarts[i + 1]?.index ?? text.length;
    const block = text.slice(match.index, end);
    const label = block.match(/label: "([^"]{1,60})"/)?.[1];
    const modelsAt = block.indexOf("models: [");
    if (!label || modelsAt === -1) return;
    for (const entry of splitObjectEntries(block.slice(modelsAt))) {
      const id = entry.match(/id: "([^"]{1,60})"/)?.[1];
      if (id) push(id, label, entry.match(/description: "([^"]{1,200})"/)?.[1]);
    }
  });

  // Standalone arrays (QWEN_OAUTH_MODELS, MODELSTUDIO_MODELS, TOKEN_PLAN_MODELS...). The
  // constant's own name becomes the group when the caller didn't supply one, so a new array in
  // a future build shows up labelled rather than silently merged into someone else's group.
  for (const match of text.matchAll(/var ([A-Za-z0-9_$]*MODELS[A-Za-z0-9_$]*) = \[/g)) {
    const label = groupLabel ?? familyLabel(match[1].replace(/_MODELS$/, "").replace(/_/g, " ").toLowerCase());
    for (const entry of splitObjectEntries(text.slice(match.index))) {
      const id = entry.match(/id: "([^"]{1,60})"/)?.[1];
      if (id) push(id, label, entry.match(/description: "([^"]{1,200})"/)?.[1]);
    }
  }

  return out;
}

/**
 * Splits the first `[ ... ]` array found at/after the start of `text` into its top-level `{...}`
 * entries. Brace-matched rather than regexed because these bundles are pretty-printed: a
 * single-line `\{[^}]*\}` match would stop at the first nested object (`modalities: {...}`) and
 * lose the rest of the entry. Bails out at the array's closing bracket so it can safely be
 * handed the whole remaining file.
 */
function splitObjectEntries(text: string): string[] {
  const open = text.indexOf("[");
  if (open === -1) return [];
  const entries: string[] = [];
  let depth = 0;
  let entryStart = -1;
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === "]" && depth === 0) break;
    if (ch === "{") {
      if (depth === 0) entryStart = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && entryStart !== -1) {
        entries.push(text.slice(entryStart, i + 1));
        entryStart = -1;
      }
      if (depth < 0) break;
    }
  }
  return entries;
}

/** Re-tags every option with the index of the source that produced it, and drops ids an
 * earlier (more authoritative) source already supplied. Order of `groups` is the order of
 * authority, so a live answer always wins over a shipped constant. */
export function mergeSourcedOptions(groups: ModelOption[][]): ModelOption[] {
  const seen = new Set<string>();
  const out: ModelOption[] = [];
  groups.forEach((group, sourceIndex) => {
    for (const option of group) {
      if (seen.has(option.id)) continue;
      seen.add(option.id);
      out.push({ ...option, sourceIndex });
    }
  });
  return out;
}

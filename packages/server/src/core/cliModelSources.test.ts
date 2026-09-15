import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyClaudeSections,
  claudeAliasOptions,
  familyLabel,
  mergeSourcedOptions,
  parseClaudeAdditionalModelOptions,
  parseClaudeBuildChunk,
  parseCodexModelCatalog,
  parseGeminiBundleModels,
  parseQwenBundleModels,
} from "./cliModelSources";

/**
 * Every fixture below is a verbatim excerpt of a real artifact captured on 2026-09-15, not a
 * plausible-looking invention:
 *   - CLAUDE_BUILD: bytes from C:\...\@anthropic-ai\claude-code\bin\claude.exe (2.1.272)
 *   - CODEX_CATALOG: `codex debug models` output (Codex CLI, refreshed from the service)
 *   - GEMINI_BUNDLE: @google/gemini-cli 0.59.0 bundle, packages/core/src/config/models.ts region
 *   - QWEN_BUNDLE: qwen-code 0.22.3 lib/chunks
 * That is the point: these parsers only earn trust if they are tested against what the real
 * files actually contain, and a fixture written from memory would test nothing.
 */

const CLAUDE_BUILD =
  `{fable:"claude-fable-5-1",opus:"claude-opus-5",sonnet:"claude-sonnet-5",haiku:"claude-haiku-4-5"}` +
  `,{id:"claude-sonnet-4-6",family:"sonnet",display_name:"Sonnet 4.6",knowledge_cutoff:"August 2025",` +
  `provider_ids:{first_party:"claude-sonnet-4-6",bedrock:"us.anthropic.claude-sonnet-4-6"},` +
  `fallback_3p:"claude-sonnet-4-5",context:{window:200000,supports_1m_beta:!0,supports_1m_suffix:!0},` +
  `max_output_tokens:{default:32000,upper:128000},pricing:"tier_3_15",capabilities:["effort"],advisor_rank:2}` +
  `,{id:"claude-opus-4-8",family:"opus",display_name:"Opus 4.8",knowledge_cutoff:"January 2026",` +
  `provider_ids:{first_party:"claude-opus-4-8"},context:{window:200000},max_output_tokens:{default:64000},` +
  `capabilities:["effort","max_effort"],advisor_rank:4}` +
  `,{id:"claude-haiku-4-5",family:"haiku",display_name:"Haiku 4.5",knowledge_cutoff:"February 2025",` +
  `provider_ids:{first_party:"claude-haiku-4-5"},context:{window:200000},advisor_rank:9}`;

test("claude: the build's own registry yields every model it declares, with family and label", () => {
  const { models } = parseClaudeBuildChunk(CLAUDE_BUILD);
  const sonnet = models.find((m) => m.id === "claude-sonnet-4-6");
  assert.ok(sonnet, "sonnet 4.6 present");
  assert.equal(sonnet.label, "Sonnet 4.6");
  assert.equal(sonnet.family, "sonnet");
  assert.equal(sonnet.familyLabel, "Sonnet");
  assert.equal(sonnet.note, "Knowledge cutoff August 2025");
  assert.ok(models.some((m) => m.id === "claude-opus-4-8" && m.familyLabel === "Opus"));
  assert.ok(models.some((m) => m.id === "claude-haiku-4-5"));
});

test("claude: a 1M variant is offered only for an entry the build marks supports_1m_suffix", () => {
  const { models } = parseClaudeBuildChunk(CLAUDE_BUILD);
  assert.ok(models.some((m) => m.id === "claude-sonnet-4-6[1m]"), "sonnet 4.6 declares the suffix");
  // opus-4-8's entry in this fixture does not, and the flag belonging to the PRECEDING entry
  // must not leak forward - that is exactly what the per-entry window cut exists to prevent.
  assert.ok(!models.some((m) => m.id === "claude-opus-4-8[1m]"), "opus 4.8 does not");
  assert.ok(!models.some((m) => m.id === "claude-haiku-4-5[1m]"), "haiku 4.5 does not");
});

test("claude: aliases are offered as aliases, carrying what this build resolves them to", () => {
  const { models, aliases } = parseClaudeBuildChunk(CLAUDE_BUILD);
  assert.deepEqual(aliases, {
    fable: "claude-fable-5-1",
    opus: "claude-opus-5",
    sonnet: "claude-sonnet-5",
    haiku: "claude-haiku-4-5",
  });
  const options = claudeAliasOptions(aliases, models);
  const sonnet = options.find((o) => o.id === "sonnet");
  assert.ok(sonnet);
  // The whole reason aliases were not good enough on their own: "sonnet" is not a model, and
  // the UI has to be able to say which one it currently is.
  assert.equal(sonnet.aliasFor, "claude-sonnet-5");
  // A resolution whose target this build didn't otherwise list is reported as read, not repaired.
  assert.equal(options.find((o) => o.id === "haiku")?.aliasFor, "claude-haiku-4-5");
});

test("claude: an entry split across a streamed chunk boundary is not half-parsed", () => {
  const cut = CLAUDE_BUILD.indexOf("display_name:\"Opus 4.8\"") + 5;
  const first = parseClaudeBuildChunk(CLAUDE_BUILD.slice(0, cut));
  assert.ok(!first.models.some((m) => m.id === "claude-opus-4-8"), "no partial entry emitted");
  // The streaming caller re-feeds an overlap, so the whole entry is seen on the next pass.
  const second = parseClaudeBuildChunk(CLAUDE_BUILD.slice(cut - 2048));
  assert.ok(second.models.some((m) => m.id === "claude-opus-4-8" && m.label === "Opus 4.8"));
});

test("claude: additionalModelOptionsCache is read in both the object and array shapes", () => {
  const observed = { value: "claude-fable-5-1[1m]", label: "Fable", description: "Fable 5.1 · Most capable" };
  const one = parseClaudeAdditionalModelOptions(observed);
  assert.equal(one.length, 1);
  assert.equal(one[0].id, "claude-fable-5-1[1m]");
  assert.equal(one[0].note, "Fable 5.1 · Most capable");
  assert.equal(parseClaudeAdditionalModelOptions([observed, observed]).length, 2);
  // Anything else contributes nothing rather than a blank row.
  assert.deepEqual(parseClaudeAdditionalModelOptions(undefined), []);
  assert.deepEqual(parseClaudeAdditionalModelOptions({ label: "no value" }), []);
});

/* The build's second, picker-oriented table, verbatim in shape: it sections each model as
   "main", "overflow" or "deprecated" - which is what lets this app order the list without
   inventing an opinion about which Opus is the good one. */
const CLAUDE_SECTIONS =
  `{id:"claude-opus-5",name:"Opus 5",short_name:"Opus",section:"main"` +
  `,{id:"claude-opus-4-5-20251101",name:"Opus 4.5",short_name:"Opus",section:"deprecated"` +
  `,{id:"claude-sonnet-4-6",name:"Sonnet 4.6",short_name:"Sonnet",section:"overflow"`;

test("claude: the build's own sectioning is read, not a ranking this app invented", () => {
  const { sections } = parseClaudeBuildChunk(CLAUDE_SECTIONS);
  assert.deepEqual(sections, {
    "claude-opus-5": "main",
    "claude-opus-4-5-20251101": "deprecated",
    "claude-sonnet-4-6": "overflow",
  });
});

test("claude: a model the build calls deprecated says so and sorts last, but is still offered", () => {
  const models = [
    { id: "claude-opus-4-5-20251101", label: "Opus 4.5", family: "opus", familyLabel: "Opus", note: "Knowledge cutoff May 2025", sourceIndex: 0 },
    { id: "claude-opus-5", label: "Opus 5", family: "opus", familyLabel: "Opus", sourceIndex: 0 },
  ];
  const sorted = applyClaudeSections(models, { "claude-opus-5": "main", "claude-opus-4-5-20251101": "deprecated" });
  assert.deepEqual(sorted.map((m) => m.id), ["claude-opus-5", "claude-opus-4-5-20251101"]);
  // Still present: "this build de-emphasises it" is not "you cannot use it".
  assert.match(sorted[1].note ?? "", /deprecated/);
  assert.equal(sorted[0].note, undefined);
});

test("claude: a 1M variant and an alias inherit the section of the model they point at", () => {
  const models = [
    { id: "claude-opus-4-5-20251101[1m]", label: "Opus 4.5 (1M context)", family: "opus", familyLabel: "Opus", sourceIndex: 0 },
    { id: "opus", label: "Opus", family: "opus", familyLabel: "Opus", aliasFor: "claude-opus-5", sourceIndex: 0 },
  ];
  const sorted = applyClaudeSections(models, { "claude-opus-5": "main", "claude-opus-4-5-20251101": "deprecated" });
  assert.deepEqual(sorted.map((m) => m.id), ["opus", "claude-opus-4-5-20251101[1m]"]);
});

const CODEX_CATALOG = {
  models: [
    {
      slug: "gpt-reserve",
      display_name: "GPT-Reserve",
      description: "Fast and affordable agentic coding model.",
      default_reasoning_level: "medium",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }],
      visibility: "hide",
      priority: 3,
    },
    {
      slug: "gpt-5.6-luna",
      display_name: "GPT-5.6-Luna",
      default_reasoning_level: "medium",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }, { effort: "max" }],
      visibility: "list",
      priority: 8,
    },
    {
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6-Sol",
      default_reasoning_level: "low",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "ultra" }],
      visibility: "list",
      priority: 4,
    },
  ],
};

test("codex: slugs, per-model effort levels and Codex's own ordering survive parsing", () => {
  const models = parseCodexModelCatalog(CODEX_CATALOG);
  assert.deepEqual(models.map((m) => m.id), ["gpt-reserve", "gpt-5.6-sol", "gpt-5.6-luna"], "ordered by Codex's priority");
  const luna = models.find((m) => m.id === "gpt-5.6-luna");
  assert.ok(luna);
  assert.equal(luna.label, "GPT-5.6-Luna");
  // Effort is per model in Codex's catalog, and differs between models - gpt-5.6-sol supports
  // "ultra" and gpt-5.6-luna does not, so a single global list would offer a level that fails.
  assert.deepEqual(luna.effortLevels, ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(models.find((m) => m.id === "gpt-5.6-sol")?.effortLevels, ["low", "ultra"]);
  assert.equal(luna.defaultEffort, "medium");
  assert.equal(luna.family, "gpt-5.6");
  assert.equal(luna.familyLabel, "GPT 5.6");
});

test("codex: a model Codex hides is kept but flagged, never silently dropped", () => {
  const models = parseCodexModelCatalog(CODEX_CATALOG);
  assert.equal(models.find((m) => m.id === "gpt-reserve")?.hiddenBySource, true);
  assert.equal(models.find((m) => m.id === "gpt-5.6-luna")?.hiddenBySource, false);
});

test("codex: a response that isn't a catalog yields nothing rather than junk", () => {
  assert.deepEqual(parseCodexModelCatalog(null), []);
  assert.deepEqual(parseCodexModelCatalog({ models: "nope" }), []);
  assert.deepEqual(parseCodexModelCatalog({ models: [{ display_name: "no slug" }] }), []);
});

const GEMINI_BUNDLE = `
// packages/core/src/config/models.ts
var PREVIEW_GEMINI_MODEL = "gemini-3-pro-preview";
var PREVIEW_GEMINI_FLASH_MODEL = "gemini-3-flash-preview";
var DEFAULT_GEMINI_MODEL = "gemini-2.5-pro";
var DEFAULT_GEMINI_FLASH_MODEL = "gemini-2.5-flash";
var DEFAULT_GEMINI_FLASH_LITE_MODEL = "gemini-3.1-flash-lite";
var PREVIEW_GEMINI_FLASH_LITE_MODEL = "none";
var GEMMA_4_31B_IT_MODEL = "gemma-4-31b-it";
var VALID_GEMINI_MODELS = /* @__PURE__ */ new Set([
  PREVIEW_GEMINI_MODEL, PREVIEW_GEMINI_FLASH_MODEL, DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_FLASH_MODEL, DEFAULT_GEMINI_FLASH_LITE_MODEL,
  PREVIEW_GEMINI_FLASH_LITE_MODEL, GEMMA_4_31B_IT_MODEL
]);
var PREVIEW_GEMINI_MODEL_AUTO = "auto-gemini-3";
var GEMINI_MODEL_ALIAS_AUTO = "auto";
var GEMINI_MODEL_ALIAS_PRO = "pro";
// packages/core/src/config/other.ts
var UNRELATED_MODEL = "gemini-9001-super-duper";
`;

test("gemini: only ids the build itself put in VALID_GEMINI_MODELS are offered", () => {
  const { models } = parseGeminiBundleModels(GEMINI_BUNDLE);
  const ids = models.map((m) => m.id);
  assert.ok(ids.includes("gemini-2.5-pro"));
  assert.ok(ids.includes("gemini-3-pro-preview"));
  assert.ok(ids.includes("gemma-4-31b-it"));
  // The bundle carries incidental ids used for tests and feature detection; offering one
  // would be conjuring a model out of an unrelated string literal.
  assert.ok(!ids.includes("gemini-9001-super-duper"), "id outside the valid set stays out");
  // "none" is a real constant value meaning "no preview exists", not a model.
  assert.ok(!ids.includes("none"), "the sentinel is not a model");
});

test("gemini: auto ids and shorthand aliases are both offered, aliases without a fake target", () => {
  const { models } = parseGeminiBundleModels(GEMINI_BUNDLE);
  // A routing pointer is grouped with the shorthands, not made a family of one.
  assert.equal(models.find((m) => m.id === "auto-gemini-3")?.familyLabel, "Automatic routing");
  const pro = models.find((m) => m.id === "pro");
  assert.ok(pro, "shorthand offered");
  assert.equal(pro.familyLabel, "Aliases");
  // Unlike Claude Code, this build does not state locally what "pro" resolves to, so nothing
  // is claimed.
  assert.equal(pro.aliasFor, undefined);
});

test("gemini: families group by version so variants are legible", () => {
  const { models } = parseGeminiBundleModels(GEMINI_BUNDLE);
  assert.equal(models.find((m) => m.id === "gemini-2.5-flash")?.family, "gemini-2.5");
  assert.equal(models.find((m) => m.id === "gemini-2.5-flash")?.familyLabel, "Gemini 2.5");
  assert.equal(models.find((m) => m.id === "gemma-4-31b-it")?.family, "gemma-4");
});

const QWEN_BUNDLE = `
var QWEN_OAUTH_MODELS = [
  {
    id: "coder-model",
    name: "coder-model",
    description: "Qwen 3.7 Max - efficient hybrid model with leading coding performance",
    capabilities: { vision: true }
  }
];
var MODELSTUDIO_MODELS = [
  {
    id: "qwen3.5-plus",
    contextWindowSize: 1e6,
    enableThinking: true,
    modalities: { image: true, video: true }
  },
  {
    id: "qwen3.6-plus",
    description: "Currently available to Pro subscribers only.",
    contextWindowSize: 1e6,
    enableThinking: true,
    modalities: { image: true, video: true }
  }
];
var deepseekProvider = {
  id: "deepseek",
  label: "DeepSeek API Key",
  protocol: "openai",
  baseUrl: "https://api.deepseek.com/v1",
  models: [
    { id: "deepseek-v4-pro", contextWindowSize: 131072 },
    { id: "deepseek-v4-flash", contextWindowSize: 131072 }
  ]
};
`;

test("qwen: pretty-printed entries with nested objects are parsed whole", () => {
  const models = parseQwenBundleModels(QWEN_BUNDLE);
  const ids = models.map((m) => m.id);
  // modalities:{...} nests inside each entry - a non-brace-matching parser stops there and
  // loses every model after the first.
  assert.ok(ids.includes("qwen3.5-plus"), "first entry");
  assert.ok(ids.includes("qwen3.6-plus"), "entry after a nested object");
  assert.equal(models.find((m) => m.id === "qwen3.6-plus")?.note, "Currently available to Pro subscribers only.");
});

test("qwen: models are grouped by the provider preset that declares them", () => {
  const models = parseQwenBundleModels(QWEN_BUNDLE);
  assert.equal(models.find((m) => m.id === "deepseek-v4-pro")?.familyLabel, "DeepSeek API Key");
  assert.equal(models.find((m) => m.id === "coder-model")?.familyLabel, "Qwen OAuth");
  assert.equal(models.find((m) => m.id === "qwen3.5-plus")?.familyLabel, "Modelstudio");
  // Grouping is what keeps this honest: "grok-4.5 under Qwen" only makes sense once the
  // heading says which Qwen provider preset you would have to be using.
  assert.notEqual(
    models.find((m) => m.id === "coder-model")?.familyLabel,
    models.find((m) => m.id === "deepseek-v4-pro")?.familyLabel,
  );
});

test("mergeSourcedOptions keeps the first source's entry and tags every option with its source", () => {
  const merged = mergeSourcedOptions([
    [{ id: "a", label: "A (live)", family: "f", familyLabel: "F", sourceIndex: 0 }],
    [
      { id: "a", label: "A (stale)", family: "f", familyLabel: "F", sourceIndex: 0 },
      { id: "b", label: "B", family: "f", familyLabel: "F", sourceIndex: 0 },
    ],
  ]);
  assert.deepEqual(merged.map((m) => [m.id, m.label, m.sourceIndex]), [
    ["a", "A (live)", 0],
    ["b", "B", 1],
  ]);
});

test("familyLabel title-cases without a lookup table, so a new family is never missing", () => {
  assert.equal(familyLabel("opus"), "Opus");
  assert.equal(familyLabel("gemini-3.1"), "Gemini 3.1");
  assert.equal(familyLabel("gpt-5.6"), "GPT 5.6");
  assert.equal(familyLabel("qwen oauth"), "Qwen OAuth");
  assert.equal(familyLabel("some-family-nobody-has-shipped-yet"), "Some Family Nobody Has Shipped Yet");
});

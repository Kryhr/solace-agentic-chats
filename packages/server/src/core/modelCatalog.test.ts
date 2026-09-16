import assert from "node:assert/strict";
import { test } from "node:test";
import { clearModelCatalogCache, getModelCatalog } from "./modelCatalog";

/**
 * These run against whatever CLIs are actually installed on the machine running the tests, so
 * they deliberately assert the CONTRACT rather than any particular model id. Asserting that
 * "claude-opus-5 is present" would bake into the test suite exactly the hardcoded catalog this
 * work exists to remove, and would start failing the day Anthropic ships something new.
 *
 * What must hold on any machine, with any CLIs installed or none:
 *   - every model listed points at a source that actually exists,
 *   - nothing is listed without one,
 *   - a provider that could not be enumerated says why instead of looking empty-by-fact.
 */

const PROVIDERS = ["claude-code", "codex-cli", "gemini-cli", "qwen-code", "copilot-cli", "opencode", "crush", "continue", "droid", "kilo", "kimi"];

test("the catalog covers every CLI provider, in a stable shape", async () => {
  const catalog = await getModelCatalog();
  assert.deepEqual(catalog.map((c) => c.provider).sort(), [...PROVIDERS].sort());
  for (const info of catalog) {
    assert.ok(Array.isArray(info.models), `${info.provider} models`);
    assert.ok(Array.isArray(info.sources), `${info.provider} sources`);
    assert.ok(Array.isArray(info.effortLevels), `${info.provider} effortLevels`);
  }
});

test("every listed model is traceable to a real source entry", async () => {
  for (const info of await getModelCatalog()) {
    for (const model of info.models) {
      assert.ok(model.id.trim().length > 0, `${info.provider} model id`);
      assert.ok(model.label.trim().length > 0, `${info.provider} ${model.id} label`);
      assert.ok(model.familyLabel.trim().length > 0, `${info.provider} ${model.id} familyLabel`);
      const source = info.sources[model.sourceIndex];
      assert.ok(source, `${info.provider} ${model.id} points at a source that exists`);
      assert.ok(source.origin.trim().length > 0, `${info.provider} source origin`);
      assert.ok(!Number.isNaN(Date.parse(source.readAt)), `${info.provider} source readAt is a real timestamp`);
    }
  }
});

test("no source is claimed without models, and no silence stands in for an answer", async () => {
  for (const info of await getModelCatalog()) {
    // A source row in the UI says "this many ids came from here" - it must not be able to lie.
    const counted = info.sources.reduce((n, s) => n + s.count, 0);
    assert.ok(counted >= info.models.length, `${info.provider}: sources account for every model`);
    // "We found nothing" and "we could not look" are different answers and the UI shows them
    // differently, so an empty list without a stated reason is a bug, not a state.
    if (info.models.length === 0) {
      assert.ok(info.sourceError && info.sourceError.trim().length > 0, `${info.provider} explains an empty list`);
    }
  }
});

test("model ids are unique per provider, so a select can key on them", async () => {
  for (const info of await getModelCatalog()) {
    const ids = info.models.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length, `${info.provider} has duplicate model ids`);
  }
});

test("an alias is marked as one, and never silently presented as a concrete model", async () => {
  for (const info of await getModelCatalog()) {
    for (const model of info.models) {
      if (model.aliasFor === undefined) continue;
      assert.ok(model.aliasFor.trim().length > 0, `${info.provider} ${model.id}: empty alias target`);
      assert.notEqual(model.aliasFor, model.id, `${info.provider} ${model.id}: alias resolving to itself`);
    }
  }
});

test("the catalog is memoised, since it reads a 230MB binary and spawns a CLI", async () => {
  clearModelCatalogCache();
  const first = await getModelCatalog();
  const started = Date.now();
  const second = await getModelCatalog();
  assert.equal(second, first, "same array instance served from cache");
  assert.ok(Date.now() - started < 100, "a cached read does no I/O");
});

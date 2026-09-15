import assert from "node:assert/strict";
import { test } from "node:test";
import { PROVIDER_CATALOG, searchCatalog } from "@solace/shared";
import { LOCAL_RUNTIMES } from "./localDiscovery";

// The catalog's whole value is that a tile pre-fills a base URL the user never has to check.
// That only holds if the entries stay well-formed, so these tests guard the shape - not the
// URLs themselves, which are verified against each provider's own docs by hand (see the
// dated comment in shared/src/providerCatalog.ts) and can't be checked without a network.

test("every entry has a name and an absolute http(s) base URL with no trailing slash", () => {
  for (const p of PROVIDER_CATALOG) {
    assert.ok(p.name.trim().length > 0, "name");
    assert.match(p.baseUrl, /^https?:\/\//, `${p.name} baseUrl scheme`);
    // credentials.ts strips trailing slashes on save, but a slash here would still show up in
    // the form the user is asked to confirm.
    assert.ok(!p.baseUrl.endsWith("/"), `${p.name} baseUrl trailing slash`);
  }
});

test("names and hosted base URLs are unique", () => {
  const names = PROVIDER_CATALOG.map((p) => p.name);
  assert.equal(new Set(names).size, names.length, "duplicate tile name");
  // Local entries legitimately share a URL (llama.cpp and LocalAI both default to :8080),
  // which is exactly why neither is in the automatic scan - see localDiscovery.ts.
  const hosted = PROVIDER_CATALOG.filter((p) => !p.local).map((p) => p.baseUrl);
  assert.equal(new Set(hosted).size, hosted.length, "duplicate hosted base URL");
});

test("hosted entries carry a key hint, local entries carry a runtime and no key hint", () => {
  for (const p of PROVIDER_CATALOG) {
    if (p.local) {
      // keyHint is optional precisely so a local tile can say "no key needed" instead of
      // rendering an empty hint that reads as a missing value.
      assert.equal(p.keyHint, undefined, `${p.name} should not claim a key source`);
      assert.ok(p.runtime, `${p.name} needs a runtime id`);
    } else {
      assert.ok(p.keyHint && p.keyHint.trim().length > 0, `${p.name} needs a key hint`);
      assert.equal(p.runtime, undefined, `${p.name} is not a local runtime`);
    }
  }
});

test("local tiles point at 127.0.0.1 and at a runtime the prober knows", () => {
  const known = new Set(LOCAL_RUNTIMES.map((r) => r.id));
  for (const p of PROVIDER_CATALOG.filter((x) => x.local)) {
    // Never "localhost": GPT4All binds IPv4 only, and localhost resolves to ::1 first.
    assert.ok(p.baseUrl.startsWith("http://127.0.0.1:"), `${p.name} must use literal 127.0.0.1`);
    assert.ok(known.has(p.runtime!), `${p.name} references unknown runtime ${p.runtime}`);
  }
});

test("Perplexity points at the Router API, not the retiring Sonar chat root", () => {
  // Sonar Chat Completions on the bare https://api.perplexity.ai root is documented as
  // supported only until 2026-09-27; the Router API is the documented replacement.
  const perplexity = PROVIDER_CATALOG.find((p) => p.name.startsWith("Perplexity"));
  assert.ok(perplexity);
  assert.equal(perplexity.baseUrl, "https://api.perplexity.ai/router/v1");
});

test("searchCatalog matches on name and base URL, and returns everything when blank", () => {
  assert.equal(searchCatalog("  ").length, PROVIDER_CATALOG.length);
  assert.ok(searchCatalog("ollama").some((p) => p.name === "Ollama"));
  assert.ok(searchCatalog("moonshot").some((p) => p.name === "Moonshot (Kimi)"));
  assert.ok(searchCatalog("127.0.0.1").every((p) => p.local));
  assert.deepEqual(searchCatalog("nothing-matches-this"), []);
});

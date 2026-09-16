import assert from "node:assert/strict";
import { test } from "node:test";
import type { TrustLevel } from "@solace/shared";
import {
  DROID_REASONING_EFFORTS,
  buildDroidArgs,
  droidAutonomyFlags,
  droidUsage,
  isNotSignedInError,
} from "./droid";

const ALL_LEVELS: TrustLevel[] = ["plan", "manual", "acceptEdits", "bypassPermissions", "auto"];

const BASE = { cwd: "C:\\work\\proj", trustLevel: "plan" as TrustLevel };

/**
 * The authoritative autonomy vocabulary, taken from the installed 0.220.0 binary's own help
 * rather than from Factory's docs: `droid exec --help` documents exactly `--auto low|medium|high`
 * plus `--skip-permissions-unsafe`, and `droid exec --auto bogus` is rejected locally.
 */
const AUTO_LEVELS = new Set(["low", "medium", "high"]);

test("every trust level produces only autonomy flags droid actually defines", () => {
  for (const level of ALL_LEVELS) {
    const flags = droidAutonomyFlags(level);
    for (let i = 0; i < flags.length; i++) {
      const flag = flags[i];
      if (flag === "--skip-permissions-unsafe") continue;
      if (flag === "--auto") {
        assert.ok(
          AUTO_LEVELS.has(flags[i + 1]),
          `${level} passes --auto ${flags[i + 1]}, which droid does not define`,
        );
        i++;
        continue;
      }
      assert.fail(`${level} produces unknown droid flag "${flag}"`);
    }
  }
});

test("plan mode passes no autonomy flag at all, leaving droid's read-only default in place", () => {
  // This is the one level whose enforcement is structural rather than classifier-judged:
  // `droid exec --list-tools` reports ApplyPatch as "status: blocked" at the default level and
  // "status: allowed" at every --auto tier (verified across all five levels on the real binary).
  assert.deepEqual(droidAutonomyFlags("plan"), []);
});

test("manual collapses onto read-only, never onto a permissive level", () => {
  // "manual" is not offered for this provider (see DROID-REGISTRATION.md) because `droid exec`
  // has no path to a human. An agent saved under it before a catalog change must still run -
  // and must run with the LEAST authority, not the most. The inverse bug would be a mode
  // labelled "stop and ask me" silently granting unattended write access.
  assert.deepEqual(droidAutonomyFlags("manual"), []);
});

test("acceptEdits stops short of medium, which would add installs and network fetches", () => {
  assert.deepEqual(droidAutonomyFlags("acceptEdits"), ["--auto", "low"]);
});

test("only bypassPermissions may skip permission checks", () => {
  for (const level of ALL_LEVELS) {
    const skips = droidAutonomyFlags(level).includes("--skip-permissions-unsafe");
    assert.equal(skips, level === "bypassPermissions", `${level} skip-permissions = ${skips}`);
  }
});

test("no trust level ever reaches --auto high", () => {
  // high is the tier that permits `curl | bash` and `git push --force`. Nothing maps to it on
  // purpose; if a future level wants it, that should be a deliberate edit with its own test.
  for (const level of ALL_LEVELS) {
    assert.ok(!droidAutonomyFlags(level).join(" ").includes("--auto high"), `${level} reached --auto high`);
  }
});

test("the prompt is never passed as an argument", () => {
  // The whole point of the signature: `droid exec` takes a prompt positionally, and a large
  // context block passed that way is what caused a real spawn ENAMETOOLONG outage for the
  // argv-based adapters in this repo. Verified live that droid reads stdin instead - a
  // 200,000-byte prompt on stdin runs with no length complaint at all.
  const prompt = "x".repeat(50_000);
  const args = buildDroidArgs({ ...BASE, trustLevel: "bypassPermissions" });
  for (const arg of args) {
    assert.ok(!arg.includes(prompt), "prompt leaked into argv");
  }
  assert.ok(args.join(" ").length < 500, "argv should stay small regardless of prompt size");
});

test("uses the non-deprecated json output format", () => {
  const args = buildDroidArgs(BASE);
  const at = args.indexOf("-o");
  assert.notEqual(at, -1, "no output format requested");
  assert.equal(args[at + 1], "json");
  // stream-json emits NDJSON and looks richer, but Factory documents it as DEPRECATED and
  // publishes no schema, and its assistant/tool event shapes could not be captured here. An
  // adapter must not parse event shapes nobody has observed.
  assert.ok(!args.includes("stream-json"));
});

test("cwd is passed explicitly, not left to the spawn cwd alone", () => {
  const args = buildDroidArgs(BASE);
  const at = args.indexOf("--cwd");
  assert.notEqual(at, -1);
  assert.equal(args[at + 1], BASE.cwd);
});

test("a first turn requests no session; a later turn resumes with -s and never forks", () => {
  assert.ok(!buildDroidArgs(BASE).includes("-s"));

  const resumed = buildDroidArgs({ ...BASE, sessionId: "8af22e0a-d222-42c6-8c7e-7a059e391b0b" });
  const at = resumed.indexOf("-s");
  assert.notEqual(at, -1);
  assert.equal(resumed[at + 1], "8af22e0a-d222-42c6-8c7e-7a059e391b0b");
  // --fork would mint a NEW session from the old one every turn, so the agent would branch its
  // own history instead of continuing it.
  assert.ok(!resumed.includes("--fork"));
});

test("model and effort are only passed when the caller asked for them", () => {
  const bare = buildDroidArgs(BASE);
  assert.ok(!bare.includes("-m"));
  assert.ok(!bare.includes("-r"));

  const full = buildDroidArgs({ ...BASE, model: "claude-sonnet-5", effort: "high" });
  assert.equal(full[full.indexOf("-m") + 1], "claude-sonnet-5");
  assert.equal(full[full.indexOf("-r") + 1], "high");
});

test("the effort vocabulary matches what the CLI itself accepts", () => {
  // Captured from the real binary's rejection message, which is produced locally and before
  // any auth check: `droid exec -r bogus` answers
  // "Allowed values: none, dynamic, off, minimal, low, medium, high, xhigh, max".
  assert.deepEqual([...DROID_REASONING_EFFORTS], [
    "none",
    "dynamic",
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
});

test("the unauthenticated failure is recognised from droid's real message", () => {
  // Verbatim from a real unauthenticated run of the installed binary.
  const real = "Authentication failed. Please log in using /login or set a valid FACTORY_API_KEY environment variable.";
  assert.ok(isNotSignedInError(real));
  assert.ok(!isNotSignedInError("Invalid model: __invalid__"));
  assert.ok(!isNotSignedInError("the file could not be written"));
});

test("usage carries every count droid reports, and never a fabricated dollar cost", () => {
  // The exact shape captured from a real envelope.
  const raw = {
    input_tokens: 1200,
    output_tokens: 340,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 15,
    factory_credits: 7,
  };
  // The cache buckets used to be dropped here for want of anywhere to put them. They are most
  // of a real Droid prompt, so dropping them understated every turn.
  assert.deepEqual(droidUsage(raw), {
    inputTokens: 1200,
    outputTokens: 340,
    cacheReadTokens: 900,
    cacheWriteTokens: 15,
    cacheCountedInInput: false,
    otherCosts: [{ amount: 7, unit: "Factory credit" }],
  });
  // A Factory credit is not a dollar. Mapping it to totalCostUsd would put a fabricated dollar
  // figure in front of the user, so it is reported in Droid's own unit instead and no dollar
  // cost is reported for this provider at all.
  assert.equal(droidUsage(raw)!.totalCostUsd, undefined);
  assert.equal(droidUsage(raw)!.estimatedCostUsd, undefined);
});

test("a usage block with no usable numbers reports nothing rather than zeros", () => {
  // "we don't know" and "0 tokens" are different facts.
  assert.equal(droidUsage(undefined), undefined);
  assert.equal(droidUsage({}), undefined);
});

test("a credit figure with no token counts is still reported - it is a real number droid gave", () => {
  assert.deepEqual(droidUsage({ factory_credits: 3 }), { otherCosts: [{ amount: 3, unit: "Factory credit" }] });
});

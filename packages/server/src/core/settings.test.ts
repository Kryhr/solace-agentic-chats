import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_APP_SETTINGS, SETTING_DEFINITIONS, sanitizeAppSettings } from "@solace/shared";
import {
  INTERRUPT_GRACE_MS,
  MAX_HANDOVERS,
  MAX_MID_TURN_POSTS,
  MAX_RESUMES,
  MAX_TURN_IDLE_MS,
  MAX_TURN_MS,
  formatDuration,
  resumeBudgetMs,
  resumeExhausted,
} from "./agentManager";
import { SettingsStore } from "./settingsStore";
import { AgentManager } from "./agentManager";
import { ChatBus } from "./chatBus";
import { ChatStore } from "./chatStore";
import type { AgentConfig } from "@solace/shared";

/**
 * The point of every test in this file: a settings page is only worth having if a bad value
 * cannot get through it, and if the value that DOES get through is the one the running code
 * actually reads. The boolean path already had both properties (see handover.test.ts) - these
 * pin them for the number and select paths too.
 */

test("every setting definition has a default, and every default has a definition", () => {
  // The two halves of the schema are written together by hand, and a key present in only one
  // of them fails silently: an undefined default renders an empty control, and a default with
  // no definition is a field nothing can ever change.
  const defined = SETTING_DEFINITIONS.map((d) => d.key).sort();
  const defaulted = Object.keys(DEFAULT_APP_SETTINGS).sort();
  assert.deepEqual(defined, defaulted);

  for (const def of SETTING_DEFINITIONS) {
    const value = DEFAULT_APP_SETTINGS[def.key];
    if (def.kind === "toggle") assert.equal(typeof value, "boolean", `${def.key} default`);
    if (def.kind === "number") {
      assert.equal(typeof value, "number", `${def.key} default`);
      // A default outside its own advertised range would be un-re-selectable: sanitize would
      // refuse the very value it falls back to.
      assert.ok(
        (value as number) >= def.min && (value as number) <= def.max,
        `${def.key} default ${value} is outside its own ${def.min}-${def.max} range`,
      );
      assert.ok(def.min < def.max, `${def.key} has an empty range`);
    }
    if (def.kind === "select") {
      assert.ok(
        def.options.some((o) => o.value === value),
        `${def.key} default ${String(value)} is not one of its own options`,
      );
    }
  }
});

test("the defaults are exactly the constants the code used before any of this was configurable", () => {
  // The whole promise of this feature is "nothing changes for someone who never opens
  // Settings". That promise is this assertion; without it a typo in a default silently
  // changes every user's turn limits.
  assert.equal(DEFAULT_APP_SETTINGS.maxTurnMinutes * 60_000, MAX_TURN_MS);
  assert.equal(DEFAULT_APP_SETTINGS.turnIdleMinutes * 60_000, MAX_TURN_IDLE_MS);
  assert.equal(DEFAULT_APP_SETTINGS.maxResumes, MAX_RESUMES);
  assert.equal(DEFAULT_APP_SETTINGS.maxHandovers, MAX_HANDOVERS);
  assert.equal(DEFAULT_APP_SETTINGS.maxMidTurnPosts, MAX_MID_TURN_POSTS);
  assert.equal(DEFAULT_APP_SETTINGS.interruptGraceSeconds * 1000, INTERRUPT_GRACE_MS);
});

test("a missing key falls back to its default rather than becoming undefined", () => {
  // Every state file written before these settings existed looks exactly like this, as does
  // every PATCH body that only mentions one setting.
  assert.deepEqual(sanitizeAppSettings({}), DEFAULT_APP_SETTINGS);
  assert.deepEqual(sanitizeAppSettings(undefined), DEFAULT_APP_SETTINGS);
  assert.deepEqual(sanitizeAppSettings(null), DEFAULT_APP_SETTINGS);

  // A partial object keeps what it says and defaults the rest - it must not wipe the others.
  const partial = sanitizeAppSettings({ maxResumes: 7 });
  assert.equal(partial.maxResumes, 7);
  assert.equal(partial.maxTurnMinutes, DEFAULT_APP_SETTINGS.maxTurnMinutes);
  assert.equal(partial.agentsFollowProjects, DEFAULT_APP_SETTINGS.agentsFollowProjects);
});

test("a number outside its range is refused, not clamped", () => {
  // Clamping would be a guess. The only thing we know about "maxTurnMinutes: 99999" is that
  // whoever produced it was not talking about this setting, so the documented default is the
  // honest answer - the same rule the boolean path follows for "yes".
  assert.equal(sanitizeAppSettings({ maxTurnMinutes: 99999 }).maxTurnMinutes, 120);
  assert.equal(sanitizeAppSettings({ maxTurnMinutes: 0 }).maxTurnMinutes, 120);
  assert.equal(sanitizeAppSettings({ maxTurnMinutes: -5 }).maxTurnMinutes, 120);
  assert.equal(sanitizeAppSettings({ turnIdleMinutes: 61 }).turnIdleMinutes, 5);
  assert.equal(sanitizeAppSettings({ maxResumes: 11 }).maxResumes, 3);
  assert.equal(sanitizeAppSettings({ interruptGraceSeconds: 4 }).interruptGraceSeconds, 50);

  // Both bounds are inclusive, so the numbers printed under the box are actually selectable.
  assert.equal(sanitizeAppSettings({ maxTurnMinutes: 5 }).maxTurnMinutes, 5);
  assert.equal(sanitizeAppSettings({ maxTurnMinutes: 720 }).maxTurnMinutes, 720);
  // Zero is a legal, meaningful value for the three caps whose range starts there - "never
  // resume", "never hand over", "never post mid-turn" - and must not be mistaken for absent.
  assert.equal(sanitizeAppSettings({ maxResumes: 0 }).maxResumes, 0);
  assert.equal(sanitizeAppSettings({ maxHandovers: 0 }).maxHandovers, 0);
  assert.equal(sanitizeAppSettings({ maxMidTurnPosts: 0 }).maxMidTurnPosts, 0);
});

test("a wrong-typed value is refused, including the ones that look like numbers", () => {
  // "3" arrives from any hand-edited JSON and from any form that forgets to parse its input.
  // Coercing it would mean "" and "abc" coerce too (to 0 and NaN), so it is refused outright.
  for (const bad of ["3", "", true, false, null, [], {}, () => 3, NaN, Infinity, -Infinity]) {
    assert.equal(
      sanitizeAppSettings({ maxResumes: bad as unknown as number }).maxResumes,
      DEFAULT_APP_SETTINGS.maxResumes,
      `${String(bad)} must not be believed as a number`,
    );
  }
  // And the reverse: a number must not be believed as a boolean or as a select value.
  assert.equal(sanitizeAppSettings({ handoverOnUsageExhausted: 1 as unknown as boolean }).handoverOnUsageExhausted, false);
  assert.equal(sanitizeAppSettings({ defaultTrustLevel: 1 as never }).defaultTrustLevel, "bypassPermissions");
});

test("a fractional number is rounded, and rounding cannot push it out of range", () => {
  // "2.5 minutes" is an unambiguous intent the underlying timer just expresses in whole units,
  // so it is rounded rather than refused.
  assert.equal(sanitizeAppSettings({ turnIdleMinutes: 2.4 }).turnIdleMinutes, 2);
  assert.equal(sanitizeAppSettings({ turnIdleMinutes: 2.6 }).turnIdleMinutes, 3);
  // Rounding happens BEFORE the range check, so a value that only leaves the range by rounding
  // is still accepted at the bound rather than silently reset to the default.
  assert.equal(sanitizeAppSettings({ turnIdleMinutes: 60.4 }).turnIdleMinutes, 60);
  assert.equal(sanitizeAppSettings({ maxTurnMinutes: 4.6 }).maxTurnMinutes, 5);
  // But a genuinely out-of-range fraction is still refused.
  assert.equal(sanitizeAppSettings({ turnIdleMinutes: 60.6 }).turnIdleMinutes, 5);
});

test("a select setting accepts only its own options", () => {
  assert.equal(sanitizeAppSettings({ defaultTrustLevel: "plan" }).defaultTrustLevel, "plan");
  assert.equal(sanitizeAppSettings({ defaultTrustLevel: "acceptEdits" }).defaultTrustLevel, "acceptEdits");
  // Near-misses are the realistic failure: a stale value, a typo, a different casing. None of
  // them may reach an agent's --permission-mode flag.
  for (const bad of ["Plan", "bypass", "yolo", "", "acceptedits"]) {
    assert.equal(
      sanitizeAppSettings({ defaultTrustLevel: bad as never }).defaultTrustLevel,
      "bypassPermissions",
      `${bad} must not be accepted as a trust level`,
    );
  }
});

test("unknown keys are dropped rather than carried along", () => {
  const out = sanitizeAppSettings({ maxResumes: 4, somethingRemoved: true, __proto__: { polluted: true } });
  assert.equal(out.maxResumes, 4);
  assert.equal("somethingRemoved" in out, false);
  assert.deepEqual(Object.keys(out).sort(), Object.keys(DEFAULT_APP_SETTINGS).sort());
});

test("the store re-sanitizes a patch, so a bad value cannot land through update()", () => {
  // The HTTP route hands its body straight to update(); this is the only thing between a
  // hand-rolled PATCH and a turn timeout of zero.
  const store = new SettingsStore({ maxTurnMinutes: 30 });
  assert.equal(store.get().maxTurnMinutes, 30);

  assert.equal(store.update({ maxTurnMinutes: 0 }).maxTurnMinutes, 120, "out of range resets to the default");
  assert.equal(store.update({ maxTurnMinutes: 45 }).maxTurnMinutes, 45);
  assert.equal(
    store.update({ maxResumes: "lots" as unknown as number }).maxResumes,
    DEFAULT_APP_SETTINGS.maxResumes,
    "a wrong type resets to the default",
  );
  // A patch touching one key must not disturb another.
  assert.equal(store.get().maxTurnMinutes, 45);
});

test("the turn-budget helpers honour the limits passed in, not the module constants", () => {
  // This is what makes the settings live: agentManager passes the CURRENT values in at the
  // moment of enforcement. If these ignored their arguments the setting would render, save,
  // persist - and change nothing, which is the exact failure this project forbids.
  const tenMinutes = 10 * 60_000;
  assert.equal(resumeBudgetMs(undefined, tenMinutes), tenMinutes);
  assert.equal(resumeBudgetMs({ ofTurnId: "a", count: 1, elapsedMs: 4 * 60_000 }, tenMinutes), 6 * 60_000);
  // The one-minute floor still applies, so a nearly-exhausted resume is not killed on arrival.
  assert.equal(resumeBudgetMs({ ofTurnId: "a", count: 1, elapsedMs: tenMinutes }, tenMinutes), 60_000);

  assert.equal(resumeExhausted(1, 0, 0, tenMinutes), true, "maxResumes 0 means never resume");
  assert.equal(resumeExhausted(0, 0, 0, tenMinutes), false);
  assert.equal(resumeExhausted(5, 0, 5, tenMinutes), false);
  assert.equal(resumeExhausted(6, 0, 5, tenMinutes), true);
  assert.equal(resumeExhausted(1, tenMinutes, 5, tenMinutes), true, "the time budget ends it too");

  // Omitting them keeps the old behaviour exactly, which is what every existing caller relies on.
  assert.equal(resumeBudgetMs(undefined), MAX_TURN_MS);
  assert.equal(resumeExhausted(MAX_RESUMES, MAX_TURN_MS - 1), false);
});

test("a stopped turn quotes its own configured limit in a unit that is not a lie", () => {
  // The message used to hard-code hours because the budget was always two of them. With the
  // ceiling configurable down to five minutes, Math.round(ms / 3600000) prints "0h".
  assert.equal(formatDuration(5 * 60_000), "5 minutes");
  assert.equal(formatDuration(60_000), "1 minute");
  assert.equal(formatDuration(89 * 60_000), "89 minutes");
  assert.equal(formatDuration(MAX_TURN_MS), "2h");
  assert.equal(formatDuration(90 * 60_000), "1.5h");
  assert.equal(formatDuration(720 * 60_000), "12h");
});

/**
 * The live-read guarantee, exercised through the real code path rather than asserted about.
 *
 * A setting that is read once at boot looks identical from the outside: it renders, it saves,
 * it persists. The only way to tell the difference is to change it on a manager that already
 * exists and watch the very next enforcement use the new number - which is exactly what happens
 * when someone edits Settings in one tab while a turn is about to start.
 */
function midTurnHarness(store: SettingsStore) {
  const chats = new ChatStore();
  const chat = chats.createChat("One");
  const agents: AgentConfig[] = [
    { id: "a1", handle: "claude", provider: "claude-code", cwd: process.cwd(), trustLevel: "manual" },
  ];
  const manager = new AgentManager(new ChatBus(), chats, agents, undefined, [], [], [], store);
  (manager as unknown as { drainQueue: (id: string) => Promise<void> }).drainQueue = async () => {};

  // Put a turn in flight and mint its token the same way drainQueue does - the only state
  // postFromCurrentTurn trusts.
  const runtime = (manager as unknown as { agents: Map<string, Record<string, unknown>> }).agents.get("a1")!;
  runtime.currentTurn = {
    id: "t1",
    prompt: "p",
    replyChannel: { chatId: chat.id },
    mentionChainDepth: 0,
    kind: "work",
    receivedAt: new Date().toISOString(),
  };
  runtime.activeTurnToken = "tok";
  return manager;
}

test("the mid-turn post cap is read from the settings at the moment of the post", () => {
  const store = new SettingsStore({ maxMidTurnPosts: 2 });
  const manager = midTurnHarness(store);

  assert.equal(manager.postFromCurrentTurn("a1", "tok", "one", "fyi").ok, true);
  assert.equal(manager.postFromCurrentTurn("a1", "tok", "two", "fyi").ok, true);
  const third = manager.postFromCurrentTurn("a1", "tok", "three", "fyi");
  assert.equal(third.ok, false);
  assert.match(third.error ?? "", /capped at 2/, "the refusal quotes the configured cap, not the constant");

  // Raised while the SAME turn is still running: the next post goes through. A cap captured at
  // construction - or even at the start of the turn - would still refuse this.
  store.update({ maxMidTurnPosts: 4 });
  assert.equal(manager.postFromCurrentTurn("a1", "tok", "four", "fyi").ok, true);

  // And lowering it takes effect just as immediately, without waiting for a turn boundary.
  store.update({ maxMidTurnPosts: 0 });
  const refused = manager.postFromCurrentTurn("a1", "tok", "five", "fyi");
  assert.equal(refused.ok, false);
  assert.match(refused.error ?? "", /turned off/, "zero is explained as off, not as a cap of zero");
});

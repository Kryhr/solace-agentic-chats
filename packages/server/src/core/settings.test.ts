import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_APP_SETTINGS, SETTING_DEFINITIONS, SETTING_SECTIONS, sanitizeAppSettings } from "@solace/shared";
import {
  AGENT_QUESTION_GRACE_MS,
  INTERRUPT_GRACE_MS,
  MAX_HANDOVERS,
  MAX_MENTION_CHAIN_DEPTH,
  MAX_MID_TURN_POSTS,
  MAX_RESUMES,
  MAX_TURN_IDLE_MS,
  MAX_TURN_MS,
  MAX_DELIVERED_CHARS,
  announcesChainCutoff,
  deliverableText,
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
  assert.equal(DEFAULT_APP_SETTINGS.maxMentionChainDepth, MAX_MENTION_CHAIN_DEPTH);
  assert.equal(DEFAULT_APP_SETTINGS.agentQuestionGraceMinutes * 60_000, AGENT_QUESTION_GRACE_MS);
  // No constant to compare against - this one is new behaviour rather than a constant made
  // configurable - so the promise is spelled out instead: OFF is what the code did before, with
  // reasoning and tool-use lines going only to the agent's own hub.
  assert.equal(DEFAULT_APP_SETTINGS.showAgentWorkInGroupChat, false);
  assert.equal(DEFAULT_APP_SETTINGS.maxDeliveredChars, MAX_DELIVERED_CHARS);
});

test("the delivery cap is the one passed in, not the module constant", () => {
  // Same live-read guarantee as the turn budget. deliverableText defaults to the constant so
  // every existing caller is unchanged, but drainQueue passes the CONFIGURED value at the
  // moment of delivery - if this ignored its argument the setting would render, save and
  // persist while changing nothing, which is the failure this project forbids.
  const long = "x".repeat(2000);
  assert.equal(deliverableText(long, 3000), long, "under the cap, nothing is touched");

  const cut = deliverableText(long, 500);
  assert.ok(cut.startsWith("x".repeat(500)));
  assert.ok(!cut.startsWith("x".repeat(501)), "the cap passed in is the cap applied");
  // The cut announces itself with the real length. A silent ellipsis is the original incident:
  // the receiver read a truncated audit as a "preview" and asked for the rest, twice.
  assert.match(cut, /was 2000 characters and was cut here at 500/);

  // Omitting it keeps the old behaviour exactly, which every other caller and test relies on.
  assert.equal(deliverableText("x".repeat(MAX_DELIVERED_CHARS)), "x".repeat(MAX_DELIVERED_CHARS));
});

test("the delivery cap is read from the settings at the moment of delivery", () => {
  const store = new SettingsStore({ maxDeliveredChars: 2500 });
  const manager = midTurnHarness(store);
  const limits = () => (manager as unknown as { limits: () => { maxDeliveredChars: number } }).limits();

  assert.equal(limits().maxDeliveredChars, 2500);
  store.update({ maxDeliveredChars: 9000 });
  assert.equal(limits().maxDeliveredChars, 9000, "a change applies without a restart or a turn boundary");
});

test("the delivery cap refuses values that would break the callers it exists for", () => {
  // The ceiling is a real platform limit, not taste: Codex and Copilot pass the prompt on argv,
  // and Windows stops at ~32,764 characters for the whole command line. A cap above that makes
  // the turn fail to START, which is worse than a message arriving cut.
  assert.equal(sanitizeAppSettings({ maxDeliveredChars: 30000 }).maxDeliveredChars, 30000);
  assert.equal(sanitizeAppSettings({ maxDeliveredChars: 30001 }).maxDeliveredChars, 12000);
  assert.equal(sanitizeAppSettings({ maxDeliveredChars: 1000 }).maxDeliveredChars, 1000);
  assert.equal(sanitizeAppSettings({ maxDeliveredChars: 999 }).maxDeliveredChars, 12000);
  assert.equal(sanitizeAppSettings({ maxDeliveredChars: 0 }).maxDeliveredChars, 12000, "0 is not 'no cap'");
});

test("every setting is filed under a section that actually exists", () => {
  // A section id with a typo in it is the new silent-failure mode: the page renders sections in
  // SETTING_SECTIONS order and skips ones with nothing in them, so a setting filed under
  // "collaberation" would simply never appear - saved, persisted, honoured by the server, and
  // invisible.
  const known = new Set(SETTING_SECTIONS.map((s) => s.id));
  for (const def of SETTING_DEFINITIONS) {
    assert.ok(known.has(def.section), `${def.key} is filed under unknown section "${def.section}"`);
  }

  // And the reverse: a declared section with no settings in it renders nothing, so it is dead
  // weight in the schema rather than a heading someone will see.
  for (const section of SETTING_SECTIONS) {
    assert.ok(
      SETTING_DEFINITIONS.some((d) => d.section === section.id),
      `section "${section.id}" has no settings in it`,
    );
  }

  // Ids are what settings point at; two sections sharing one would render the same rows twice.
  assert.equal(new Set(SETTING_SECTIONS.map((s) => s.id)).size, SETTING_SECTIONS.length);
});

test("a chain cut off announces itself, at every cap including the default", () => {
  // This is the bug that kept maxMentionChainDepth hardcoded. Depth reaches routeChatMessage in
  // steps of TWO (route(D) -> turn at D+1 -> its answer routes at D+2), so the depths actually
  // seen are 0, 2, 4, ... The old `depth === cap + 1` test therefore never matched at the
  // default cap of 6: the first over-cap call arrives at 8, and work stopped in total silence.
  assert.equal(announcesChainCutoff(8, 6), true, "the first over-cap hop at the default cap must speak");
  assert.equal(announcesChainCutoff(7, 6), true, "an odd depth over the cap speaks too");

  // Every cap a user can actually choose has at least one reachable depth that announces.
  for (let cap = 0; cap <= 20; cap++) {
    const firstOver = [...Array(26).keys()].map((n) => n * 2).find((d) => d > cap)!;
    assert.equal(announcesChainCutoff(firstOver, cap), true, `cap ${cap} cuts off silently at depth ${firstOver}`);
  }

  // Still at most once per chain: a depth well past the cap is cut off without repeating the
  // notice, so a runaway chain of turns is not replaced by a runaway chain of system messages.
  assert.equal(announcesChainCutoff(9, 6), false);
  assert.equal(announcesChainCutoff(40, 6), false);
  // At or under the cap nothing is cut off, so there is nothing to announce.
  assert.equal(announcesChainCutoff(6, 6), false);
  assert.equal(announcesChainCutoff(0, 6), false);
  assert.equal(announcesChainCutoff(0, 0), false, "a human message is depth 0 and is never a chain hop");
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

  // The two new numbers follow the same rules, including their own zero rule: 0 hops is legal
  // and means "agents never trigger each other", while the agent-question grace starts at 1
  // because a zero-minute grace would be an agent killing a turn the instant it asks anything -
  // which is exactly the livelock the grace exists to prevent, not a setting worth offering.
  assert.equal(sanitizeAppSettings({ maxMentionChainDepth: 0 }).maxMentionChainDepth, 0);
  assert.equal(sanitizeAppSettings({ maxMentionChainDepth: 20 }).maxMentionChainDepth, 20);
  assert.equal(sanitizeAppSettings({ maxMentionChainDepth: 21 }).maxMentionChainDepth, 6);
  assert.equal(sanitizeAppSettings({ maxMentionChainDepth: -1 }).maxMentionChainDepth, 6);
  assert.equal(sanitizeAppSettings({ agentQuestionGraceMinutes: 1 }).agentQuestionGraceMinutes, 1);
  assert.equal(sanitizeAppSettings({ agentQuestionGraceMinutes: 60 }).agentQuestionGraceMinutes, 60);
  assert.equal(sanitizeAppSettings({ agentQuestionGraceMinutes: 0 }).agentQuestionGraceMinutes, 4);
  assert.equal(sanitizeAppSettings({ agentQuestionGraceMinutes: 61 }).agentQuestionGraceMinutes, 4);
});

test("the new toggle refuses a non-boolean the same way the older ones do", () => {
  // Same rule as handoverOnUsageExhausted: a truthy-looking value is not believed, because a
  // setting that decides what gets written into a shared chat is not a place to guess.
  assert.equal(sanitizeAppSettings({ showAgentWorkInGroupChat: true }).showAgentWorkInGroupChat, true);
  assert.equal(sanitizeAppSettings({ showAgentWorkInGroupChat: false }).showAgentWorkInGroupChat, false);
  for (const bad of ["true", "on", 1, 0, null, [], {}]) {
    assert.equal(
      sanitizeAppSettings({ showAgentWorkInGroupChat: bad as unknown as boolean }).showAgentWorkInGroupChat,
      false,
      `${String(bad)} must not be believed as a boolean`,
    );
  }
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

test("the agent-question grace is read from the settings, not from the module constant", () => {
  // armInterruptTimer takes this from limits() at the moment it arms the timer, exactly as the
  // operator's grace already did. Asserted through limits() itself because the timer it feeds is
  // a setTimeout whose duration is not observable without waiting for it.
  const store = new SettingsStore({ agentQuestionGraceMinutes: 9 });
  const manager = midTurnHarness(store);
  const limits = () => (manager as unknown as { limits: () => { agentQuestionGraceMs: number } }).limits();

  assert.equal(limits().agentQuestionGraceMs, 9 * 60_000);
  store.update({ agentQuestionGraceMinutes: 2 });
  assert.equal(limits().agentQuestionGraceMs, 2 * 60_000, "a change applies without a restart or a turn boundary");
  // And the default really is the old constant, arrived at through the store rather than asserted
  // about DEFAULT_APP_SETTINGS a second time.
  assert.equal(new SettingsStore({}).get().agentQuestionGraceMinutes * 60_000, AGENT_QUESTION_GRACE_MS);
});

test("the chain-depth cap is read live, and cutting a chain off says so in the chat", () => {
  // The two halves that make this setting honest: the cap the user chose is the one enforced,
  // and enforcing it is visible. Driven through the real routeChatMessage rather than asserted
  // about announcesChainCutoff alone, because the notice being reachable in principle and the
  // notice actually being posted are different claims.
  const store = new SettingsStore({ maxMentionChainDepth: 2 });
  const bus = new ChatBus();
  const chats = new ChatStore();
  const chat = chats.createChat("One");
  const agents: AgentConfig[] = [
    { id: "a1", handle: "claude", provider: "claude-code", cwd: process.cwd(), trustLevel: "manual" },
    { id: "a2", handle: "codex", provider: "codex-cli", cwd: process.cwd(), trustLevel: "manual" },
  ];
  const manager = new AgentManager(bus, chats, agents, undefined, [], [], [], store);
  (manager as unknown as { drainQueue: (id: string) => Promise<void> }).drainQueue = async () => {};
  const route = (manager as unknown as {
    routeChatMessage: (
      chatId: string,
      authorId: string,
      authorHandle: string,
      text: string,
      opts: { broadcastIfUnmentioned: boolean; mentionChainDepth: number },
    ) => void;
  }).routeChatMessage.bind(manager);

  const systemLines = () =>
    bus
      .getHistoryFor({ chatId: chat.id })
      .filter((m) => m.authorId === "system")
      .map((m) => m.text);

  // Depth 2 is at the cap, so this hop is allowed and nothing is announced.
  route(chat.id, "a1", "claude", "@codex over to you", { broadcastIfUnmentioned: false, mentionChainDepth: 2 });
  assert.deepEqual(systemLines(), []);

  // Depth 4 is the next depth that actually occurs, and it is over the cap. Under the old
  // `=== cap + 1` test this would have been cut off in complete silence.
  route(chat.id, "a1", "claude", "@codex and again", { broadcastIfUnmentioned: false, mentionChainDepth: 4 });
  assert.equal(systemLines().length, 1, "the cut-off must be announced, not silent");
  assert.match(systemLines()[0], /after 2 hops/, "the notice quotes the configured cap, not the constant");

  // Raised on the live store: the very same hop now goes through, with no second notice.
  store.update({ maxMentionChainDepth: 6 });
  route(chat.id, "a1", "claude", "@codex once more", { broadcastIfUnmentioned: false, mentionChainDepth: 4 });
  assert.equal(systemLines().length, 1, "a cap captured at boot would still have refused this");

  // Zero is the "agents never trigger each other" end, and it explains itself in those words
  // rather than quoting a cap of zero hops.
  store.update({ maxMentionChainDepth: 0 });
  route(chat.id, "a1", "claude", "@codex hello", { broadcastIfUnmentioned: false, mentionChainDepth: 2 });
  assert.equal(systemLines().length, 2);
  assert.match(systemLines()[1], /not allowed to trigger each other/);
});

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

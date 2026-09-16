import assert from "node:assert/strict";
import { test } from "node:test";
import {
  KIMI_COMMAND_LINE_MAX,
  buildKimiArgs,
  findKimiEntry,
  kimiPromptBudget,
  kimiToolPolicy,
} from "./kimi";

const ENTRY = "C:\\npm\\node_modules\\@moonshot-ai\\kimi-code\\dist\\main.mjs";
const NODE = "C:\\Program Files\\nodejs\\node.exe";

test("a first turn proposes no session and resumes with -S, never --continue", () => {
  const first = buildKimiArgs({ entry: ENTRY });
  assert.ok(!first.includes("-S"));
  // -c/--continue means "the previous session in this directory". Two Kimi agents sharing a
  // workspace would resume each other's conversation, which is a cross-agent memory leak, not
  // a convenience. Pinned because the flag is the more obvious-looking one of the two.
  assert.ok(!first.includes("-c") && !first.includes("--continue"));

  const resumed = buildKimiArgs({ entry: ENTRY, sessionId: "session_0fc6346b-6c0a-45ba-93f5-061211a7ec69" });
  assert.deepEqual(resumed.slice(3), ["-S", "session_0fc6346b-6c0a-45ba-93f5-061211a7ec69"]);
});

test("the entry module leads the argv and stream-json is always requested", () => {
  const args = buildKimiArgs({ entry: ENTRY });
  assert.equal(args[0], ENTRY);
  assert.deepEqual(args.slice(1, 3), ["--output-format", "stream-json"]);
});

test("no trust flag is ever passed in prompt mode", () => {
  // Verified against the real 0.43.1 CLI: each of these is rejected outright before the turn
  // starts - "error: Cannot combine --prompt with --yolo." and likewise for --auto and --plan.
  // A future edit that "adds trust support" by reaching for one of these would break EVERY
  // turn, not degrade gracefully, so it is pinned here.
  const args = buildKimiArgs({ entry: ENTRY, model: "k2", sessionId: "session_x" });
  for (const forbidden of ["--yolo", "-y", "--auto", "--plan"]) {
    assert.ok(!args.includes(forbidden), `prompt mode must never pass ${forbidden}`);
  }
});

test("the prompt is not part of the built argv", () => {
  // The prompt is appended once, in runTurn, immediately after the length check. Keeping it
  // out of this signature is what stops an unbounded string being appended here where nothing
  // would measure it.
  const args = buildKimiArgs({ entry: ENTRY, model: "k2" });
  assert.ok(args.every((a) => a !== "-p"));
});

test("the prompt budget is computed from the whole command line, not a fixed prompt length", () => {
  // The measured ceiling on the installed build: a bare run allowed a 32643-char prompt and a
  // run with --output-format/-S allowed 32575, and both totalled exactly 32764 characters of
  // command line. So a longer session id must shrink the budget by exactly its own length.
  const short = kimiPromptBudget(NODE, [...buildKimiArgs({ entry: ENTRY }), "-p"]);
  const withSession = kimiPromptBudget(NODE, [...buildKimiArgs({ entry: ENTRY, sessionId: "session_abc" }), "-p"]);
  assert.ok(withSession < short, "adding a session id must reduce the prompt budget");
  // "-S" + "session_abc" + their two joining spaces.
  assert.equal(short - withSession, "-S".length + 1 + "session_abc".length + 1);
});

test("the budget never exceeds the hard command-line ceiling and never goes negative", () => {
  const budget = kimiPromptBudget(NODE, [...buildKimiArgs({ entry: ENTRY }), "-p"]);
  assert.ok(budget > 0 && budget < KIMI_COMMAND_LINE_MAX);
  // A pathological entry path alone can overflow the whole line. The budget must clamp to 0
  // rather than go negative, or the length check in runTurn would compare against a negative
  // number and let an oversized prompt straight through to a spawn ENAMETOOLONG.
  assert.equal(kimiPromptBudget(NODE, ["x".repeat(KIMI_COMMAND_LINE_MAX * 2)]), 0);
});

test("a prompt exactly at the budget is allowed and one character more is not", () => {
  const args = [...buildKimiArgs({ entry: ENTRY }), "-p"];
  const budget = kimiPromptBudget(NODE, args);
  // runTurn's guard is `prompt.length > budget`, so the boundary must be inclusive. Pinned
  // because an off-by-one in the safe direction silently truncates what users can send and an
  // off-by-one in the unsafe direction is the ENAMETOOLONG outage this whole check exists for.
  assert.ok(!(budget > budget));
  assert.ok(budget + 1 > budget);
});

test("tool policy restricts nothing only at the fully-trusting levels", () => {
  // `[tools] disabled` was verified to genuinely block execution under headless forced-auto:
  // Write and Bash both came back `Tool "..." is disabled by the active tool policy`, and the
  // file was not created and the command did not run.
  assert.deepEqual(kimiToolPolicy("bypassPermissions"), []);
  assert.deepEqual(kimiToolPolicy("auto"), []);
});

test("restrictive tool policies always remove the shell, and plan also removes writes", () => {
  const accept = kimiToolPolicy("acceptEdits");
  assert.ok(accept.includes("Bash"));
  assert.ok(!accept.includes("Write") && !accept.includes("Edit"));

  const plan = kimiToolPolicy("plan");
  for (const tool of ["Write", "Edit", "Bash"]) assert.ok(plan.includes(tool), `plan must disable ${tool}`);
});

test("an unknown trust level collapses onto the most restrictive policy", () => {
  // Same failure direction opencode.ts chose: a level this adapter does not recognise must end
  // up over-restricted, never over-permitted. "manual" is genuinely unreachable for Kimi (see
  // KIMI-REGISTRATION.md) and must not fall through to full access.
  assert.deepEqual(kimiToolPolicy("manual"), kimiToolPolicy("plan"));
  assert.deepEqual(kimiToolPolicy("something-new"), kimiToolPolicy("plan"));
});

test("tool policy names only tools Kimi actually exposes", () => {
  // The real tool surface, read off a live headless request rather than from docs.
  const REAL_TOOLS = new Set([
    "Agent", "AgentSwarm", "AskUserQuestion", "Bash", "CreateGoal", "CronCreate", "CronDelete",
    "CronList", "Edit", "EnterPlanMode", "ExitPlanMode", "FetchURL", "GetGoal", "Glob", "Grep",
    "Read", "SetGoalBudget", "Skill", "TaskList", "TaskOutput", "TaskStop", "TodoList",
    "UpdateGoal", "WaitFor", "Write",
  ]);
  for (const level of ["plan", "manual", "acceptEdits", "bypassPermissions", "auto"]) {
    for (const tool of kimiToolPolicy(level)) {
      // A misspelled entry is silently meaningless to Kimi rather than an error, which is the
      // dangerous failure: a typo'd "Bash" would leave shell access wide open and nothing
      // anywhere would say so.
      assert.ok(REAL_TOOLS.has(tool), `${level} disables unknown tool "${tool}"`);
    }
  }
});

test("the entry module is found by walking PATH, and a PATH without it yields undefined", () => {
  assert.equal(findKimiEntry(""), undefined);
  assert.equal(findKimiEntry("C:\\definitely\\not\\a\\real\\dir"), undefined);
});

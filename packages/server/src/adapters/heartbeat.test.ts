import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A stream line an adapter chooses not to report is still proof the CLI is alive.
 *
 * The bug this pins, in full: the stuck-turn watchdog in agentManager treats silence as evidence
 * a process has hung, and it is fed ONLY by adapter events (`noteActivity()` sits at the top of
 * `onEvent`). OpenCode emits `step_start` and then waits on the model - on a long resumed session
 * with a busy model that is routinely minutes. The adapter's `default:` branch dropped the line
 * with a comment saying "nothing to report", so the watchdog heard nothing, concluded the turn
 * was stuck, killed it at the five-minute idle limit, restarted it, and killed it again. The user
 * saw "turn stopped: no output for 5 minutes" on a turn that was working correctly the whole time.
 *
 * So: an adapter may decide a line is not worth SHOWING, but it may never decide it is not worth
 * MENTIONING.
 */

const ADAPTER_DIR = join(import.meta.dirname, ".");

/** Adapters that parse a streaming CLI and therefore have a line-dispatch switch. */
const STREAMING = ["opencode.ts", "copilot-cli.ts", "gemini-cli.ts", "kilo.ts"];

test("every streaming adapter emits a heartbeat rather than dropping an unrecognised line", () => {
  for (const file of STREAMING) {
    const src = readFileSync(join(ADAPTER_DIR, file), "utf8");
    // The `default:` that ends the stream-event switch must reach a heartbeat before its break.
    // Matched on the source rather than by running a CLI because the whole point is the branch
    // that produces NO observable output - there is nothing to assert on at runtime.
    const idx = src.lastIndexOf("default:");
    assert.notEqual(idx, -1, `${file} has no default branch`);
    const branch = src.slice(idx, src.indexOf("break;", idx));
    assert.match(
      branch,
      /onEvent\(\{ type: "heartbeat" \}\)/,
      `${file}'s stream switch drops an unrecognised line silently, which reads to the idle ` +
        `watchdog as a hung process`,
    );
  }
});

test("the heartbeat carries nothing, so it cannot be mistaken for the agent speaking", () => {
  const types = readFileSync(join(ADAPTER_DIR, "types.ts"), "utf8");
  assert.match(types, /\| \{ type: "heartbeat" \}/, "heartbeat must be payload-free");
});

test("agentManager returns immediately on a heartbeat", () => {
  // It must reset the idle timer and do nothing else - not post, not count as progress, not
  // promote to an answer. Pinned because the cost of it leaking into the transcript is an agent
  // appearing to say something it never said.
  const mgr = readFileSync(join(ADAPTER_DIR, "..", "core", "agentManager.ts"), "utf8");
  const at = mgr.indexOf('if (event.type === "heartbeat") return;');
  assert.notEqual(at, -1, "agentManager must short-circuit heartbeat");
  const noteAt = mgr.indexOf("noteActivity();", mgr.indexOf("onEvent: (event) =>"));
  assert.ok(noteAt !== -1 && noteAt < at, "noteActivity() must run BEFORE the heartbeat returns");
});

test("every adapter that streams is covered by this test", () => {
  // Guards the list above going stale: a new streaming adapter must be added here, or this
  // test stops protecting anything without anyone noticing.
  const streamingLike = readdirSync(ADAPTER_DIR).filter((f) => {
    if (!f.endsWith(".ts") || f.endsWith(".test.ts")) return false;
    const src = readFileSync(join(ADAPTER_DIR, f), "utf8");
    // The shape of a stream parser here: a readline interface over the child's stdout.
    return src.includes("readline.createInterface");
  });
  for (const f of streamingLike) {
    const src = readFileSync(join(ADAPTER_DIR, f), "utf8");
    // Only those whose line handler actually has a dispatch switch with a default.
    if (!src.includes("default:")) continue;
    assert.ok(
      STREAMING.includes(f) || !src.slice(src.lastIndexOf("default:")).includes("break;"),
      `${f} streams and has a default branch but is not in STREAMING - add it`,
    );
  }
});

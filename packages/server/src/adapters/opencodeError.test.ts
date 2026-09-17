import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A provider's own refusal must reach the user, not be counted as a heartbeat.
 *
 * What happened: OpenCode began refusing its free tier whenever an MCP server is attached, and
 * said so plainly in its stream —
 *
 *   {"type":"error","error":{"name":"APIError","data":{
 *      "message":"Error from provider (Console): OpenCode's free tier can only be used from
 *                 within OpenCode","statusCode":403}}}
 *
 * The adapter's switch had cases for `text` and `step_finish`, so this fell to `default`, which
 * emits a heartbeat — the liveness signal that tells the idle watchdog the process is fine. So a
 * turn the provider had flatly REFUSED was indistinguishable from a turn quietly working: no
 * error in the chat, no lastError on the agent, nothing in the server log. A four-agent run
 * produced a completely silent room and every layer above was behaving correctly on the
 * information it had.
 *
 * The heartbeat default is still right for genuinely unknown events. It is wrong for the one
 * event type whose entire purpose is to report failure.
 */
const SRC = readFileSync(join(import.meta.dirname, "opencode.ts"), "utf8").replace(/\r\n/g, "\n");

test("an error event is handled before the heartbeat default can swallow it", () => {
  const at = SRC.indexOf('case "error": {');
  assert.notEqual(at, -1, "the stream switch must handle the provider's error event");
  const defaultAt = SRC.lastIndexOf("default:");
  assert.ok(at < defaultAt, "the error case must precede the default that would swallow it");
});

test("the message shown is the provider's own words, plus its status code", () => {
  const at = SRC.indexOf('case "error": {');
  const body = SRC.slice(at, SRC.indexOf("break;", at));
  // Taken from the payload rather than written here - the whole value of this is that the user
  // reads what the provider actually said.
  assert.match(body, /err\?\.data\?\.message/);
  assert.match(body, /statusCode/);
  assert.match(body, /onEvent\(\{ type: "error"/);
  // And never silently blank: an error with no message still says that it was an error.
  assert.match(body, /no message/);
});

test("the heartbeat default is kept for genuinely unknown events", () => {
  // Removing it would reintroduce the other bug: a healthy but quiet turn killed by the idle
  // watchdog because the adapter reported nothing. See heartbeat.test.ts.
  assert.match(SRC.slice(SRC.lastIndexOf("default:")), /onEvent\(\{ type: "heartbeat" \}\)/);
});

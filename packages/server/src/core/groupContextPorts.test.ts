import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Agents must be told which ports belong to the chat app rather than to their own work.
 *
 * The bug this pins, observed live: an agent built a site, said it was live, and the user found
 * it was not. Asked about it, the agent went and inspected THIS APP's own dev server - which was
 * of course perfectly healthy - and reported back that everything was fine. It then handed the
 * user the app's own localhost as the address of their site. Nothing in the prompt had ever said
 * which localhost was which, so the agent had no way to tell the room from the job.
 *
 * Asserted against the source because the block is assembled from a live agent config, a chat id
 * and a coordination board; the failure mode being guarded is a sentence going missing, and the
 * cheapest honest guard for that is to check the sentence is there.
 */
const SRC = readFileSync(join(import.meta.dirname, "agentManager.ts"), "utf8").replace(/\r\n/g, "\n");

test("the group context names the app's own ports and forbids reporting them", () => {
  assert.match(SRC, /belong to the chat app you are talking through, not to your work/);
  assert.match(SRC, /never report either of them as the address of what YOU built/);
  // The specific wrong turn the agent took: checking the app's ports instead of its own.
  assert.match(SRC, /re-check YOUR port - do not/);
});

test("the API port comes from the one constant the listener also binds", () => {
  // Stronger than it used to be, and for a real reason. This used to assert the block computed
  // `process.env.PORT ?? 4310` for itself. That WAS the bug: the dev instance moved its listener
  // to 4320 and this copy went on saying 4310, so agents were told the wrong port was the app's
  // own - by the very sentence that exists to stop them confusing the app with their own work.
  // A port decided in two places is a port that will disagree, so there is now one constant.
  assert.match(SRC, /const solacePorts = String\(SERVER_PORT\);/);
  assert.match(SRC, /\$\{solacePorts\} is its API/);
  assert.ok(!/process\.env\.PORT\s*\?\?\s*\d{4}/.test(SRC), "must not recompute the port here");
});

test("the UI port is stated as the default rather than asserted as certain", () => {
  // The web dev server is a separate process this one never talks to, so its port genuinely
  // cannot be known from here. The comment must keep saying so, or someone will later "fix"
  // this by pretending it is known.
  const at = SRC.indexOf("const SOLACE_UI_PORT");
  assert.notEqual(at, -1);
  const preamble = SRC.slice(Math.max(0, at - 700), at);
  assert.match(preamble, /NOT knowable from here/);
});

test("agents are warned a server started in a turn may not outlive it", () => {
  // Why this matters: the turn's process tree is killed on stop/timeout, so a dev server started
  // inside a turn dies with it. The agent's "it's live" was true when written and false by the
  // time the user clicked - which reads to the user as the agent having lied.
  assert.match(SRC, /may not outlive that turn/);
});

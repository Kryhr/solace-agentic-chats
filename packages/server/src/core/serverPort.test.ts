import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The server's port must be decided in exactly one place.
 *
 * It used to be decided in eleven: index.ts bound `process.env.PORT ?? 4310`, and each of the ten
 * adapters independently recomputed the same expression to tell the MCP bridge where to call
 * back. That holds only while every copy agrees.
 *
 * It stopped agreeing. The dev instance moved its listener to 4320 so it could run beside the
 * stable one, and the adapters went on saying 4310 - so every agent's post_to_group called the
 * STABLE instance carrying a turn token the DEV instance had minted, and was correctly refused
 * with "no matching in-flight turn". Agents could not talk to each other mid-turn for an entire
 * session, and one resent its message because it could tell the first had never arrived.
 *
 * Worse, the same stale literal was in the group-context block, so agents were being TOLD the
 * wrong port was the app's own - the sentence that exists to stop them confusing the app with
 * their own work was itself wrong.
 */
const SERVER_SRC = join(import.meta.dirname, "..");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(p));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

test("nothing outside serverPort.ts computes the port for itself", () => {
  const offenders: string[] = [];
  for (const f of tsFiles(SERVER_SRC)) {
    if (f.endsWith(`core${require("node:path").sep}serverPort.ts`)) continue;
    const src = readFileSync(f, "utf8").replace(/\r\n/g, "\n");
    // A literal port default anywhere else is a copy that will diverge from the listener.
    if (/process\.env\.PORT\s*\?\?\s*\d{4}/.test(src)) offenders.push(f);
  }
  assert.deepEqual(
    offenders,
    [],
    `these recompute the port instead of importing SERVER_PORT, which is how post_to_group ` +
      `ended up calling a different instance:\n  ${offenders.join("\n  ")}`,
  );
});

test("the listener binds the same constant it hands to the bridge", () => {
  // If these two ever differ again, every agent's mid-turn posting breaks silently - the bridge
  // gets a clean HTTP refusal, not a crash, so nothing looks broken from the server's side.
  const index = readFileSync(join(SERVER_SRC, "index.ts"), "utf8").replace(/\r\n/g, "\n");
  assert.match(index, /const PORT = SERVER_PORT;/);
  assert.match(index, /import \{ SERVER_PORT \} from "\.\/core\/serverPort"/);
});

test("the port agents are told is the app's own comes from the same constant", () => {
  const mgr = readFileSync(join(SERVER_SRC, "core", "agentManager.ts"), "utf8").replace(/\r\n/g, "\n");
  assert.match(mgr, /const solacePorts = String\(SERVER_PORT\);/);
});

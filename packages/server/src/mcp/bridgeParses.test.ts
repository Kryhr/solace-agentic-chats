import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Every .mjs script a provider CLI spawns must actually parse.
 *
 * Nothing imported these, so nothing type-checked them and no test loaded them - they are handed
 * to a provider's CLI as a path and started as a separate process. A merge left solaceBridge.mjs
 * syntactically invalid and the whole suite stayed green: 855 tests passing while every agent in
 * the app was broken.
 *
 * The failure was silent in the worst way. A CLI spawns the bridge and waits for its MCP server
 * to come up; it never did, so turns STARTED - currentTask set, real CLI processes appearing -
 * and then produced nothing at all, not even hub output. A four-agent run sat at one message for
 * twenty minutes with no error logged anywhere, because from the server's point of view nothing
 * had failed. `node --check` would have caught it in under a second.
 */
const MCP_DIR = import.meta.dirname;

test("every bridge script a provider spawns is syntactically valid", () => {
  const scripts = readdirSync(MCP_DIR).filter((f) => f.endsWith(".mjs"));
  assert.ok(scripts.length > 0, "there should be at least one bridge script to check");
  for (const f of scripts) {
    assert.doesNotThrow(
      () => execFileSync(process.execPath, ["--check", join(MCP_DIR, f)], { stdio: "pipe" }),
      `${f} does not parse - a provider CLI would hang waiting for an MCP server that never starts`,
    );
  }
});

test("the solace bridge declares every tool it also handles, and vice versa", () => {
  // The other half of the same merge hazard: a tool can survive in the advertised list while its
  // handler is lost, so an agent calls something that silently does nothing.
  const src = readFileSync(join(MCP_DIR, "solaceBridge.mjs"), "utf8");
  const declared = new Set([...src.matchAll(/name: "([a-z_]+)"/g)].map((m) => m[1]));
  declared.delete("solace"); // the server's own name, not a tool
  const handled = new Set([...src.matchAll(/name === "([a-z_]+)"/g)].map((m) => m[1]));
  for (const t of declared) assert.ok(handled.has(t), `${t} is advertised but never handled`);
  for (const t of handled) assert.ok(declared.has(t), `${t} is handled but never advertised`);
  // The count is pinned so a tool lost in a future merge fails here rather than in a live turn.
  assert.equal(declared.size, 16, `expected 16 tools, found ${declared.size}: ${[...declared].join(", ")}`);
});

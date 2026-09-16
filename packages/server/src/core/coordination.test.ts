import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig } from "@solace/shared";
import { CoordinationBoard } from "./coordination";

function agent(id: string, handle: string): AgentConfig {
  return { id, handle, provider: "claude-code", cwd: process.cwd(), trustLevel: "manual" };
}

const CLAUDE = agent("a1", "claude");
const CODEX = agent("a2", "codex");
const COPILOT = agent("a3", "copilot");
const CHAT = "c1";

// ---------------------------------------------------------------------------------------
// File claims
// ---------------------------------------------------------------------------------------

test("a second agent cannot claim a file someone already owns", () => {
  const b = new CoordinationBoard();
  b.claim(CHAT, CLAUDE, ["linkcheck/checker.py"]);
  const { claimed, conflicts } = b.claim(CHAT, CODEX, ["linkcheck/checker.py"]);
  assert.deepEqual(claimed, []);
  assert.deepEqual(conflicts, [{ path: "linkcheck/checker.py", owner: "claude" }]);
});

test("a partial collision still claims everything that was free", () => {
  // Refusing the whole request over one overlap would leave an agent that asked for ten files
  // and collided on one owning nothing at all.
  const b = new CoordinationBoard();
  b.claim(CHAT, CLAUDE, ["checker.py"]);
  const { claimed, conflicts } = b.claim(CHAT, CODEX, ["checker.py", "cli.py", "report.py"]);
  assert.deepEqual(claimed, ["cli.py", "report.py"]);
  assert.equal(conflicts.length, 1);
});

test("claiming a directory owns the files inside it, including ones not created yet", () => {
  const b = new CoordinationBoard();
  b.claim(CHAT, CLAUDE, ["src/checker"]);
  assert.deepEqual(b.conflictsFor(CHAT, CODEX.id, ["src/checker/core.py"]), [
    { path: "src/checker/core.py", owner: "claude" },
  ]);
  // A sibling directory with a shared prefix is NOT covered - the "site2" trap.
  assert.deepEqual(b.conflictsFor(CHAT, CODEX.id, ["src/checker2/core.py"]), []);
});

test("path comparison is Windows-first: separators and case do not create a second file", () => {
  const b = new CoordinationBoard();
  b.claim(CHAT, CLAUDE, ["Linkcheck\\Checker.py"]);
  assert.equal(b.conflictsFor(CHAT, CODEX.id, ["linkcheck/checker.py"]).length, 1);
});

test("an agent re-claiming its own paths is never a conflict", () => {
  const b = new CoordinationBoard();
  b.claim(CHAT, CLAUDE, ["checker.py"]);
  const { conflicts } = b.claim(CHAT, CLAUDE, ["checker.py", "extra.py"]);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(b.forChat(CHAT).claims[0].paths, ["checker.py", "extra.py"]);
});

test("releasing frees the lane for someone else", () => {
  const b = new CoordinationBoard();
  b.claim(CHAT, CLAUDE, ["checker.py", "helpers.py"]);
  b.release(CHAT, CLAUDE.id, ["checker.py"]);
  assert.deepEqual(b.claim(CHAT, CODEX, ["checker.py"]).claimed, ["checker.py"]);
  assert.equal(b.conflictsFor(CHAT, CODEX.id, ["helpers.py"]).length, 1, "the unreleased one is still owned");
});

test("deleting an agent releases everything it held", () => {
  // Otherwise its claims outlive it and block the remaining agents with no way to release them.
  const b = new CoordinationBoard();
  b.claim(CHAT, CLAUDE, ["checker.py"]);
  b.blockOn(CHAT, CLAUDE, "agent", "codex");
  b.forgetAgent(CLAUDE.id);
  assert.deepEqual(b.forChat(CHAT).claims, []);
  assert.deepEqual(b.forChat(CHAT).blocks, []);
});

// ---------------------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------------------

test("re-posting a contract replaces it rather than stacking two versions", () => {
  const b = new CoordinationBoard();
  b.postContract(CHAT, CLAUDE, "checker API", "v1");
  b.postContract(CHAT, CLAUDE, "Checker API", "v2");
  const contracts = b.forChat(CHAT).contracts;
  assert.equal(contracts.length, 1, "matched case-insensitively on title");
  assert.equal(contracts[0].body, "v2");
});

test("two agents can hold contracts with the same title", () => {
  // They are different decisions about different lanes; collapsing them would lose one.
  const b = new CoordinationBoard();
  b.postContract(CHAT, CLAUDE, "API", "checker side");
  b.postContract(CHAT, CODEX, "API", "cli side");
  assert.equal(b.forChat(CHAT).contracts.length, 2);
});

// ---------------------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------------------

test("a contract block wakes when a matching contract is posted", () => {
  // The live failure: codex said it was blocked until the checker contract landed, then sat
  // idle after it landed because nobody named it.
  const b = new CoordinationBoard();
  b.blockOn(CHAT, CODEX, "contract", "checker", "need the signature");
  const woken = b.resolve(CHAT, { kind: "contract", title: "checker API", by: "claude" }, process.cwd());
  assert.equal(woken.length, 1);
  assert.equal(woken[0].block.agentId, CODEX.id);
  assert.match(woken[0].because, /claude posted the contract/);
  assert.deepEqual(b.forChat(CHAT).blocks, [], "cleared, so one event cannot wake it twice");
});

test("an unrelated contract does not wake a blocked agent", () => {
  const b = new CoordinationBoard();
  b.blockOn(CHAT, CODEX, "contract", "checker");
  assert.deepEqual(b.resolve(CHAT, { kind: "contract", title: "CSS tokens", by: "claude" }, process.cwd()), []);
  assert.equal(b.forChat(CHAT).blocks.length, 1, "still waiting");
});

test("an agent's own contract never wakes itself", () => {
  const b = new CoordinationBoard();
  b.blockOn(CHAT, CLAUDE, "contract", "checker");
  assert.deepEqual(b.resolve(CHAT, { kind: "contract", title: "checker API", by: "claude" }, process.cwd()), []);
});

test("an agent block wakes when that specific agent posts", () => {
  const b = new CoordinationBoard();
  b.blockOn(CHAT, COPILOT, "agent", "@claude");
  assert.deepEqual(b.resolve(CHAT, { kind: "posted", by: "codex" }, process.cwd()), [], "wrong agent");
  const woken = b.resolve(CHAT, { kind: "posted", by: "claude" }, process.cwd());
  assert.equal(woken.length, 1, "the @ prefix is optional and case-insensitive");
});

test("a file block wakes only once the file actually exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "solace-coord-"));
  const b = new CoordinationBoard();
  b.blockOn(CHAT, COPILOT, "file", "checker.py");
  assert.deepEqual(b.resolve(CHAT, { kind: "files" }, dir), [], "not there yet");
  writeFileSync(join(dir, "checker.py"), "x");
  const woken = b.resolve(CHAT, { kind: "files" }, dir);
  assert.equal(woken.length, 1);
  assert.match(woken[0].because, /checker\.py now exists/);
});

test("one block per agent - a new one replaces the old", () => {
  const b = new CoordinationBoard();
  b.blockOn(CHAT, CODEX, "contract", "checker");
  b.blockOn(CHAT, CODEX, "agent", "claude");
  const blocks = b.forChat(CHAT).blocks;
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "agent");
});

// ---------------------------------------------------------------------------------------
// Announcements and isolation
// ---------------------------------------------------------------------------------------

test("an announcement is shown once, not re-pasted every turn", () => {
  const b = new CoordinationBoard();
  const all = [
    { createdAt: "2026-01-01T00:00:00.000Z", text: "one" },
    { createdAt: "2026-01-01T00:01:00.000Z", text: "two" },
  ];
  assert.equal(b.unseenAnnouncements(CHAT, CLAUDE.id, all).length, 2, "nothing seen yet");
  b.markAnnouncementsSeen(CHAT, CLAUDE.id, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(b.unseenAnnouncements(CHAT, CLAUDE.id, all).map((a) => a.text), ["two"]);
  assert.equal(b.unseenAnnouncements(CHAT, CODEX.id, all).length, 2, "watermarks are per agent");
});

test("two chats keep separate boards", () => {
  // Two chats about the same folder are two separate pieces of work; inheriting one's claims
  // into the other would be wrong in both directions.
  const b = new CoordinationBoard();
  b.claim("chat-a", CLAUDE, ["checker.py"]);
  assert.deepEqual(b.claim("chat-b", CODEX, ["checker.py"]).claimed, ["checker.py"]);
});

test("a board round-trips through persistence, and empty chats are not stored", () => {
  const b = new CoordinationBoard();
  b.claim(CHAT, CLAUDE, ["checker.py"]);
  b.forChat("untouched");
  const snap = b.snapshot();
  assert.deepEqual(Object.keys(snap), [CHAT]);

  const restored = new CoordinationBoard(snap);
  assert.equal(restored.conflictsFor(CHAT, CODEX.id, ["checker.py"]).length, 1);
});

test("a state file written before coordination existed restores as empty, not undefined", () => {
  const restored = new CoordinationBoard(undefined as unknown as Record<string, never>);
  assert.deepEqual(restored.forChat(CHAT).claims, []);
  assert.deepEqual(restored.snapshot(), {});
});

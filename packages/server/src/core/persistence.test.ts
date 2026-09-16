import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { atomicWriteFileSync, loadState, saveState } from "./persistence";

function scratch(): string {
  const dir = join(tmpdir(), `solace-persist-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("atomicWriteFileSync replaces the target and leaves no temp file behind", () => {
  const dir = scratch();
  try {
    const path = join(dir, "f.json");
    writeFileSync(path, "OLD");
    atomicWriteFileSync(path, "NEW", { encoding: "utf-8" });
    assert.equal(readFileSync(path, "utf-8"), "NEW");
    // The temp sibling must be gone (renamed away), so a directory scan never turns up litter.
    assert.deepEqual(
      readdirSync(dir).filter((n) => n.startsWith("f.json.tmp")),
      [],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveState never leaves a partially-written file that loadState would treat as empty", () => {
  const dir = scratch();
  try {
    // A real save with data worth losing.
    saveState(dir, {
      agents: [{ id: "a1", handle: "Keep", provider: "claude-code", cwd: dir, trustLevel: "manual" } as never],
      history: [{ id: "m1", channel: { chatId: "c1" }, authorId: "u", authorHandle: "you", mentions: [], text: "important", createdAt: "2020-01-01T00:00:00.000Z" } as never],
      archives: [],
      queues: [],
      sessions: [],
      rateLimits: [],
      chats: [{ id: "c1", title: "Work", createdAt: "2020-01-01T00:00:00.000Z" }],
      projects: [],
      settings: {} as never,
      coordination: {},
      mcpServers: [],
      connectedCliProviders: [],
    });

    // Simulate a crash landing DURING the next save: the temp file is half-written and the
    // rename never happens. The live file must still be the previous, whole file.
    const statePath = join(dir, ".solace-state.json");
    const wholeBefore = readFileSync(statePath, "utf-8");
    writeFileSync(`${statePath}.tmp-crashed`, wholeBefore.slice(0, Math.floor(wholeBefore.length / 2)));

    const loaded = loadState(dir);
    assert.equal(loaded.agents.length, 1, "agents survived a crashed concurrent write");
    assert.equal(loaded.agents[0]?.handle, "Keep");
    assert.equal(loaded.history.length, 1, "history survived");
    // A stray temp file must not be mistaken for state.
    assert.ok(existsSync(statePath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

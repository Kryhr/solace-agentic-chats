import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig, Task } from "@solace/shared";
import { effectiveStatus } from "@solace/shared";
import { TASK_BLOCK_MAX_CHARS, TaskBoard, buildTaskContextBlock } from "./taskBoard";

/**
 * Four incidents, measured across 28 real chats, and one hard platform limit.
 *
 *  - two agents built the same landing page twice, because "announce what you're taking" was
 *    a request in the prompt rather than a piece of state anything checked
 *  - an agent sat idle AFTER the thing it was waiting for had landed, because the agent that
 *    landed it did not think to name them
 *  - an agent asked "what products did you come up with?" after the answer had been posted
 *  - every Codex and Copilot turn died with `spawn ENAMETOOLONG` from an over-large context
 *    block: Windows caps a command line at ~32,764 characters and those two CLIs take the
 *    whole prompt on argv
 *
 * Each one is a test below.
 */

function agent(id: string, handle: string): AgentConfig {
  return { id, handle, provider: "claude-code", cwd: process.cwd(), trustLevel: "manual" };
}

const CLAUDE = agent("a1", "claude");
const CODEX = agent("a2", "codex");
const CHAT = "c1";

function boardWith(...titles: string[]): { board: TaskBoard; ids: string[] } {
  const board = new TaskBoard();
  const ids = titles.map((title) => {
    const r = board.create(CHAT, "operator", { title });
    assert.ok(r.ok);
    return r.task.id;
  });
  return { board, ids };
}

// ---------------------------------------------------------------------------------------
// A task cannot be claimed twice
// ---------------------------------------------------------------------------------------

test("a task cannot be claimed twice - the duplicate-landing-page failure, as state", () => {
  // Observed live: "@claude @Claude2 work together to think of a landing page idea" produced
  // no exchange at all. Both went straight to building, both said "I've got the landing page
  // live and verified", and the rest of the session was spent reconciling two builds of one
  // page and fighting over a port. Nothing in the system could have refused the second one,
  // because nothing had recorded the first.
  const { board, ids } = boardWith("landing page");
  const first = board.claim(CHAT, CLAUDE, ids[0]);
  assert.ok(first.ok);

  const second = board.claim(CHAT, CODEX, ids[0]);
  assert.equal(second.ok, false);
  assert.ok(!second.ok && second.error.includes("@claude"), "must name WHO owns it, not just refuse");
  // And the refusal must not have quietly moved ownership anyway.
  assert.equal(board.find(CHAT, ids[0])?.ownerHandle, "claude");
});

test("re-claiming your own task is not a conflict, and does not reset when you took it", () => {
  const { board, ids } = boardWith("landing page");
  const first = board.claim(CHAT, CLAUDE, ids[0]);
  assert.ok(first.ok && first.task.claimedAt);
  const again = board.claim(CHAT, CLAUDE, ids[0]);
  assert.ok(again.ok);
  assert.equal(again.task.claimedAt, first.ok ? first.task.claimedAt : undefined);
});

test("a finished task cannot be claimed, and says who did it", () => {
  // The "what products did you come up with?" case: the answer already existed, and asking
  // again was the only way to find that out. Now the board says so before anyone asks.
  const { board, ids } = boardWith("product list");
  board.claim(CHAT, CLAUDE, ids[0]);
  board.finish(CHAT, CLAUDE, ids[0], "six names, posted");
  const late = board.claim(CHAT, CODEX, ids[0]);
  assert.equal(late.ok, false);
  assert.ok(!late.ok && /already finished/.test(late.error));
  assert.ok(!late.ok && late.error.includes("@claude"));
  assert.equal(board.find(CHAT, ids[0])?.result, "six names, posted");
});

test("ids are never reused, so an id said out loud in the chat keeps meaning one thing", () => {
  const { board, ids } = boardWith("one", "two");
  board.claim(CHAT, CLAUDE, ids[1]);
  board.finish(CHAT, CLAUDE, ids[1]);
  const third = board.create(CHAT, "operator", { title: "three" });
  assert.ok(third.ok);
  assert.equal(third.task.id, "T3");
});

// ---------------------------------------------------------------------------------------
// A dependent task does not start early
// ---------------------------------------------------------------------------------------

test("a task whose dependency is unfinished is claimed but NOT started", () => {
  const board = new TaskBoard();
  const api = board.create(CHAT, "operator", { title: "API shape" });
  assert.ok(api.ok);
  const ui = board.create(CHAT, "operator", { title: "build the UI", dependsOn: [api.task.id] });
  assert.ok(ui.ok);

  const claimed = board.claim(CHAT, CODEX, ui.task.id);
  assert.ok(claimed.ok, "ownership is taken, so nobody else starts it meanwhile");
  assert.deepEqual(
    claimed.ok ? claimed.waitingOn.map((t) => t.id) : [],
    [api.task.id],
    "and the caller is handed the dependency, which is what it turns into a block",
  );
  assert.equal(effectiveStatus(claimed.ok ? claimed.task : ui.task, board.forChat(CHAT)), "blocked");
});

test('"blocked" is derived, never stored - the whole point of state over labels', () => {
  const board = new TaskBoard();
  const api = board.create(CHAT, "operator", { title: "API shape" });
  assert.ok(api.ok);
  const ui = board.create(CHAT, "operator", { title: "build the UI", dependsOn: [api.task.id] });
  assert.ok(ui.ok);
  board.claim(CHAT, CODEX, ui.task.id);
  board.claim(CHAT, CLAUDE, api.task.id);

  assert.equal(effectiveStatus(ui.task, board.forChat(CHAT)), "blocked");
  board.finish(CHAT, CLAUDE, api.task.id);
  // Nothing wrote to the dependent task. Its status changed because the world did, which is
  // exactly what /task's free-text string could never do.
  assert.equal(effectiveStatus(ui.task, board.forChat(CHAT)), "claimed");
});

test("an unclaimed task with unmet dependencies reads as open, not blocked", () => {
  // "Blocked" is only interesting once somebody is actually waiting to start. Reading it the
  // other way fills the context block with unowned tasks described alarmingly.
  const board = new TaskBoard();
  const a = board.create(CHAT, "operator", { title: "first" });
  assert.ok(a.ok);
  const b = board.create(CHAT, "operator", { title: "second", dependsOn: [a.task.id] });
  assert.ok(b.ok);
  assert.equal(effectiveStatus(b.task, board.forChat(CHAT)), "open");
});

test("a dependency id that matches no task is reported, not silently dropped", () => {
  // Dropping it would turn a typo into a task that looks ready to start.
  const board = new TaskBoard();
  const t = board.create(CHAT, "operator", { title: "build", dependsOn: ["T9"] });
  assert.ok(t.ok);
  assert.deepEqual(t.unknownDeps, ["T9"]);
  assert.deepEqual(t.task.dependsOn, ["T9"], "and it is kept - it says what the author believed");
  // It cannot block, because there is nothing to wait for.
  const claimed = board.claim(CHAT, CODEX, t.task.id);
  assert.ok(claimed.ok && claimed.waitingOn.length === 0);
});

test('"t1" and "T1" are one dependency, not two', () => {
  const board = new TaskBoard();
  const a = board.create(CHAT, "operator", { title: "first" });
  assert.ok(a.ok);
  const b = board.create(CHAT, "operator", { title: "second", dependsOn: ["t1", "T1"] });
  assert.ok(b.ok);
  assert.deepEqual(b.task.dependsOn, ["T1"]);
});

// ---------------------------------------------------------------------------------------
// Finishing a task wakes its dependents
// ---------------------------------------------------------------------------------------

test("finishing a task names exactly the dependents that can now start", () => {
  // The live failure: an agent sat idle after the thing it waited for landed, because whoever
  // landed it did not think to name them. Nobody has to think of it here.
  const board = new TaskBoard();
  const api = board.create(CHAT, "operator", { title: "API shape" });
  assert.ok(api.ok);
  const ui = board.create(CHAT, "operator", { title: "UI", dependsOn: [api.task.id] });
  const docs = board.create(CHAT, "operator", { title: "docs", dependsOn: [api.task.id] });
  assert.ok(ui.ok && docs.ok);
  board.claim(CHAT, CODEX, ui.task.id);
  board.claim(CHAT, CLAUDE, api.task.id);
  // docs is deliberately left unclaimed.

  const done = board.finish(CHAT, CLAUDE, api.task.id);
  assert.ok(done.ok);
  assert.deepEqual(
    done.unblocked.map((t) => t.id),
    [ui.task.id],
    "an unclaimed dependent has nobody to wake - waking nobody is not an event",
  );
  assert.equal(done.unblocked[0].ownerHandle, "codex");
});

test("a task with two dependencies is not woken until BOTH are done", () => {
  const board = new TaskBoard();
  const a = board.create(CHAT, "operator", { title: "a" });
  const b = board.create(CHAT, "operator", { title: "b" });
  assert.ok(a.ok && b.ok);
  const c = board.create(CHAT, "operator", { title: "c", dependsOn: [a.task.id, b.task.id] });
  assert.ok(c.ok);
  board.claim(CHAT, CODEX, c.task.id);

  const first = board.finish(CHAT, CLAUDE, a.task.id);
  assert.ok(first.ok);
  assert.deepEqual(first.unblocked, [], "still waiting on the second");
  const second = board.finish(CHAT, CLAUDE, b.task.id);
  assert.ok(second.ok);
  assert.deepEqual(
    second.unblocked.map((t) => t.id),
    [c.task.id],
  );
});

test("the wake reuses the existing block machinery rather than a second scheduler", () => {
  // Asserted against the source: this needs a live agent, a live turn and a provider process to
  // exercise end to end, and the thing being guarded is that the ONE place wake-ups happen
  // stays the one place. A parallel task scheduler is a second thing that can forget to wake
  // somebody, and the one that forgets is the one that matters.
  const manager = readFileSync(join(import.meta.dirname, "agentManager.ts"), "utf8").replace(/\r\n/g, "\n");
  assert.match(manager, /this\.board\.blockOn\(ctx\.chatId, ctx\.runtime\.config, "task", waitFor\.id/);
  assert.match(manager, /const woken = this\.wake\(ctx\.chatId, \{\s*kind: "task",/);
  const coordination = readFileSync(join(import.meta.dirname, "coordination.ts"), "utf8").replace(/\r\n/g, "\n");
  assert.match(coordination, /block\.kind === "task" && event\.kind === "task"/);
  // Exact id match, not the fuzzy contains-match a contract title gets: "T1" must not be woken
  // by "T12" finishing.
  assert.match(coordination, /block\.value\.trim\(\)\.toLowerCase\(\) === event\.taskId\.toLowerCase\(\)/);
});

test("a deleted agent's claimed tasks go back on the board", () => {
  const { board, ids } = boardWith("landing page");
  board.claim(CHAT, CLAUDE, ids[0]);
  board.forgetAgent(CLAUDE.id);
  const task = board.find(CHAT, ids[0])!;
  assert.equal(task.status, "open");
  assert.equal(task.ownerHandle, undefined);
});

test("a deleted agent's FINISHED tasks keep their owner - the board is also a record", () => {
  const { board, ids } = boardWith("landing page");
  board.claim(CHAT, CLAUDE, ids[0]);
  board.finish(CHAT, CLAUDE, ids[0]);
  board.forgetAgent(CLAUDE.id);
  assert.equal(board.find(CHAT, ids[0])?.ownerHandle, "claude");
});

// ---------------------------------------------------------------------------------------
// The context block stays small
// ---------------------------------------------------------------------------------------

function manyTasks(n: number): Task[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `T${i + 1}`,
    // A realistically wordy title, because the failure mode is a board of long titles, not a
    // board of the word "task".
    title: `rebuild the ${i + 1}th section of the marketing site with the agreed apothecary palette and copy`,
    status: i % 2 === 0 ? ("claimed" as const) : ("open" as const),
    ownerId: i % 2 === 0 ? "a2" : undefined,
    ownerHandle: i % 2 === 0 ? "codex" : undefined,
    dependsOn: i > 0 ? [`T${i}`] : [],
    files: [`src/sections/section-${i + 1}.tsx`, `src/sections/section-${i + 1}.css`],
    createdBy: "operator",
    createdAt: new Date(0).toISOString(),
  }));
}

test("the injected context block stays small with a board of 60 open tasks", () => {
  // Codex and Copilot pass the whole prompt on argv; Windows caps a command line at ~32,764
  // characters. This repo has already had EVERY Codex and Copilot turn die with spawn
  // ENAMETOOLONG from an over-large context block - the skills catalogue, which is now a
  // pointer to a file for exactly this reason. A board grows with the work, so it is the next
  // thing that would do it. A pointer plus one line per task, never a dump.
  const block = buildTaskContextBlock(manyTasks(60), "a1");
  assert.ok(block.length < TASK_BLOCK_MAX_CHARS + 400, `block was ${block.length} chars`);
  // A dump of all 60 would be several thousand characters; this must be a small fraction.
  assert.ok(block.length < 2000);
  assert.match(block, /\+\d+ more/, "and it must SAY that it is truncated, not pretend it is the whole board");
  assert.match(block, /list_tasks/, "with the pointer to where the rest actually is");
});

test("one line per task: no task contributes a paragraph", () => {
  const block = buildTaskContextBlock(manyTasks(60), "a1");
  assert.ok(!block.includes("\n"), "the block is one run of text - a newline here is a dump starting");
  // Files are NOT in the block. They are what makes a task line long, and they are one
  // list_tasks call away.
  assert.ok(!block.includes("src/sections/section-1.tsx"));
});

test("the agent's own tasks survive truncation; other agents' busywork is what gets cut", () => {
  const tasks = manyTasks(60);
  tasks[57].ownerId = "a1";
  tasks[57].ownerHandle = "claude";
  const block = buildTaskContextBlock(tasks, "a1");
  assert.match(block, /T58 yours/, "the one task that changes what this agent does next must be in there");
});

test("an empty board costs nothing at all", () => {
  // A chat that never uses tasks must pay no prompt tax for the feature existing - the same
  // rule the coordination block already follows.
  assert.equal(buildTaskContextBlock([], "a1"), "");
  const board = new TaskBoard();
  board.create(CHAT, "operator", { title: "done already" });
  board.finish(CHAT, CLAUDE, "T1");
  assert.equal(board.contextBlock(CHAT, CLAUDE), "", "and a board with nothing OPEN is an empty board");
});

test("the block says who owns what, which is the thing prose kept losing", () => {
  const board = new TaskBoard();
  board.create(CHAT, "operator", { title: "landing page" });
  board.create(CHAT, "operator", { title: "pricing page" });
  board.claim(CHAT, CODEX, "T1");
  const block = board.contextBlock(CHAT, CLAUDE);
  assert.match(block, /T1 @codex: landing page/);
  assert.match(block, /T2 unclaimed: pricing page/);
  assert.match(block, /claim_task/, "and it must name the call, or it is a report rather than an affordance");
});

test("a blocked line names what it is waiting for", () => {
  const board = new TaskBoard();
  board.create(CHAT, "operator", { title: "API" });
  board.create(CHAT, "operator", { title: "UI", dependsOn: ["T1"] });
  board.claim(CHAT, CODEX, "T2");
  assert.match(board.contextBlock(CHAT, CLAUDE), /T2 @codex waiting on T1: UI/);
});

// ---------------------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------------------

test("tasks survive a restart, and a hand-edited entry cannot crash the load", () => {
  const board = new TaskBoard();
  board.create(CHAT, "operator", { title: "landing page", files: ["src/index.html"] });
  board.claim(CHAT, CLAUDE, "T1");
  const restored = new TaskBoard(JSON.parse(JSON.stringify(board.snapshot())));
  assert.equal(restored.find(CHAT, "T1")?.ownerHandle, "claude");
  assert.deepEqual(restored.find(CHAT, "T1")?.files, ["src/index.html"]);

  // Whatever is on disk, loadState's catch-all reads a throw as "everything is gone" - so
  // nothing here may throw.
  const junk = new TaskBoard({ [CHAT]: [{ nope: true }, null, { id: "T7", title: "ok" }] as unknown as Task[] });
  assert.equal(junk.forChat(CHAT).length, 1);
  assert.equal(junk.find(CHAT, "T7")?.status, "open");
});

test("two chats do not share a board", () => {
  const board = new TaskBoard();
  board.create("chat-a", "operator", { title: "a thing" });
  assert.equal(board.forChat("chat-b").length, 0);
  // And ids restart per chat, because they are quoted per chat.
  const b = board.create("chat-b", "operator", { title: "another thing" });
  assert.ok(b.ok && b.task.id === "T1");
});

test("a chat with no tasks is absent from the snapshot, not stored empty", () => {
  const board = new TaskBoard();
  board.forChat("untouched");
  assert.deepEqual(board.snapshot(), {});
});

// ---------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------

test("claiming a task claims its files, and finishing it releases them", () => {
  // The join between the two boards. "I'll take the landing page" said in prose stopped
  // nobody; a claim the others see in their context does.
  const manager = readFileSync(join(import.meta.dirname, "agentManager.ts"), "utf8").replace(/\r\n/g, "\n");
  assert.match(manager, /this\.board\.claim\(ctx\.chatId, ctx\.runtime\.config, result\.task\.files/);
  assert.match(manager, /this\.board\.release\(ctx\.chatId, ctx\.runtime\.config\.id, done\.task\.files\)/);
});

test("the task block is injected into the group prompt, before the coordination block", () => {
  const manager = readFileSync(join(import.meta.dirname, "agentManager.ts"), "utf8").replace(/\r\n/g, "\n");
  assert.match(manager, /const taskBoard = this\.tasks\.contextBlock\(chatId, self\)/);
  assert.match(manager, /\$\{roster\}\$\{taskBoard\}\$\{coordination\}/);
});

test("every task tool is turn-token authenticated and piggy-backs the inbound notice", () => {
  // Both halves of the bridge contract. A route that skipped `inbound` would silently drop
  // messages that arrived for this agent while it was working - the server has already taken
  // them off its queue by then, so they would be lost outright.
  const index = readFileSync(join(import.meta.dirname, "..", "index.ts"), "utf8").replace(/\r\n/g, "\n");
  for (const route of ["create", "claim", "finish", "list"]) {
    const at = index.indexOf(`"/internal/solace/task/${route}"`);
    assert.ok(at > 0, `route ${route} must exist`);
    const body = index.slice(at, at + 1400);
    assert.match(body, /takeInboundNotice\(req\.body\.agentId, req\.body\.turnToken\)/, `${route} must carry inbound`);
    assert.match(body, /reply\.code\(/, `${route} must refuse a turn that is no longer in flight`);
  }
  // The manager side verifies the token for all four, through the one helper that resolves the
  // chat - so a claim and a post from one turn can never land on different boards.
  const manager = readFileSync(join(import.meta.dirname, "agentManager.ts"), "utf8").replace(/\r\n/g, "\n");
  for (const method of ["createTask", "claimTask", "finishTask", "listTasks"]) {
    const at = manager.indexOf(`  ${method}(agentId: string, token: unknown`);
    assert.ok(at > 0, `${method} must exist`);
    assert.match(manager.slice(at, at + 260), /this\.coordinationContext\(agentId, token\)/);
  }
});

test("the bridge exposes all four tools", () => {
  const bridge = readFileSync(join(import.meta.dirname, "..", "mcp", "solaceBridge.mjs"), "utf8").replace(/\r\n/g, "\n");
  for (const tool of ["list_tasks", "create_task", "claim_task", "finish_task"]) {
    assert.match(bridge, new RegExp(`name: "${tool}"`), `${tool} must be listed`);
    assert.match(bridge, new RegExp(`name === "${tool}"`), `${tool} must be handled`);
  }
  // Every one of them must return through withInbound, for the reason above.
  //
  // Scoped to each task handler individually rather than counting withInbound across a slice of
  // the file. The slice version asserted "exactly 6" and broke the moment a sibling branch added
  // four unrelated tools between these and get_secret - a test that fails because somebody else
  // did something correct elsewhere is measuring the wrong thing.
  for (const tool of ["list_tasks", "create_task", "claim_task", "finish_task"]) {
    const at = bridge.indexOf(`if (name === "${tool}")`);
    assert.notEqual(at, -1, `${tool} must be handled`);
    // Up to the start of the next handler, whichever tool that turns out to be.
    const rest = bridge.slice(at + 10);
    const nextAt = rest.indexOf('if (name === "');
    const handler = nextAt === -1 ? rest : rest.slice(0, nextAt);
    assert.match(handler, /withInbound\(/, `${tool}'s success path must return through withInbound`);
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentConfig } from "@solace/shared";
import { AgentManager } from "./agentManager";
import { ChatBus } from "./chatBus";
import { ChatStore } from "./chatStore";
import { SettingsStore } from "./settingsStore";

/** A ChatStore with agents pinned to their own folder - the rule that applied before agents
 * followed the user between projects, and still exactly what turning the setting off restores. */
function pinnedStore(...args: ConstructorParameters<typeof ChatStore>) {
  return new ChatStore(args[0], args[1], new SettingsStore({ agentsFollowProjects: false }));
}

/**
 * Routing rules, per chat. These assert who a message REACHES, which used to be "everyone in
 * the one group chat" and is now "everyone this chat reaches".
 *
 * No provider turn is ever started here: drainQueue is replaced on the instance before anything
 * is routed, so an enqueued turn stays in the queue where it can be inspected instead of
 * spawning a real CLI and spending the user's tokens to run a unit test.
 */
function harness(agents: AgentConfig[], chats: ChatStore) {
  const bus = new ChatBus();
  const manager = new AgentManager(bus, chats, agents);
  (manager as unknown as { drainQueue: (id: string) => Promise<void> }).drainQueue = async () => {};
  return { bus, manager };
}

/** Which agents were actually given a turn, by handle. */
function turnedFor(manager: AgentManager, agents: AgentConfig[]): string[] {
  const byId = new Map(agents.map((a) => [a.id, a.handle]));
  return manager
    .getPersistableQueues()
    .filter((q) => q.queued.length > 0)
    .map((q) => byId.get(q.agentId)!)
    .sort();
}

function agent(id: string, handle: string, cwd: string): AgentConfig {
  return { id, handle, provider: "claude-code", cwd, trustLevel: "manual" };
}

const HERE = process.cwd();

test("an unmentioned message in an unfiled chat reaches every agent", () => {
  const chats = new ChatStore();
  const c = chats.createChat("Everything");
  const agents = [agent("a1", "claude", HERE), agent("a2", "codex", "C:\\elsewhere")];
  const { manager, bus } = harness(agents, chats);

  manager.submitMessage(c.id, "user", "you", "what do you both think?");

  assert.deepEqual(turnedFor(manager, agents), ["claude", "codex"]);
  assert.deepEqual(bus.getHistoryFor({ chatId: c.id }).map((m) => m.text), ["what do you both think?"]);
});

test("with agents pinned to a folder, a project chat reaches only the agents in that folder", () => {
  const store = pinnedStore([], [{ id: "p1", name: "site", path: HERE, createdAt: "2025-01-01T00:00:00.000Z" }]);
  const c = store.createChat("Site", "p1");
  const agents = [agent("a1", "claude", HERE), agent("a2", "codex", "C:\\somewhere\\else")];
  const { manager } = harness(agents, store);

  manager.submitMessage(c.id, "user", "you", "ship the landing page");

  assert.deepEqual(turnedFor(manager, agents), ["claude"], "codex works in a different directory");
});

test("by default agents follow the user, so a new project's chat reaches the whole roster", () => {
  // The bug this exists for: a project folder is new, so no agent's cwd is inside it, so under
  // the old rule the chat filed under it reached NOBODY and every agent had to be re-added.
  const store = new ChatStore([], [{ id: "p1", name: "site", path: HERE, createdAt: "2025-01-01T00:00:00.000Z" }]);
  const c = store.createChat("Site", "p1");
  const agents = [agent("a1", "claude", "C:\\somewhere\\else"), agent("a2", "codex", "C:\\another\\place")];
  const { manager } = harness(agents, store);

  manager.submitMessage(c.id, "user", "you", "ship the landing page");

  assert.deepEqual(turnedFor(manager, agents), ["claude", "codex"]);
});

test("an agent removed from a project is the only one that project's chat skips", () => {
  const store = new ChatStore([], [{ id: "p1", name: "site", path: HERE, createdAt: "2025-01-01T00:00:00.000Z" }]);
  const c = store.createChat("Site", "p1");
  const agents = [agent("a1", "claude", HERE), agent("a2", "codex", HERE)];
  const { manager } = harness(agents, store);

  assert.equal(store.setProjectMembership("p1", "a2", false), true);
  manager.submitMessage(c.id, "user", "you", "ship the landing page");

  assert.deepEqual(turnedFor(manager, agents), ["claude"]);
});

test("a following agent runs in the project's folder, but is back in its own outside a project", () => {
  const store = new ChatStore([], [{ id: "p1", name: "site", path: HERE, createdAt: "2025-01-01T00:00:00.000Z" }]);
  const c = store.createChat("Site", "p1");
  const codex = agent("a2", "codex", "C:\\somewhere\\else");

  // This is what keeps one project's provider session out of another project's directory.
  assert.equal(store.workingDirectoryFor(codex, c.id), HERE);
  assert.equal(store.workingDirectoryFor(codex, undefined), "C:\\somewhere\\else");
});

test("@mentioning an agent the chat cannot reach summons nobody, and says so", () => {
  // Two wrong answers were available here. Resolving the handle against the whole roster hands
  // the work to an agent whose cwd is somebody else's project. Dropping the mention silently
  // makes it an unaddressed message, which then broadcasts - so "@codex do this" would be
  // answered by everyone EXCEPT codex.
  const store = pinnedStore([], [{ id: "p1", name: "site", path: HERE, createdAt: "2025-01-01T00:00:00.000Z" }]);
  const c = store.createChat("Site", "p1");
  const agents = [agent("a1", "claude", HERE), agent("a2", "codex", "C:\\somewhere\\else")];
  const { manager, bus } = harness(agents, store);

  manager.submitMessage(c.id, "user", "you", "@codex take this one");

  assert.deepEqual(turnedFor(manager, agents), []);
  const posted = bus.getHistoryFor({ chatId: c.id });
  assert.equal(posted[0].mentions.length, 0, "the handle is not treated as a reachable mention");
  assert.equal(posted[1].authorId, "system");
  assert.match(posted[1].text, /@codex is not in "Site"/);
});

test("two chats route independently, and each message stays in its own channel", () => {
  const chats = new ChatStore();
  const one = chats.createChat("One");
  const two = chats.createChat("Two");
  const agents = [agent("a1", "claude", HERE)];
  const { manager, bus } = harness(agents, chats);

  manager.submitMessage(one.id, "user", "you", "first");
  manager.submitMessage(two.id, "user", "you", "second");

  assert.deepEqual(bus.getHistoryFor({ chatId: one.id }).map((m) => m.text), ["first"]);
  assert.deepEqual(bus.getHistoryFor({ chatId: two.id }).map((m) => m.text), ["second"]);
  const queued = manager.getPersistableQueues()[0].queued;
  assert.deepEqual(
    queued.map((t) => t.replyChannel),
    [{ chatId: one.id }, { chatId: two.id }],
    "each turn replies into the chat it came from",
  );
});

test("an @mention in one chat reaches the mentioned agent and nobody else", () => {
  const chats = new ChatStore();
  const c = chats.createChat("Everything");
  const agents = [agent("a1", "claude", HERE), agent("a2", "codex", HERE)];
  const { manager } = harness(agents, chats);

  manager.submitMessage(c.id, "user", "you", "@codex can you look?");

  assert.deepEqual(turnedFor(manager, agents), ["codex"]);
});

test("a message into a chat that no longer exists posts nothing and summons nobody", () => {
  // A chat can be archived while a turn is still in flight; its final answer must not be
  // written into a room nothing can open.
  const chats = new ChatStore();
  const c = chats.createChat("Doomed");
  const agents = [agent("a1", "claude", HERE)];
  const { manager, bus } = harness(agents, chats);
  chats.removeChat(c.id);

  manager.submitMessage(c.id, "user", "you", "still there?");

  assert.deepEqual(bus.getHistory(), []);
  assert.deepEqual(turnedFor(manager, agents), []);
});

test("an agent's mid-turn post_to_group goes to the chat whose turn it is running", () => {
  const chats = new ChatStore();
  const one = chats.createChat("One");
  chats.createChat("Two");
  const agents = [agent("a1", "claude", HERE), agent("a2", "codex", HERE)];
  const { manager, bus } = harness(agents, chats);

  // Put a turn in flight for a1, bound for chat "one", and mint it a turn token the same way
  // drainQueue does - this is the only state postFromCurrentTurn trusts.
  const runtime = (manager as unknown as { agents: Map<string, Record<string, unknown>> }).agents.get("a1")!;
  runtime.currentTurn = {
    id: "t1",
    prompt: "p",
    replyChannel: { chatId: one.id },
    mentionChainDepth: 0,
    kind: "work",
    receivedAt: new Date().toISOString(),
  };
  runtime.activeTurnToken = "tok";

  const result = manager.postFromCurrentTurn("a1", "tok", "@codex starting on the header", "question");

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(
    bus.getHistoryFor({ chatId: one.id }).map((m) => m.text),
    ["@codex starting on the header"],
  );
  assert.deepEqual(turnedFor(manager, agents), ["codex"], "and the mention still triggers a real turn");
});

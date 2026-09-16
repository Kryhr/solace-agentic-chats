import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentConfig, ChatMeta, ProjectMeta } from "@solace/shared";
import { SettingsStore } from "./settingsStore";
import { ChatStore, agentInProject } from "./chatStore";

function project(id: string, name: string, path: string): ProjectMeta {
  return { id, name, path, createdAt: "2025-01-01T00:00:00.000Z" };
}

function chat(id: string, title: string, projectId?: string): ChatMeta {
  return { id, title, createdAt: "2025-01-01T00:00:00.000Z", projectId };
}

function agent(id: string, handle: string, cwd: string): AgentConfig {
  return { id, handle, provider: "claude-code", cwd, trustLevel: "manual" };
}

test("agentInProject compares paths the way Windows actually hands them over", () => {
  assert.equal(agentInProject("C:\\ws\\site", "C:/ws/site"), true, "separator style must not matter");
  assert.equal(agentInProject("c:\\WS\\Site", "C:\\ws\\site"), true, "nor case");
  assert.equal(agentInProject("C:\\ws\\site\\packages\\web", "C:\\ws\\site"), true, "a subfolder is in the project");
  assert.equal(agentInProject("C:\\ws\\site2", "C:\\ws\\site"), false, "the prefix trap: site2 is not in site");
  assert.equal(agentInProject("C:\\ws\\other", "C:\\ws\\site"), false);
});

test("a chat is created, renamed and removed, and a rename survives in place", () => {
  const store = new ChatStore();
  const created = store.createChat("Site redesign");
  assert.equal(created.title, "Site redesign");
  assert.deepEqual(store.listChats().map((c) => c.id), [created.id]);

  assert.equal(store.updateChat(created.id, { title: "  Landing page  " }), true);
  assert.equal(store.getChat(created.id)?.title, "Landing page", "titles are trimmed");

  // An empty title would leave a blank, unclickable row in the sidebar.
  store.updateChat(created.id, { title: "   " });
  assert.equal(store.getChat(created.id)?.title, "Landing page");

  assert.equal(store.updateChat("nope", { title: "x" }), false, "an unknown id is reported, not silently accepted");

  assert.equal(store.removeChat(created.id)?.id, created.id);
  assert.deepEqual(store.listChats(), []);
  assert.equal(store.removeChat(created.id), undefined);
});

test("a chat created with no title still has one", () => {
  const store = new ChatStore();
  assert.equal(store.createChat().title, "New chat");
  assert.equal(store.createChat("   ").title, "New chat");
});

test("a chat cannot be filed under a project that does not exist", () => {
  const store = new ChatStore([], [project("p1", "site", "C:\\ws\\site")]);
  assert.equal(store.createChat("a", "ghost").projectId, undefined);
  const real = store.createChat("b", "p1");
  assert.equal(real.projectId, "p1");
  store.updateChat(real.id, { projectId: "ghost" });
  assert.equal(store.getChat(real.id)?.projectId, undefined);
});

test("unlinking a project unfiles its chats and never reports touching the folder", () => {
  const p = project("p1", "site", "C:\\ws\\site");
  const store = new ChatStore([chat("c1", "in project", "p1"), chat("c2", "unfiled")], [p]);

  const removed = store.unlinkProject("p1");

  assert.equal(removed?.path, "C:\\ws\\site", "the caller is told which folder is being left alone");
  assert.deepEqual(store.listProjects(), []);
  assert.equal(store.getChat("c1")?.projectId, undefined, "its chats survive, unfiled");
  assert.equal(store.getChat("c2")?.projectId, undefined);
  assert.equal(store.listChats().length, 2, "and none of them is deleted with the project");
});

test("an unfiled chat reaches every agent; a pinned project chat reaches only that project's agents", () => {
  const p = project("p1", "site", process.cwd()); // a directory that really exists
  const store = new ChatStore(
    [chat("c1", "filed", "p1"), chat("c2", "unfiled")],
    [p],
    new SettingsStore({ agentsFollowProjects: false }),
  );
  const inside = agent("a1", "claude", process.cwd());
  const outside = agent("a2", "codex", "C:\\somewhere\\else");

  assert.deepEqual(
    store.agentsForChat("c1", [inside, outside]).map((a) => a.id),
    ["a1"],
  );
  assert.deepEqual(
    store.agentsForChat("c2", [inside, outside]).map((a) => a.id),
    ["a1", "a2"],
  );
});

test("by default a project chat reaches every agent, wherever each one's own folder is", () => {
  const p = project("p1", "site", process.cwd());
  const store = new ChatStore([chat("c1", "filed", "p1")], [p]);
  const inside = agent("a1", "claude", process.cwd());
  const outside = agent("a2", "codex", "C:" + String.fromCharCode(92) + "somewhere");

  assert.deepEqual(store.agentsForChat("c1", [inside, outside]).map((a) => a.id), ["a1", "a2"]);
  // ...and the outside agent genuinely runs in the project folder, not its own.
  assert.equal(store.workingDirectoryFor(outside, "c1"), process.cwd());
});

test("removing an agent from a project drops it from that project's chats only", () => {
  const p = project("p1", "site", process.cwd());
  const store = new ChatStore([chat("c1", "filed", "p1"), chat("c2", "unfiled")], [p]);
  const a1 = agent("a1", "claude", process.cwd());
  const a2 = agent("a2", "codex", process.cwd());

  store.setProjectMembership("p1", "a2", false);
  assert.deepEqual(store.agentsForChat("c1", [a1, a2]).map((a) => a.id), ["a1"]);
  assert.deepEqual(store.agentsForChat("c2", [a1, a2]).map((a) => a.id), ["a1", "a2"], "unfiled is unaffected");
  // An excluded agent is not quietly relocated either: it stays in its own folder.
  assert.equal(store.workingDirectoryFor(a2, "c1"), a2.cwd);

  store.setProjectMembership("p1", "a2", true);
  assert.deepEqual(store.agentsForChat("c1", [a1, a2]).map((a) => a.id), ["a1", "a2"], "and it comes back");
});

test("a project whose folder has gone missing falls back to everyone rather than nobody", () => {
  // Silently routing to nobody is indistinguishable from every agent ignoring the user.
  const p = project("p1", "gone", "C:\\this\\does\\not\\exist\\at\\all");
  const store = new ChatStore([chat("c1", "filed", "p1")], [p]);
  const a = agent("a1", "claude", "C:\\ws\\site");
  assert.deepEqual(
    store.agentsForChat("c1", [a]).map((x) => x.id),
    ["a1"],
  );
});

test("a hub turn's post_to_group lands in the agent's own project's chat, deterministically", () => {
  const p = project("p1", "site", process.cwd());
  const store = new ChatStore([chat("c0", "unfiled"), chat("c1", "site chat", "p1")], [p]);
  assert.equal(store.defaultChatIdFor(agent("a1", "claude", process.cwd())), "c1");
  assert.equal(store.defaultChatIdFor(agent("a2", "codex", "C:\\elsewhere")), "c0", "otherwise the oldest chat");
  assert.equal(new ChatStore().defaultChatIdFor(undefined), undefined, "with no chats there is nowhere to post");
});

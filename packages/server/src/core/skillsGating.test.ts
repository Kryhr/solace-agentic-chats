import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentConfig } from "@solace/shared";
import { AgentManager, sessionKey } from "./agentManager";
import { ChatBus } from "./chatBus";
import { ChatStore } from "./chatStore";

/** The catalogue is ~3.3k tokens and buildGroupPrompt runs for EVERY group message an agent
 * receives, so sending it every time would charge that on each message for the whole run. */
function harness() {
  const agents: AgentConfig[] = [
    { id: "a1", handle: "claude", provider: "claude-code", cwd: process.cwd(), trustLevel: "manual" },
    { id: "a2", handle: "codex", provider: "codex-cli", cwd: process.cwd(), trustLevel: "manual" },
  ];
  const chats = new ChatStore();
  const manager = new AgentManager(new ChatBus(), chats, agents);
  (manager as unknown as { drainQueue: (id: string) => Promise<void> }).drainQueue = async () => {};
  const chat = chats.createChat("Build");
  const build = (forAgent: string) =>
    (manager as unknown as { buildGroupPrompt: (c: string, f: string, t: string, a: string) => string }).buildGroupPrompt(
      chat.id,
      "you",
      "build the landing page",
      forAgent,
    );
  const runtimeOf = (id: string) =>
    (manager as unknown as { agents: Map<string, { sessions: Map<string, string> }> }).agents.get(id)!;
  return { manager, chat, build, runtimeOf };
}

test("the catalogue is sent on the first turn of a session", () => {
  const h = harness();
  const prompt = h.build("a1");
  assert.match(prompt, /skills available to you/);
  assert.match(prompt, /SKILL\.md/);
});

test("and NOT again once the agent has a session for that folder", () => {
  const h = harness();
  assert.match(h.build("a1"), /skills available to you/);
  // Exactly what a real first turn does: the provider reports its session id.
  h.runtimeOf("a1").sessions.set(sessionKey(process.cwd()), "sess-1");
  assert.doesNotMatch(h.build("a1"), /skills available to you/);
});

test("each agent is told independently", () => {
  const h = harness();
  h.runtimeOf("a1").sessions.set(sessionKey(process.cwd()), "sess-1");
  assert.doesNotMatch(h.build("a1"), /skills available to you/);
  assert.match(h.build("a2"), /skills available to you/, "codex has not been told yet");
});

test("forgetting the session means the next turn is told again", () => {
  // /reset exists so an agent starts genuinely cold; it must not start cold AND uninformed.
  const h = harness();
  h.runtimeOf("a1").sessions.set(sessionKey(process.cwd()), "sess-1");
  assert.doesNotMatch(h.build("a1"), /skills available to you/);
  h.manager.resetSession("a1");
  assert.match(h.build("a1"), /skills available to you/);
});

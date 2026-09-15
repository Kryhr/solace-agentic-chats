import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage, ServerEvent } from "@solace/shared";
import { ChatBus } from "./chatBus";

function message(id: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    channel: { agentId: "a1" },
    authorId: "a1",
    authorHandle: "claude",
    mentions: [],
    text: `text ${id}`,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * updateMessage exists for exactly one job: promoting a turn's last "progress" message to
 * "answer" once the turn has genuinely ended. These cover the properties that job depends on -
 * it edits in place, it tells clients, and it refuses to resurrect a message that is gone.
 */

test("updateMessage promotes a message in place without moving it", () => {
  const bus = new ChatBus();
  bus.postMessage(message("m1", { agentKind: "progress" }));
  bus.postMessage(message("m2", { agentKind: "progress" }));
  bus.postMessage(message("m3", { agentKind: "tool" }));

  const updated = bus.updateMessage("m2", { agentKind: "answer" });

  assert.equal(updated?.agentKind, "answer");
  assert.deepEqual(
    bus.getHistory().map((m) => [m.id, m.agentKind]),
    [
      ["m1", "progress"],
      ["m2", "answer"],
      ["m3", "tool"],
    ],
    "promotion must not reorder the transcript",
  );
  assert.equal(bus.getHistory()[1].text, "text m2", "the agent's own words are untouched");
});

test("updateMessage emits the whole updated message so clients keyed by id just replace it", () => {
  const bus = new ChatBus();
  const seen: ServerEvent[] = [];
  bus.subscribe((e) => seen.push(e));
  bus.postMessage(message("m1", { agentKind: "progress" }));
  bus.updateMessage("m1", { agentKind: "answer" });

  const last = seen[seen.length - 1];
  assert.equal(last.type, "chat:message:updated");
  assert.equal(last.type === "chat:message:updated" && last.payload.id, "m1");
  assert.equal(last.type === "chat:message:updated" && last.payload.agentKind, "answer");
});

test("updateMessage no-ops when the channel was cleared while the turn was in flight", () => {
  const bus = new ChatBus();
  bus.postMessage(message("m1", { agentKind: "progress" }));
  bus.clearChannel({ agentId: "a1" });

  const seen: ServerEvent[] = [];
  bus.subscribe((e) => seen.push(e));

  assert.equal(bus.updateMessage("m1", { agentKind: "answer" }), undefined);
  assert.equal(bus.getHistory().length, 0, "a late promotion must not resurrect an archived message");
  assert.equal(seen.length, 0, "and must not emit anything for a message no client has");
});

test("updateMessage persists, so a promotion survives a restart", () => {
  const bus = new ChatBus();
  let changes = 0;
  bus.onChange = () => {
    changes += 1;
  };
  bus.postMessage(message("m1", { agentKind: "progress" }));
  const afterPost = changes;
  bus.updateMessage("m1", { agentKind: "answer" });
  assert.equal(changes, afterPost + 1);
});

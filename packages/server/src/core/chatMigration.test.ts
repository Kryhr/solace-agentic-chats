import { test } from "node:test";
import assert from "node:assert/strict";
import { LEGACY_CHAT_ID } from "@solace/shared";
import { migrateChatChannels } from "./persistence";

/**
 * The upgrade this file guards: before chats existed there was exactly one room, addressed by
 * the literal channel string "group". If that migration is wrong, every message the user has
 * ever sent becomes unreachable - so it is tested directly against a fixture of the old shape
 * rather than inferred from the server happening to boot.
 */

/** A state file exactly as it was written before chats existed: no `chats` key at all, and
 * every group channel stored as the bare string. */
function preChatsState() {
  return {
    history: [
      { id: "m1", channel: "group", authorId: "user", authorHandle: "you", mentions: [], text: "hello", createdAt: "2025-01-01T00:00:00.000Z" },
      { id: "m2", channel: { agentId: "a1" }, authorId: "a1", authorHandle: "claude", mentions: [], text: "hub line", createdAt: "2025-01-01T00:01:00.000Z" },
      { id: "m3", channel: "group", authorId: "a1", authorHandle: "claude", mentions: [], text: "answer", createdAt: "2025-01-01T00:02:00.000Z" },
    ],
    archives: [
      {
        id: "arch1",
        channel: "group",
        clearedAt: "2024-12-01T00:00:00.000Z",
        channelLabel: "Group chat",
        messages: [
          { id: "old1", channel: "group", authorId: "user", authorHandle: "you", mentions: [], text: "archived", createdAt: "2024-11-30T00:00:00.000Z" },
        ],
      },
    ],
    queues: [
      {
        agentId: "a1",
        inFlight: { id: "t1", prompt: "p", replyChannel: "group", mentionChainDepth: 0, kind: "work", receivedAt: "2025-01-01T00:03:00.000Z" },
        queued: [{ id: "t2", prompt: "q", replyChannel: { agentId: "a1" }, mentionChainDepth: 0, kind: "work", receivedAt: "2025-01-01T00:04:00.000Z" }],
      },
    ],
  };
}

test("a state file written before chats existed keeps every message, in one chat", () => {
  const { history, chats } = migrateChatChannels(preChatsState());

  assert.deepEqual(
    chats.map((c) => [c.id, c.title]),
    [[LEGACY_CHAT_ID, "Group chat"]],
    "the one room that existed becomes one chat, named for what it was",
  );
  assert.equal(history.length, 3, "no message is dropped");
  assert.deepEqual(history[0].channel, { chatId: LEGACY_CHAT_ID });
  assert.deepEqual(history[2].channel, { chatId: LEGACY_CHAT_ID });
  assert.deepEqual(history[1].channel, { agentId: "a1" }, "an agent hub channel is left exactly as it was");
  assert.deepEqual(
    history.map((m) => m.text),
    ["hello", "hub line", "answer"],
    "and nothing is reordered or rewritten",
  );
});

test("archives and the transcripts inside them migrate too", () => {
  const { archives } = migrateChatChannels(preChatsState());
  assert.deepEqual(archives[0].channel, { chatId: LEGACY_CHAT_ID });
  assert.deepEqual(archives[0].messages[0].channel, { chatId: LEGACY_CHAT_ID });
  assert.equal(archives[0].channelLabel, "Group chat", "the label captured at archive time survives");
});

test("a turn still queued for the group chat comes back pointed at the migrated chat", () => {
  const { queues } = migrateChatChannels(preChatsState());
  assert.deepEqual(queues[0].inFlight?.replyChannel, { chatId: LEGACY_CHAT_ID });
  assert.deepEqual(queues[0].queued[0].replyChannel, { agentId: "a1" }, "a hub-bound turn is untouched");
});

test("migration is idempotent - running it on its own output changes nothing", () => {
  const once = migrateChatChannels(preChatsState());
  const twice = migrateChatChannels(once);
  assert.deepEqual(twice, once);
  assert.equal(twice.chats.length, 1, "and cannot produce a second copy of the legacy chat");
});

test("an already-migrated file with no legacy chat left is not given one back", () => {
  // The user archived the old group chat and made their own. Re-adding "Group chat" on every
  // boot would resurrect a room they deliberately got rid of.
  const migrated = migrateChatChannels({
    chats: [{ id: "abc", title: "Site redesign", createdAt: "2025-02-01T00:00:00.000Z" }],
    history: [{ id: "m1", channel: { chatId: "abc" }, authorId: "user", authorHandle: "you", mentions: [], text: "hi", createdAt: "2025-02-01T00:00:01.000Z" }],
  });
  assert.deepEqual(
    migrated.chats.map((c) => c.id),
    ["abc"],
  );
});

test("an empty pre-chats state file still yields the one chat it implicitly had", () => {
  // Nothing to carry over, but the user still expects a room to type into on restart.
  const migrated = migrateChatChannels({});
  assert.deepEqual(
    migrated.chats.map((c) => c.id),
    [LEGACY_CHAT_ID],
  );
  assert.deepEqual(migrated.history, []);
});

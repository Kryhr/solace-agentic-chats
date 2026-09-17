import type { ChatMessage } from "@solace/shared";

/**
 * The message classes the routing work introduces - question · handoff · finding · status · ack -
 * as the GROUP stream presents them.
 *
 * WHERE THE CLASS COMES FROM, checked against the classifier as it actually landed on master
 * (core/turnIntent.ts) rather than assumed:
 *
 *   - The five names are confirmed. `turnIntent.MessageClass` is exactly
 *     `"question" | "handoff" | "finding" | "status" | "ack"`, so nothing here is guessing at
 *     spelling.
 *   - The class is NOT currently carried on a group message. `routeChatMessage` classifies
 *     every agent message, routes by the class, and then posts the group copy with
 *     `agentKind: "answer"` - the class itself is dropped on the floor at the last step. A
 *     status line is the one that survives, because it is posted with `agentKind: "status"`.
 *
 * So today this lights up the status path (folding) and nothing else, and the ONE change needed
 * on the routing side to light up the rest is to carry the class onto the ChatMessage it posts.
 * Both plausible homes are read here, in order: a dedicated `messageClass` field if one is added
 * (the honest place, since agentKind answers a different question - what kind of LINE this is,
 * not what kind of MESSAGE), then `agentKind` if the class is folded into that union instead.
 *
 * Both are read through a widened cast rather than by importing the type, because the shared
 * union lives in packages/shared/src/index.ts, which several branches are editing at once. This
 * file deliberately owns no shared-type change.
 *
 * If neither field ever carries a class, every function here returns undefined and the group
 * renders exactly as it does today: unstyled, in order, with the text intact. Nothing is ever
 * hidden on a guess. The one deliberate exception is `ack` - see `isHiddenInGroup`.
 */
export type MessageClass = "question" | "handoff" | "finding" | "status" | "ack";

const CLASSES = new Set<string>(["question", "handoff", "finding", "status", "ack"]);

export function messageClassOf(message: ChatMessage): MessageClass | undefined {
  const carrier = message as ChatMessage & { messageClass?: string };
  const candidate = carrier.messageClass ?? (message.agentKind as string | undefined);
  return candidate && CLASSES.has(candidate) ? (candidate as MessageClass) : undefined;
}

/**
 * The chip a class earns in the group stream.
 *
 * Colour only where the message needs somebody to DO something. A question is waiting on an
 * answer and a handoff means work has changed hands - both are things a reader is meant to act
 * on, so they get the accent and the warn roles. A finding is worth reading but is not a demand,
 * so it is labelled and left neutral. Spending a colour on everything would leave the stream
 * with five competing highlights and no hierarchy at all, which is the same as none.
 */
const CHIPS: Record<MessageClass, { label: string; tone: "accent" | "warn" | "neutral" } | null> = {
  question: { label: "Question", tone: "accent" },
  handoff: { label: "Handoff", tone: "warn" },
  finding: { label: "Finding", tone: "neutral" },
  // Status never appears as an individual row - it is folded into the collapsed run below - so
  // it has no chip of its own to render.
  status: null,
  ack: null,
};

export function chipFor(cls: MessageClass | undefined) {
  return cls ? CHIPS[cls] : null;
}

/**
 * Acknowledgements are never shown in the group. Not collapsed, not faded - not rendered.
 *
 * Seventeen of one session's 530 messages were an agent saying it had read something and was
 * aligned. They are real, they are kept in full in that agent's own hub, and they are of no use
 * whatsoever to anybody reading the room. This is the only place in the app that drops a message
 * from a view, which is why it is one named function with one caller rather than a condition
 * buried in a render loop.
 */
export function isHiddenInGroup(message: ChatMessage): boolean {
  return messageClassOf(message) === "ack";
}

/**
 * When a group message is only the HEAD of a longer answer, what was cut and where the rest is.
 *
 * The reply budget (agentManager.GROUP_REPLY_BUDGET_CHARS, 600) caps an unaddressed final answer
 * for the room and records `fullTextInHub: { chars, turnId }` on the message - and only when
 * something was actually cut, so absent means "this is the whole message" rather than "we did
 * not check". That distinction is the reason this is read rather than recomputed: comparing the
 * text length against 600 here would put a "full detail in hub" link on any message that merely
 * happened to be long, including ones that were never truncated at all.
 *
 * Read through a widened cast for the same reason as the class above: the field lives on
 * ChatMessage in packages/shared, which several branches are editing at once, and this file owns
 * no shared-type change. Absent field, or a malformed one, means no link - never a link pointing
 * at a turn that might not exist.
 */
export function fullTextInHubOf(message: ChatMessage): { chars: number; turnId?: string } | undefined {
  const carrier = message as ChatMessage & { fullTextInHub?: { chars?: unknown; turnId?: unknown } };
  const cut = carrier.fullTextInHub;
  if (!cut || typeof cut.chars !== "number" || !Number.isFinite(cut.chars)) return undefined;
  return { chars: cut.chars, turnId: typeof cut.turnId === "string" ? cut.turnId : undefined };
}

export type GroupStreamItem =
  | { kind: "message"; message: ChatMessage }
  /** A run of consecutive status messages, shown as one collapsed row until opened. */
  | { kind: "status-run"; id: string; messages: ChatMessage[] };

/**
 * The group transcript: acks removed, consecutive status lines folded into one row.
 *
 * Status is not noise in the sense that it is worthless - "verified: all routes 200" is a real
 * fact - it is noise in the sense that nineteen of them arrived in a room that had not asked,
 * at the same visual weight as the messages people were writing to each other. Folded, the run
 * costs one line and stays one click from its full contents.
 *
 * A run is broken by any other message, so a status line that genuinely answers something sits
 * next to what it answers rather than being swept into a pile further up.
 */
export function buildGroupStream(messages: ChatMessage[]): GroupStreamItem[] {
  const items: GroupStreamItem[] = [];
  for (const message of messages) {
    if (isHiddenInGroup(message)) continue;
    if (messageClassOf(message) === "status") {
      const last = items[items.length - 1];
      if (last?.kind === "status-run") {
        last.messages.push(message);
        continue;
      }
      // Keyed off the first line in the run, so a run the reader has opened stays open while
      // later status lines are appended to it.
      items.push({ kind: "status-run", id: message.id, messages: [message] });
      continue;
    }
    items.push({ kind: "message", message });
  }
  return items;
}

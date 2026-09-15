import type { ChatMessage } from "@solace/shared";

/**
 * How a transcript line should be rendered.
 *
 * ChatPanel and AgentHubPage each carried a private copy of these two predicates and had
 * already drifted apart (the hub checked them in the opposite order and skipped the
 * error-line check on system rows), so a change to what counts as tool output had to be
 * made twice and was easy to get half-right. One definition, imported by both.
 *
 * Both tests are deliberately literal string checks on the wrapper the server emits.
 * There is no classifier here and there must not be one: reasoning output is posted by
 * the server as plain, unmarked text, so any regex that tried to spot it client-side
 * would be guessing, and would eventually hide a real answer.
 */

const TOOL_USE_PREFIX = "_used ";
const TOOL_USE_SUFFIX = "_";
const ERROR_PREFIX = "error: ";

export function isToolUse(text: string): boolean {
  return text.startsWith(TOOL_USE_PREFIX) && text.endsWith(TOOL_USE_SUFFIX) && text.length > TOOL_USE_PREFIX.length;
}

export function isErrorLine(text: string): boolean {
  return text.startsWith(ERROR_PREFIX);
}

/** The text to actually display: tool lines are shown without their `_used …_` wrapper. */
export function displayText(text: string): string {
  return isToolUse(text) ? text.slice(TOOL_USE_PREFIX.length, -TOOL_USE_SUFFIX.length) : text;
}

export type TranscriptItem =
  | { kind: "message"; message: ChatMessage }
  /** A run of consecutive tool lines, collapsed behind one disclosure. */
  | { kind: "tool-run"; id: string; messages: ChatMessage[] };

/**
 * Folds runs of consecutive tool-use lines into a single item.
 *
 * The hub previously rendered every `_used …_` line inline, so a turn that touched a dozen
 * files pushed the agent's actual answer off-screen behind its own bookkeeping. Grouping is
 * by adjacency rather than by turn because the message stream carries no turn id - a run
 * ends as soon as any non-tool line (an answer, an error, a system notice) interrupts it.
 */
export function buildTranscript(messages: ChatMessage[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const message of messages) {
    if (message.authorId !== "system" && isToolUse(message.text)) {
      const last = items[items.length - 1];
      if (last?.kind === "tool-run") {
        last.messages.push(message);
        continue;
      }
      // Keyed off the first line in the run, so the open/closed state of a group survives
      // later lines being appended to it while the user is reading.
      items.push({ kind: "tool-run", id: message.id, messages: [message] });
      continue;
    }
    items.push({ kind: "message", message });
  }
  return items;
}

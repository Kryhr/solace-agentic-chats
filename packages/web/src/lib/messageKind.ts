import type { AgentMessageKind, ChatMessage, ToolCallSummary } from "@solace/shared";

/**
 * How a transcript line should be rendered.
 *
 * The server now says what each agent message IS (ChatMessage.agentKind), set from the adapter
 * event that produced it. That replaces what used to be here: two literal string tests against
 * the `_used …_` wrapper the server happened to emit. Those tests could not distinguish
 * reasoning from an answer - reasoning arrived as plain unmarked text - and any regex that had
 * tried to would eventually have hidden a real answer. Classification moved to the source; this
 * file only reads it, plus a fallback for history written before the field existed.
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

/** The text to actually display: legacy tool lines are shown without their `_used …_` wrapper. */
export function displayText(text: string): string {
  return isToolUse(text) ? text.slice(TOOL_USE_PREFIX.length, -TOOL_USE_SUFFIX.length) : text;
}

export type RenderKind = AgentMessageKind | "user" | "system";

/**
 * What to render this message as.
 *
 * The fallback for a message with no `agentKind` is deliberately conservative, because that
 * branch is every message persisted before this release. A legacy `_used …_` line is still a
 * tool call and a legacy `error: ` line is still an error - both of those wrappers were written
 * by this same server and are safe to read back. Everything else falls through to "answer",
 * which is exactly how the old hub rendered it: the migration can under-collapse an old
 * transcript, never hide part of one.
 */
export function renderKind(message: ChatMessage): RenderKind {
  if (message.authorId === "user") return "user";
  if (message.authorId === "system") return "system";
  if (message.agentKind) return message.agentKind;
  if (isErrorLine(message.text)) return "error";
  if (isToolUse(message.text)) return "tool";
  return "answer";
}

/**
 * The tool summary to show for a message, including for one persisted before `tool` existed.
 *
 * The legacy branch does NOT try to re-derive a friendly label from the old flattened string:
 * that string is `Read({"file_path":"…"})`, and parsing a label back out of it would be
 * guesswork applied to the one kind of row where a wrong guess is least visible. It shows the
 * raw call instead - exactly what the old hub showed - so old history reads as it always did.
 */
export function toolSummaryOf(message: ChatMessage): ToolCallSummary {
  if (message.tool) return message.tool;
  const raw = displayText(message.text);
  return { name: raw, label: raw, detail: raw };
}

/** True when the provider reported a non-zero exit for this call. Undefined exit codes (the
 * provider said nothing, or the tool isn't a process) are not failures and must not read as any. */
export function isFailedCall(summary: ToolCallSummary): boolean {
  return summary.exitCode !== undefined && summary.exitCode !== 0;
}

export type TranscriptItem =
  | { kind: "message"; message: ChatMessage }
  /**
   * A run of consecutive activity - tool calls and reasoning - collapsed behind one indicator.
   * `failed` is true when any call in the run reported a non-zero exit, so a run containing a
   * failure never sits in the transcript looking as quiet as one that didn't.
   */
  | { kind: "activity"; id: string; messages: ChatMessage[]; failed: boolean };

/** Kinds that belong in the collapsed activity indicator rather than in the transcript proper.
 * "error" is deliberately absent and must stay absent: a failure is never collapsed out of view. */
function isActivity(kind: RenderKind): boolean {
  return kind === "tool" || kind === "reasoning";
}

/**
 * Folds runs of consecutive tool/reasoning messages into a single item.
 *
 * Before this, every tool call was its own top-level chat message, so a turn that touched a
 * dozen files pushed the agent's actual answer off-screen behind its own bookkeeping.
 *
 * A run is broken by any non-activity message (prose, an error, a system notice) and also by a
 * change of `turnId`, so two turns whose activity happens to be adjacent - a turn that ends on a
 * tool call followed by one that opens with another - are not presented as one continuous piece
 * of work. Messages predating `turnId` carry none, and undefined compares equal to undefined, so
 * old history simply groups by adjacency the way it did before.
 */
export function buildTranscript(messages: ChatMessage[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const message of messages) {
    if (isActivity(renderKind(message))) {
      const last = items[items.length - 1];
      const sameTurn = last?.kind === "activity" && last.messages[0].turnId === message.turnId;
      if (last?.kind === "activity" && sameTurn) {
        last.messages.push(message);
        last.failed = last.failed || isFailedCall(toolSummaryOf(message));
        continue;
      }
      // Keyed off the first line in the run, so the open/closed state of a group survives later
      // lines being appended to it while the user is reading.
      items.push({ kind: "activity", id: message.id, messages: [message], failed: isFailedCall(toolSummaryOf(message)) });
      continue;
    }
    items.push({ kind: "message", message });
  }
  return items;
}

/**
 * The single line shown while a run is collapsed: the most recent entry's own label.
 *
 * Never a synthesis of the run. "Read 4 files and edited 2" would be a claim about the whole
 * turn that nothing verified, and the point of this indicator is to say what is happening now.
 */
export function activityLabel(messages: ChatMessage[]): string {
  const last = messages[messages.length - 1];
  if (!last) return "Working";
  if (renderKind(last) === "reasoning") return "Thinking";
  return toolSummaryOf(last).label || "Working";
}

/**
 * Which icon the collapsed indicator shows, chosen from the provider's real tool name.
 *
 * Same rule as the label: this is a restatement of the tool name, never a claim about what the
 * call achieved. An unrecognised name gets the neutral dot rather than a guessed-at glyph.
 */
export type ActivityIcon = "file" | "edit" | "terminal" | "search" | "globe" | "think" | "dot";

export function activityIcon(messages: ChatMessage[]): ActivityIcon {
  const last = messages[messages.length - 1];
  if (!last) return "dot";
  if (renderKind(last) === "reasoning") return "think";
  const name = toolSummaryOf(last).name.toLowerCase();
  if (/^(read|read_file|read_many_files|notebookread)$/.test(name)) return "file";
  if (/^(write|write_file|edit|multiedit|notebookedit|replace|file_change)$/.test(name)) return "edit";
  if (/^(bash|shell|run_shell_command|command_execution|bashoutput|killshell|slashcommand)$/.test(name)) return "terminal";
  if (/^(grep|glob|search_file_content|list_directory|ls)$/.test(name)) return "search";
  if (/^(webfetch|web_fetch|websearch|web_search|google_web_search)$/.test(name)) return "globe";
  return "dot";
}

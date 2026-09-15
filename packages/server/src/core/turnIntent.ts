/**
 * What an inbound message is asking the receiving agent to DO, which is what decides whether it
 * is allowed to interrupt a turn that is already running (see AgentManager's pendingInbound /
 * INTERRUPT_GRACE_MS). An agent mid-build should stop, answer a question, and go back to work;
 * it should NOT stop mid-build for another piece of work, which just belongs on the end of its
 * task list.
 *
 * "fyi" is never inferred here - only an agent declaring it explicitly through the solace MCP
 * bridge's `kind` argument can produce it. There is no cheap textual signal that separates
 * "information nobody needs to act on" from "work", and guessing wrong in that direction only
 * loses work, so unlabelled traffic falls to "work".
 */
export type IncomingKind = "question" | "work" | "fyi";

/** Verbs that mean "go change something", in any inbound phrasing. Their presence disqualifies
 * a message from being a question no matter how it is punctuated: "can you fix the header?" is
 * a work item wearing a question mark, and treating it as a question is what kills a turn. */
const IMPERATIVE_BUILD_VERB =
  /\b(build|implement|fix|add|create|refactor|write|update|migrate|deploy|install|run|make|set up)\b/i;

/** Past this length a message is a briefing, not a question, whatever punctuation it contains -
 * a long message with a question buried in it is overwhelmingly a work item in practice. */
const MAX_QUESTION_CHARS = 400;

/**
 * Classify a message that arrived with no declared kind - every human message, and every agent
 * final answer routed back through routeGroupMessage.
 *
 * The bias toward "work" is deliberate and asymmetric, because the two errors do not cost the
 * same thing:
 *   - Wrongly "work": the message is handled slightly later, once the running turn reaches its
 *     own end. Nothing is lost.
 *   - Wrongly "question": a running turn gets KILLED for it. That can leave a half-applied
 *     multi-file edit on disk, throws away whatever the CLI had built up in that turn, and
 *     bills the user for the interrupted turn, the answer, and then the resume - real money,
 *     for a message that did not need any of it.
 * So "question" is returned only on high confidence (short, actually punctuated as a question,
 * and containing no imperative build verb) and everything else is "work".
 *
 * Deliberately pure string matching with no model call: this runs on EVERY inbound message, and
 * an LLM classifier would add a billed request per message to a product whose entire cost
 * problem is billed requests per message.
 */
export function classifyIncoming(text: string): IncomingKind {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) return "work";
  if (trimmed.length > MAX_QUESTION_CHARS) return "work";
  if (!trimmed.includes("?")) return "work";
  if (IMPERATIVE_BUILD_VERB.test(trimmed)) return "work";
  return "question";
}

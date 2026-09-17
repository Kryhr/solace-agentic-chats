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

/**
 * What a message IS, which is a different question from what it asks the receiver to do.
 *
 * IncomingKind above decides one thing only: may this message kill a running turn. This decides
 * who gets a turn for it at all, and where it is shown. They are kept as two axes rather than
 * one enum because the mapping is genuinely many-to-one (a finding and a handoff are both
 * "work" for interrupt purposes) and collapsing them would make every future change to one of
 * them silently change the other.
 *
 * Measured from 28 chats / 530 agent messages: only 35% of agent messages were addressed to
 * anyone, 19 were unasked status reports ("Verified: all routes 200" to a room that did not
 * ask), and 17 were acknowledgement-only ("I've read the skills and I'm aligned"). Every one of
 * those cost every other addressed agent a real billed turn, because one unaddressed message
 * summons everybody.
 *
 *  - "question" someone needs an answer back. Interrupts after the existing grace.
 *  - "handoff"  work being passed on, or any ordinary request. The safe default.
 *  - "finding"  "this file looks wrong" - routed to the file's OWNER, so the rest of the room
 *               is not charged a turn each for one file's problem.
 *  - "status"   a report of work done or in progress that asks for nothing. Nobody gets a turn.
 *  - "ack"      an acknowledgement and nothing else. Nobody gets a turn; group never shows it.
 */
export type MessageClass = "question" | "handoff" | "finding" | "status" | "ack";

/**
 * Past this length a message is not an ack or a status line whatever words it opens with.
 *
 * The whole safety of suppressing a class is that it is short: a 900-character message that
 * happens to begin "Done -" is a report with content in it, and dropping it would be exactly the
 * failure this file's existing comment describes - losing work, which is the expensive error.
 */
const MAX_SUPPRESSIBLE_CHARS = 240;

/**
 * Status reports get a much larger ceiling than acknowledgements, because length is not what
 * separates them from real content.
 *
 * Measured after the first run on the new code: acks and status were still 32% of the room
 * against a target of 10%, and the reason was this cap. Real status reports in the operator's
 * own chats run to a median of 730 characters - "Verified independently: 1 eager (the hero), 11
 * lazy, and localhost:4321 returns 200..." is a status report precisely BECAUSE it enumerates
 * what it checked. Holding suppression to 240 characters meant the recognisers only ever fired
 * on the short ones, which were never the problem.
 *
 * An acknowledgement keeps the tight cap for the opposite reason: a long one has almost always
 * stopped being an acknowledgement and started carrying a request or a caveat, and swallowing
 * that would lose real content. The guards below (a question mark, a request, a reported
 * problem) apply to both regardless of length.
 */
const MAX_SUPPRESSIBLE_STATUS_CHARS = 2400;

/**
 * Phrases that mean the sender wants something back, which disqualifies suppression outright.
 *
 * "Sounds good. Please keep the accent at 4.5:1 or higher against cream" opens exactly like an
 * acknowledgement and ends with a real constraint somebody has to act on. Observed in the
 * operator's chats; without this it would be swallowed.
 */
const ASKS_FOR_SOMETHING =
  /\b(?:please|can you|could you|would you|can somebody|let me know|tell me|confirm whether|should i|do you want|any objection|thoughts\?|over to you|your call)\b/i;

/**
 * A message whose entire content is an acknowledgement.
 *
 * Anchored at both ends on purpose. "Got it - but the palette clashes with the header" is not an
 * ack, and an unanchored match would swallow it along with whatever it was actually saying.
 */
const ACK_TOKEN =
  "(?:ok(?:ay)?|ack(?:nowledged)?|roger|noted|understood|agreed|aligned|confirmed|received|sounds good|will do|on it|got it|makes sense|thanks(?: you)?|thank you|thanks|thx|lgtm|looks good(?: to me)?|no objections?)";

/**
 * Several ack tokens in a row still make an ack, and nothing else. "Got it, thanks" is two of
 * them; requiring exactly one would have let that one through as work, which is how a pattern
 * like this quietly stops doing anything at all.
 */
const ACK_ONLY = new RegExp(
  `^(?:@[\\w-]+[,:]?\\s*)*${ACK_TOKEN}\\b(?:[\\s.!,;-]+${ACK_TOKEN}\\b)*[\\s.!]*$`,
  "i",
);

/** A second ack shape: "I've read X and I'm aligned / no notes / nothing to add" - the
 * acknowledgement that arrives as a whole sentence rather than as one word. Seventeen of the 530
 * measured messages were this, and none of them needed anybody to do anything. */
/**
 * A lead acknowledgement followed by a pleasantry or an explicit no-action tail.
 *
 * The end-anchored ACK_SENTENCE below cannot span a sentence break, so every one of these -
 * taken verbatim from the operator's chats - fell through to "handoff" and was charged to the
 * room as if it were work:
 *   "Acknowledged. I'm here and ready if you need anything on the landing page side."
 *   "Noted, no action needed on my end - codex confirming their asset path doesn't change my task."
 *   "Acknowledged - I independently verified the same 200 response last turn. Nothing further."
 * Still refused when it asks for something or reports a problem; those checks run first.
 */
const ACK_LEAD_THEN_NOTHING =
  /^(?:@[\w-]+[,:]?\s*)*(?:acknowledged|noted|understood|agreed|agree\b|got it|will do|makes sense|sounds good|roger|ok|okay)\b/i;

const ACK_SENTENCE =
  /^(?:@[\w-]+[,:]?\s*)*(?:i(?:'ve| have)\s+(?:read|reviewed|seen|got)\b[^.?!]{0,80}(?:\band\s+(?:i'?m|i am)\s+aligned|\bno notes\b|\bnothing to add\b)|nothing (?:further )?to add|no (?:notes|objections|concerns)(?: here)?|standing by|acknowledged[^.?!]{0,40})[\s.!]*$/i;

/**
 * How a report of finished or ongoing work opens. Required to be at the START of the message,
 * because the signal is that the message LEADS with what happened rather than with an ask -
 * "the tests pass, so can you review the diff?" opens with the same words and is a question.
 */
const STATUS_OPENER =
  /^(?:@[\w-]+[,:]?\s*)*(?:status|update|progress|fyi|heads[- ]up|note)\b\s*[:-]|^(?:@[\w-]+[,:]?\s*)*(?:done|finished|completed|complete|verified|confirmed|deployed|shipped|pushed|committed|merged|built|running|up and running|final(?: live)?\b|everything\b|still\b|all (?:tests|routes|checks|three|of)\b|tests? (?:pass|passing|green)|no (?:errors|failures))\b/i;

/** Past tense, first person, nothing asked: "I verified all routes return 200." The other half
 * of a status line, and the more common half in the measured data. */
const STATUS_SELF_REPORT =
  /^(?:@[\w-]+[,:]?\s*)*i(?:'ve| have)?\s+(?:just\s+)?(?:verified|confirmed|checked|finished|completed|deployed|pushed|committed|tested|run|ran|built|added|updated|fixed)\b/i;

/** Words that mean the sender is reporting something WRONG with something, as opposed to
 * reporting that they did something. Half of the finding test; the other half is a file. */
const PROBLEM_WORD =
  /\b(?:looks? wrong|seems? wrong|is wrong|isn'?t right|not right|incorrect|broken|breaks?|bug|buggy|regression|missing|typo|mismatch|out of date|stale|duplicated?|conflicts?|fails?|failing|does ?n[o']t (?:work|match|compile|build)|should (?:be|not)|shouldn'?t|never (?:gets|reaches))\b/i;

/**
 * Something that is recognisably a file, in text an agent wrote.
 *
 * Deliberately narrow: a path with a separator or a real-looking extension. Matching bare words
 * would make every sentence containing "index" a finding about a file, and a finding routes to
 * ONE agent - a false positive there means three other agents never hear something they needed.
 *
 * Backticks/quotes are stripped by the character class rather than by a separate pass, because
 * agents overwhelmingly write paths as `src/app.ts` and an unstripped backtick makes the path
 * fail to match a claim it really is covered by.
 */
const FILE_PATH =
  /(?:^|[\s`'"(\[])((?:[\w.@-]+[\\/])+[\w.@-]+(?:\.[A-Za-z][\w]{0,9})?|[\w.@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|scss|html|py|rs|go|java|rb|sh|yml|yaml|toml|sql|astro|vue|svelte))(?=$|[\s`'"),\];:.!?])/g;

/**
 * Every file-looking token in a message, de-duplicated, in the order they appear.
 *
 * Used to ask the coordination board who owns the file a finding is about. Returns [] rather
 * than guessing when nothing matches, which makes the finding fall back to the addressee - the
 * same agent it would have reached before this existed.
 */
export function extractFilePaths(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of String(text ?? "").matchAll(FILE_PATH)) {
    const path = match[1];
    // A bare sentence-ending word like "fine." would otherwise read as a file with a one-letter
    // extension; require either a separator or an extension that is actually a file extension.
    if (!/[\\/]/.test(path) && !/\.[A-Za-z][\w]{0,9}$/.test(path)) continue;
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}

/**
 * Which of the five classes this text is, from the text alone.
 *
 * Order matters and is the whole design. Question is tested BEFORE status and ack, because a
 * message that asks something must never be suppressed however it opens - "Done. Should I also
 * wire the header?" is a question with a status line in front of it, and answering nobody would
 * leave the asker blocked. Ack is tested before status because an ack is a status line with no
 * content, and the two differ only in whether the group sees a collapsed row.
 *
 * The bias is the same asymmetry classifyIncoming documents, pointed at a different cost:
 *   - Wrongly "handoff": somebody pays a turn they did not need to pay. Money.
 *   - Wrongly "status"/"ack": NOBODY gets a turn and the group may not show it. Work is lost.
 * So the two suppressing classes require a short message, no question, and an opener that says
 * outright what the message is; everything else falls through to "handoff", exactly as every
 * message was routed before classes existed.
 *
 * Pure string matching, no model call, for the same reason as classifyIncoming: this runs on
 * every inbound message and an LLM classifier would bill a request per message.
 */
export function classifyMessageClass(text: string): MessageClass {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) return "handoff";
  if (classifyIncoming(trimmed) === "question") return "question";
  // A question mark anywhere disqualifies suppression even when classifyIncoming called it
  // "work" (it is biased to "work" for interrupt safety, which is the opposite bias to the one
  // that should decide whether anybody hears the message at all).
  const asksSomething = trimmed.includes("?") || ASKS_FOR_SOMETHING.test(trimmed);
  // A reported problem is a finding, never a status line, however it opens - "Verified: the
  // footer links are both wrong" leads like a report and is a defect report.
  const reportsAProblem = PROBLEM_WORD.test(trimmed);
  if (!asksSomething && !reportsAProblem) {
    if (
      trimmed.length <= MAX_SUPPRESSIBLE_CHARS &&
      (ACK_ONLY.test(trimmed) || ACK_SENTENCE.test(trimmed) || ACK_LEAD_THEN_NOTHING.test(trimmed))
    ) {
      return "ack";
    }
    if (trimmed.length <= MAX_SUPPRESSIBLE_STATUS_CHARS && (STATUS_OPENER.test(trimmed) || STATUS_SELF_REPORT.test(trimmed))) {
      return "status";
    }
  }
  // A finding is a problem reported about a named file. Both halves are required: "this is
  // broken" with no file cannot be routed to an owner, and a bare file path is not a complaint.
  if (PROBLEM_WORD.test(trimmed) && extractFilePaths(trimmed).length > 0) return "finding";
  return "handoff";
}

/**
 * The class a SENDER declared, mapped onto the five.
 *
 * The solace MCP bridge has carried a `kind` of "question" | "work" | "fyi" since before classes
 * existed, and those three arrive from agents in the field right now. They are mapped rather
 * than replaced so an agent that declares the old vocabulary keeps being believed: "fyi" is
 * precisely "everyone should know, nobody needs to answer", which is status. A sender may also
 * declare one of the five directly.
 *
 * Returns undefined for anything unrecognised, so the caller classifies instead of trusting a
 * string it does not understand.
 */
export function classFromDeclaredKind(kind: string | undefined): MessageClass | undefined {
  switch (kind) {
    case "question":
      return "question";
    case "work":
    case "handoff":
      return "handoff";
    case "fyi":
    case "status":
      return "status";
    case "finding":
      return "finding";
    case "ack":
      return "ack";
    default:
      return undefined;
  }
}

/**
 * The interrupt axis for a class. A question is the only class that may kill a running turn on
 * its own; everything that gets a turn at all is otherwise "work", and the two classes that get
 * no turn map to "fyi" so that if one ever IS delivered mid-turn cooperatively it arrives as
 * "no reply needed" rather than as a demand.
 */
export function incomingKindForClass(cls: MessageClass): IncomingKind {
  if (cls === "question") return "question";
  if (cls === "status" || cls === "ack") return "fyi";
  return "work";
}

/** Does this class cost anybody a real billed turn? The two that do not are the ~36 messages of
 * the measured 530 that were pure noise in the group stream. */
export function classGetsATurn(cls: MessageClass): boolean {
  return cls !== "status" && cls !== "ack";
}

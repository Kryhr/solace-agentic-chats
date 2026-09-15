import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_RESUMES,
  MAX_TURN_MS,
  buildResumePrompt,
  insertResumeTurn,
  resumeBudgetMs,
  resumeExhausted,
  type QueuedTurn,
} from "./agentManager";

/** A minimal queued turn. `at` is a millisecond offset so arrival order is readable in the
 * assertions rather than buried in ISO strings. */
function turn(id: string, kind: QueuedTurn["kind"], at: number, prompt = id): QueuedTurn {
  return {
    id,
    prompt,
    replyChannel: { chatId: "c1" },
    mentionChainDepth: 0,
    kind,
    receivedAt: new Date(1_700_000_000_000 + at).toISOString(),
  };
}

const ids = (list: QueuedTurn[]) => list.map((t) => t.id);

test("a resume goes behind the question that caused it, ahead of everything else", () => {
  const queue = [turn("q1", "question", 100), turn("w1", "work", 200), turn("w2", "work", 300)];
  const resumed = turn("resume", "work", 400);
  assert.deepEqual(ids(insertResumeTurn(queue, resumed)), ["q1", "resume", "w1", "w2"]);
});

test("work that arrived BEFORE the question still waits behind the resume", () => {
  // The whole reason a turn was killed is that the question could not wait. Letting an earlier
  // work item run first would spend the killed turn on nothing.
  const queue = [turn("w0", "work", 50), turn("q1", "question", 100), turn("w1", "work", 300)];
  const resumed = turn("resume", "work", 400);
  assert.deepEqual(ids(insertResumeTurn(queue, resumed)), ["q1", "resume", "w0", "w1"]);
});

test("the OLDEST question is the one answered, whatever order the array is in", () => {
  // An earlier interrupt may already have reordered this queue, so array position is not
  // arrival order and must not be treated as it.
  const queue = [turn("qLate", "question", 900), turn("w1", "work", 200), turn("qEarly", "question", 100)];
  const resumed = turn("resume", "work", 1000);
  assert.deepEqual(ids(insertResumeTurn(queue, resumed)), ["qEarly", "resume", "qLate", "w1"]);
});

test("with no question left the work just goes straight back to the front", () => {
  const queue = [turn("w1", "work", 200)];
  const resumed = turn("resume", "work", 400);
  assert.deepEqual(ids(insertResumeTurn(queue, resumed)), ["resume", "w1"]);
  assert.deepEqual(ids(insertResumeTurn([], resumed)), ["resume"]);
});

test("insertResumeTurn never mutates the queue it was handed", () => {
  const queue = [turn("q1", "question", 100), turn("w1", "work", 200)];
  const before = ids(queue);
  insertResumeTurn(queue, turn("resume", "work", 400));
  assert.deepEqual(ids(queue), before);
});

test("nothing is ever dropped when a resume is inserted", () => {
  const queue = [turn("q1", "question", 100), turn("w1", "work", 200), turn("q2", "question", 250)];
  const out = insertResumeTurn(queue, turn("resume", "work", 400));
  assert.equal(out.length, queue.length + 1);
  for (const t of queue) assert.ok(out.includes(t), `${t.id} was dropped`);
});

test("a resumed turn inherits the remaining budget, not a fresh one", () => {
  assert.equal(resumeBudgetMs(undefined), MAX_TURN_MS);
  assert.equal(resumeBudgetMs({ ofTurnId: "a", count: 1, elapsedMs: 5 * 60_000 }), MAX_TURN_MS - 5 * 60_000);
  // Repeated interruption must not reset the clock - this is the arithmetic that stops an agent
  // interrupted over and over from running forever. Expressed relative to MAX_TURN_MS rather
  // than against a hardcoded duration: this previously asserted 14 minutes against a 15-minute
  // ceiling, so raising the ceiling broke a test that was really about the one-minute floor.
  assert.equal(resumeBudgetMs({ ofTurnId: "a", count: 3, elapsedMs: MAX_TURN_MS - 30_000 }), 60_000);
  assert.equal(resumeBudgetMs({ ofTurnId: "a", count: 3, elapsedMs: MAX_TURN_MS * 5 }), 60_000);
});

test("the resume chain ends on either bound", () => {
  assert.equal(resumeExhausted(1, 60_000), false);
  assert.equal(resumeExhausted(MAX_RESUMES, MAX_TURN_MS - 1), false);
  assert.equal(resumeExhausted(MAX_RESUMES + 1, 0), true);
  assert.equal(resumeExhausted(1, MAX_TURN_MS), true);
});

test("a resume prompt restates the work and demands the files be re-read", () => {
  const original = turn("t1", "work", 0, "[group context: roster...]\n\n[group chat message from you]: build the header");
  const prompt = buildResumePrompt(original);
  assert.match(prompt, /build the header/);
  assert.match(prompt, /re-read the files/i);
  assert.match(prompt, /killed/i);
  // The group-context wrapper is scaffolding, not the request.
  assert.ok(!prompt.includes("[group context:"));
});

test("resuming an already-resumed turn restates the ORIGINAL work, not the last preamble", () => {
  const original = turn("t1", "work", 0, "[group chat message from you]: build the header");
  const first = buildResumePrompt(original);
  const second = buildResumePrompt({ ...original, prompt: first, resume: { ofTurnId: "t1", count: 1, elapsedMs: 1 } });
  const third = buildResumePrompt({ ...original, prompt: second, resume: { ofTurnId: "t1", count: 2, elapsedMs: 2 } });
  assert.match(third, /build the header/);
  // Without the marker-based extraction each resume would nest the previous preamble inside
  // itself and bury the actual task deeper every time.
  assert.equal(third.split("[the work you were doing]").length - 1, 1);
  assert.equal(third.length, first.length);
});

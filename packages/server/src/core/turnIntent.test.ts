import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyIncoming } from "./turnIntent";

// These tests exist because classifyIncoming is the only thing standing between "another agent
// said something" and "a running turn gets killed for it" - see the asymmetric-cost comment in
// turnIntent.ts. The high-confidence cases below are the ONLY inputs allowed to produce
// "question"; everything else must land on "work".

test("a short, plainly-punctuated question is a question", () => {
  assert.equal(classifyIncoming("should the palette stay muted?"), "question");
  assert.equal(classifyIncoming("which port is the dev server on?"), "question");
  assert.equal(classifyIncoming("Are you touching src/app/page.tsx right now?"), "question");
});

test("a question mark does not outrank an imperative build verb", () => {
  // Every one of these is a work item wearing a question mark. Treating any of them as a
  // question would kill a running turn for something that could have waited.
  assert.equal(classifyIncoming("can you fix the header spacing?"), "work");
  assert.equal(classifyIncoming("could you add a dark mode toggle?"), "work");
  assert.equal(classifyIncoming("should we make the nav sticky?"), "work");
  assert.equal(classifyIncoming("want to set up the test runner?"), "work");
  assert.equal(classifyIncoming("mind running the build?"), "work");
});

test("build verbs are matched case-insensitively and as whole words", () => {
  assert.equal(classifyIncoming("Can you REFACTOR the adapter?"), "work");
  // "building" contains "build" but is not the bare verb; the word boundary must still catch
  // the real verb rather than relying on a substring match that would also hit "rebuilding".
  assert.equal(classifyIncoming("is the building metaphor confusing?"), "question");
});

test("a message with no question mark is work", () => {
  assert.equal(classifyIncoming("I'm taking the landing page"), "work");
  assert.equal(classifyIncoming("done with the header"), "work");
});

test("a long message is work even if it contains a question mark", () => {
  const long = `${"context ".repeat(80)}does that sound right?`;
  assert.ok(long.length > 400);
  assert.equal(classifyIncoming(long), "work");
});

test("empty, whitespace and non-string input never produce a question", () => {
  assert.equal(classifyIncoming(""), "work");
  assert.equal(classifyIncoming("   \n  "), "work");
  assert.equal(classifyIncoming(undefined as unknown as string), "work");
  assert.equal(classifyIncoming(null as unknown as string), "work");
});

test("fyi is never inferred - only an agent declaring it explicitly can produce it", () => {
  const samples = [
    "heads up, I renamed the token file",
    "fyi the build is green",
    "FYI: nothing to do here",
    "just so you know?",
  ];
  for (const sample of samples) {
    assert.notEqual(classifyIncoming(sample), "fyi");
  }
});

test("a question right at the length boundary is still a question", () => {
  const padded = `${"a".repeat(398)}?`;
  assert.equal(padded.length, 399);
  assert.equal(classifyIncoming(padded), "question");
});

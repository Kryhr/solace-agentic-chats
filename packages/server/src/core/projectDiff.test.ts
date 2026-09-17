import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDiff } from "./projectDiff";

/**
 * /diff prints git's own output and nothing else.
 *
 * The failure it is written against is the one root cause E in ROADMAP.md measures: 22 claims
 * that something was live, 4 of them contradicted within fifteen messages. Every one of those
 * was a sentence about a state nobody had checked. A diff is the cheapest possible antidote -
 * it is not an opinion about whether the work is going well, it is what git says changed - but
 * only as long as nothing in the formatting is allowed to editorialise.
 */

const since = "2026-09-17T10:00:00.000Z";

test("an empty repository state says 'none', never 'no significant changes'", () => {
  // The difference matters: "none" is what git reported. "no significant changes" is a judgement
  // about the changes, and there is nothing here qualified to make one.
  const text = formatDiff({ projectName: "shop", since, log: "", stat: "" });
  assert.match(text, /Commits since then: none\./);
  assert.match(text, /working tree is clean/);
  assert.doesNotMatch(text, /significant|minor|small|major/i);
});

test("git's own lines are reproduced, not described", () => {
  const text = formatDiff({
    projectName: "shop",
    since,
    log: "a1b2c3d add the checkout page\ne4f5g6h fix the price formatter",
    stat: " src/checkout.tsx | 42 ++++++++\n 1 file changed, 42 insertions(+)",
  });
  assert.ok(text.includes("a1b2c3d add the checkout page"));
  assert.ok(text.includes("e4f5g6h fix the price formatter"));
  assert.ok(text.includes("1 file changed, 42 insertions(+)"));
});

test("a long diff is clipped, and the clipping says so rather than trailing off", () => {
  // A 4,000-line patch pasted into a room of four is the 1,300-character dump problem with a
  // bigger number. Truncation that does not announce itself is worse than either.
  const huge = Array.from({ length: 500 }, (_, i) => `+ line ${i} of a very long patch body`).join("\n");
  const text = formatDiff({ projectName: "shop", since, log: "", stat: "", patch: huge });
  assert.match(text, /\(clipped - \d+ more characters/);
  assert.ok(text.length < huge.length);
});

test("the window the numbers cover is stated, so a total is never read as the whole history", () => {
  const text = formatDiff({ projectName: "shop", since, log: "", stat: "" });
  assert.match(text, /since this chat was created/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMentions } from "./mentions";

const HANDLES = ["claude", "codex", "OllamaQwen3.5", "gpt-4o_mini"];

test("a handle containing a dot resolves", () => {
  // The live bug: "@OllamaQwen3.5 ..." captured only "OllamaQwen3", matched nothing, and the
  // message was therefore treated as unaddressed - which broadcasts it to every agent in the
  // chat. The intended agent ran, and so did every other one, each costing a real turn.
  assert.deepEqual(parseMentions("@OllamaQwen3.5 what is your cwd?", HANDLES), ["OllamaQwen3.5"]);
});

test("a trailing sentence period is not part of the handle", () => {
  assert.deepEqual(parseMentions("ask @claude.", HANDLES), ["claude"]);
  assert.deepEqual(parseMentions("@codex, then @claude.", HANDLES), ["codex", "claude"]);
});

test("an email address still resolves to nobody", () => {
  assert.deepEqual(parseMentions("mail me at kryhr@example.com", HANDLES), []);
});

test("an unknown handle is not a mention, dotted or otherwise", () => {
  assert.deepEqual(parseMentions("@nobody @nobody.5 hello", HANDLES), []);
});

test("matching is case-insensitive but reports the handle's real casing", () => {
  assert.deepEqual(parseMentions("@ollamaqwen3.5 hi", HANDLES), ["OllamaQwen3.5"]);
});

test("hyphens and underscores still work, and a handle is only reported once", () => {
  assert.deepEqual(parseMentions("@gpt-4o_mini @gpt-4o_mini go", HANDLES), ["gpt-4o_mini"]);
});

test("a malformed handle in the roster never throws", () => {
  const bad = ["claude", "", undefined as unknown as string];
  assert.deepEqual(parseMentions("@claude hi", bad), ["claude"]);
});

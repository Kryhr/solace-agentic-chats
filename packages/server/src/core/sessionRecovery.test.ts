import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeStaleSession } from "./agentManager";

test("a missing session is recoverable", () => {
  for (const m of ["No conversation found", "session abc not found", "invalid session id", "unknown session"]) {
    assert.equal(looksLikeStaleSession(m), true, m);
  }
});

test("a session poisoned by a stored reasoning effort is recoverable", () => {
  // Verified live against Copilot 1.0.84: the effort is stored IN the session, so a session
  // created with `--effort none` keeps sending reasoningEffort "none" on every resumed turn
  // even with the flag omitted. The session is permanently broken; only running cold repairs it.
  assert.equal(
    looksLikeStaleSession(
      "Execution failed: 400 Unsupported value: 'none' is not supported with the " +
        "'mai-code-1-flash-2026-06-02' model. Supported values are: 'minimal', 'low', 'medium', and 'high'.",
    ),
    true,
  );
  assert.equal(
    looksLikeStaleSession('Model "auto" does not support reasoning effort configuration (requested: "medium").'),
    true,
  );
});

test("an ordinary failure is NOT treated as a session problem", () => {
  // Dropping the session on any error would silently throw away the agent's memory of its work
  // every time a build failed or a command exited non-zero.
  for (const m of [
    "npm ERR! build failed",
    "rate limit exceeded",
    "ENOENT: no such file or directory",
    "error: unsupported value for --approval-mode",
  ]) {
    assert.equal(looksLikeStaleSession(m), false, m);
  }
});

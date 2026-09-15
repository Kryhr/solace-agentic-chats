import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listSecretValues, saveCredential, saveSecretCredential } from "./credentials";

/**
 * The vault exists so agents can sign into things, which means a real credential reaches a
 * model. Nothing then stops the model repeating it into a message, and chat history is
 * persisted in plaintext - so a secret echoed once is a secret kept forever. These cover the
 * value source the scrubber runs on; the scrub itself is exercised through it.
 */
function workspace(): string {
  return mkdtempSync(join(tmpdir(), "solace-scrub-"));
}

test("stored secrets are reported for scrubbing, across kinds", () => {
  const root = workspace();
  try {
    saveCredential(root, "custom", "deepseek", "sk-live-ABCDEF123456", "https://api.deepseek.com", "DeepSeek");
    saveSecretCredential(root, { label: "prod db password", value: "correct-horse-battery" });
    const values = listSecretValues(root);
    ok(values.includes("sk-live-ABCDEF123456"), "api key should be scrubbable");
    ok(values.includes("correct-horse-battery"), "vault secret should be scrubbable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("short values are excluded, so ordinary prose is never mangled", () => {
  const root = workspace();
  try {
    saveSecretCredential(root, { label: "tiny", value: "abc" });
    deepStrictEqual(listSecretValues(root), [], "a 3-char secret must not become a redaction pattern");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a workspace with no vault yields nothing rather than throwing", () => {
  const root = workspace();
  try {
    strictEqual(listSecretValues(root).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

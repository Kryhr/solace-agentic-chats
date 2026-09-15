import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CREDENTIALS_FILE_MODE,
  credentialsWriteOptions,
  deleteCredential,
  getCredentialSecrets,
  listCredentials,
  listSshCredentials,
  saveCredential,
  saveSshCredential,
  validateKeyPath,
  validateSshInput,
} from "./credentials";

// The credentials file is the only place in this app where a live secret sits on disk in
// plaintext, and toMeta() is the single boundary between it and every HTTP response. These
// tests assert on the SERIALIZED metadata rather than on individual fields, because the way
// this leaks in practice is a field nobody looked at riding along in the JSON.

const SECRET_API_KEY = "sk-test-do-not-leak-0123456789";
const SECRET_KEY_MATERIAL = "-----BEGIN OPENSSH PRIVATE KEY-----\nnever-leaks-abcdef\n-----END-----";
const SECRET_PASSPHRASE = "correct-horse-battery-staple";

function freshWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "solace-cred-"));
}

/** A real file on disk to point an SSH credential at - never a real key, just something the
 * existence check can succeed against. */
function dummyKeyFile(root: string): string {
  const path = join(root, "id_test");
  writeFileSync(path, "not a real key");
  return path;
}

test("a legacy record with no kind is read as an api-key, not dropped", () => {
  const root = freshWorkspace();
  // Exactly the shape written before `kind` existed: provider + key, no discriminator.
  writeFileSync(
    join(root, ".solace-credentials.json"),
    JSON.stringify([
      { id: "legacy1", provider: "custom", label: "old", createdAt: "2026-01-01T00:00:00.000Z", key: SECRET_API_KEY, baseUrl: "https://api.example.com/v1" },
    ]),
  );

  const listed = listCredentials(root);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].kind, "api-key");
  // And it still resolves for a turn, so an existing agent doesn't silently lose its key.
  assert.equal(getCredentialSecrets(root, "legacy1").key, SECRET_API_KEY);
});

test("listCredentials never serializes an api key, including for legacy records", () => {
  const root = freshWorkspace();
  writeFileSync(
    join(root, ".solace-credentials.json"),
    JSON.stringify([{ id: "legacy1", provider: "custom", label: "old", createdAt: "x", key: SECRET_API_KEY }]),
  );
  saveCredential(root, "claude-code", "personal", SECRET_API_KEY, undefined, undefined);

  const serialized = JSON.stringify(listCredentials(root));
  assert.ok(!serialized.includes(SECRET_API_KEY), "api key reached the metadata");
  assert.ok(!serialized.includes('"key"'), "a `key` field reached the metadata");
});

test("listCredentials never serializes ssh key material or a passphrase", () => {
  const root = freshWorkspace();
  saveSshCredential(root, {
    label: "prod",
    host: "example.invalid",
    username: "deploy",
    privateKey: SECRET_KEY_MATERIAL,
    passphrase: SECRET_PASSPHRASE,
  });

  const serialized = JSON.stringify(listCredentials(root));
  assert.ok(!serialized.includes("BEGIN OPENSSH PRIVATE KEY"), "pasted key material reached the metadata");
  assert.ok(!serialized.includes(SECRET_PASSPHRASE), "passphrase reached the metadata");
  assert.ok(!serialized.includes('"privateKey"'));
  assert.ok(!serialized.includes('"passphrase"'));
  // The non-secret flag that says material exists IS expected - it's what the UI warns on.
  assert.equal(listSshCredentials(root)[0].ssh.hasStoredKeyMaterial, true);

  // The secret really was stored - i.e. the assertions above prove redaction, not an empty file.
  assert.ok(readFileSync(join(root, ".solace-credentials.json"), "utf-8").includes("BEGIN OPENSSH PRIVATE KEY"));
});

test("an ssh credential cannot be resolved as an api key", () => {
  const root = freshWorkspace();
  const saved = saveSshCredential(root, {
    label: "prod",
    host: "example.invalid",
    username: "deploy",
    privateKey: SECRET_KEY_MATERIAL,
  });
  // Otherwise an agent mistakenly pointed at a deploy target would send key material as an
  // Authorization header to whatever endpoint it was configured with.
  assert.deepEqual(getCredentialSecrets(root, saved.id), {});
});

test("a saved ssh target keeps host/user/port and the key PATH, not the key", () => {
  const root = freshWorkspace();
  const keyPath = dummyKeyFile(root);
  const saved = saveSshCredential(root, {
    label: "prod-web",
    host: "deploy.example.invalid",
    username: "deploy",
    port: 2222,
    privateKeyPath: keyPath,
  });
  assert.equal(saved.kind, "ssh");
  assert.equal(saved.kind === "ssh" && saved.ssh.host, "deploy.example.invalid");
  assert.equal(saved.kind === "ssh" && saved.ssh.port, 2222);
  assert.equal(saved.kind === "ssh" && saved.ssh.username, "deploy");
  assert.equal(saved.kind === "ssh" && saved.ssh.privateKeyPath, keyPath);
  assert.equal(saved.kind === "ssh" && saved.ssh.hasStoredKeyMaterial, undefined);
  // Nothing was copied out of the referenced key file.
  assert.ok(!readFileSync(join(root, ".solace-credentials.json"), "utf-8").includes("not a real key"));
});

test("a key path that does not exist is reported honestly, not silently accepted", () => {
  const root = freshWorkspace();
  const missing = join(root, "definitely-not-here");
  const result = validateKeyPath(missing, "private key path");
  assert.ok("error" in result);
  assert.ok(result.error.includes(missing));

  assert.throws(
    () => saveSshCredential(root, { label: "x", host: "h", username: "u", privateKeyPath: missing }),
    /no file exists at/,
  );
  // A rejected save must not create a half-written credentials file.
  assert.ok(!existsSync(join(root, ".solace-credentials.json")));
});

test("a directory is not a key file, and a relative path is rejected outright", () => {
  const root = freshWorkspace();
  const dirResult = validateKeyPath(root, "private key path");
  assert.ok("error" in dirResult && dirResult.error.includes("is not a file"));

  const relative = validateKeyPath("./id_ed25519", "private key path");
  assert.ok("error" in relative && relative.error.includes("absolute"));
});

test("ssh input validation rejects a bad port and a target with no key at all", () => {
  const root = freshWorkspace();
  const keyPath = dummyKeyFile(root);
  const base = { label: "x", host: "h", username: "u", privateKeyPath: keyPath };

  assert.ok("error" in validateSshInput({ ...base, port: 0 }));
  assert.ok("error" in validateSshInput({ ...base, port: 70000 }));
  assert.ok("error" in validateSshInput({ ...base, port: 22.5 }));
  assert.ok("error" in validateSshInput({ label: "x", host: "h", username: "u" }));
  assert.ok("error" in validateSshInput({ label: "x", host: "", username: "u", privateKeyPath: keyPath }));
  assert.ok("error" in validateSshInput({ label: "x", host: "h", username: "", privateKeyPath: keyPath }));
  // Port defaults to 22 rather than being required.
  const ok = validateSshInput(base);
  assert.ok("ssh" in ok && ok.ssh.port === 22);
});

test("the credentials file is written owner-only", () => {
  const root = freshWorkspace();
  assert.equal(credentialsWriteOptions().mode, CREDENTIALS_FILE_MODE);
  assert.equal(CREDENTIALS_FILE_MODE, 0o600);

  saveCredential(root, "claude-code", "personal", SECRET_API_KEY);
  const path = join(root, ".solace-credentials.json");

  if (process.platform === "win32") {
    // Windows ignores POSIX mode bits entirely (Node maps them onto the read-only attribute
    // alone), so asserting 0o600 here would be asserting a fiction. What IS checkable is that
    // the file is still writable by us after hardening - i.e. hardening didn't lock the app
    // out of its own store. The real ACL narrowing is icacls, verified by hand, not here.
    assert.ok(statSync(path).mode & 0o200);
    // A second save must still succeed against the now-hardened file.
    saveCredential(root, "codex-cli", "second", SECRET_API_KEY);
    assert.equal(listCredentials(root).length, 2);
  } else {
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
});

test("an existing file written before hardening gets tightened on the next save", () => {
  const root = freshWorkspace();
  const path = join(root, ".solace-credentials.json");
  // Default permissions, exactly as the old writeFileSync(path, json, "utf-8") left it.
  writeFileSync(path, JSON.stringify([{ id: "old", provider: "custom", label: "l", createdAt: "x", key: SECRET_API_KEY }]));
  saveCredential(root, "claude-code", "new", SECRET_API_KEY);

  if (process.platform !== "win32") {
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
  assert.equal(listCredentials(root).length, 2);
});

test("deleting one kind leaves the other alone", () => {
  const root = freshWorkspace();
  const key = saveCredential(root, "claude-code", "personal", SECRET_API_KEY);
  const keyPath = dummyKeyFile(root);
  const ssh = saveSshCredential(root, { label: "prod", host: "h", username: "u", privateKeyPath: keyPath });

  assert.equal(deleteCredential(root, key.id), true);
  assert.equal(deleteCredential(root, "nope"), false);
  const remaining = listCredentials(root);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, ssh.id);
});

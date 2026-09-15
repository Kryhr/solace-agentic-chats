import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CREDENTIALS_FILE_MODE,
  canReadVaultAtTrustLevel,
  credentialsWriteOptions,
  deleteCredential,
  findCredentialByLabel,
  getCredentialSecrets,
  listCredentials,
  listSshCredentials,
  revealCredential,
  saveCredential,
  saveLoginCredential,
  saveSecretCredential,
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

// ---------------------------------------------------------------------------
// General vault kinds, and the reveal boundary.
// ---------------------------------------------------------------------------

const SECRET_PASSWORD = "hunter2-but-longer-and-real";
const SECRET_TOTP = "otpauth://totp/Example:me?secret=NBSWY3DPNEVEROUT";
const SECRET_VALUE = "rk_live_do_not_leak_9876543210";

test("a saved login lists as metadata only - no password, no TOTP seed", () => {
  const root = freshWorkspace();
  saveLoginCredential(root, {
    label: "grafana",
    service: "https://grafana.example.invalid",
    username: "kh",
    password: SECRET_PASSWORD,
    totpSecret: SECRET_TOTP,
    notes: "prod dashboards",
  });

  const serialized = JSON.stringify(listCredentials(root));
  assert.ok(!serialized.includes(SECRET_PASSWORD), "password reached the metadata");
  assert.ok(!serialized.includes(SECRET_TOTP), "TOTP seed reached the metadata");
  assert.ok(!serialized.includes('"password"'));
  assert.ok(!serialized.includes('"totpSecret"'));
  // The non-secret parts are what make the row usable, so they must survive.
  assert.ok(serialized.includes("grafana"));
  assert.ok(serialized.includes("prod dashboards"));

  const [meta] = listCredentials(root);
  assert.equal(meta.kind, "login");
  assert.equal(meta.kind === "login" && meta.hasPassword, true);
  assert.equal(meta.kind === "login" && meta.hasTotp, true);
  assert.equal(meta.kind === "login" && meta.username, "kh");

  // And the secret really was written - the assertions above prove redaction, not an empty file.
  assert.ok(readFileSync(join(root, ".solace-credentials.json"), "utf-8").includes(SECRET_PASSWORD));
});

test("a saved free-form secret lists as metadata only", () => {
  const root = freshWorkspace();
  saveSecretCredential(root, { label: "stripe restricted", value: SECRET_VALUE, notes: "rotate in March" });

  const serialized = JSON.stringify(listCredentials(root));
  assert.ok(!serialized.includes(SECRET_VALUE), "secret value reached the metadata");
  assert.ok(!serialized.includes('"value"'));
  const [meta] = listCredentials(root);
  assert.equal(meta.kind, "secret");
  assert.equal(meta.kind === "secret" && meta.hasValue, true);
  assert.equal(meta.notes, "rotate in March");
});

test("a login with no password is distinguishable from one that has one", () => {
  const root = freshWorkspace();
  saveLoginCredential(root, { label: "magic-link", service: "https://x.invalid", username: "me" });
  const [meta] = listCredentials(root);
  assert.equal(meta.kind === "login" && meta.hasPassword, false);
  assert.equal(meta.kind === "login" && meta.hasTotp, false);
  // Nothing to reveal, and that is not an error - it must not read as a failed reveal.
  assert.deepEqual(revealCredential(root, meta.id)?.fields, []);
});

test("a login needs a service and a username; a secret needs a value", () => {
  const root = freshWorkspace();
  assert.throws(() => saveLoginCredential(root, { label: "x", service: "", username: "u" }), /service/);
  assert.throws(() => saveLoginCredential(root, { label: "x", service: "s", username: " " }), /username/);
  assert.throws(() => saveSecretCredential(root, { label: "x", value: "  " }), /value is required/);
  assert.throws(() => saveSecretCredential(root, { label: " ", value: "v" }), /label is required/);
  assert.ok(!existsSync(join(root, ".solace-credentials.json")), "a rejected save wrote a file anyway");
});

test("reveal returns the real secret for exactly one id, and listing still does not", () => {
  const root = freshWorkspace();
  const login = saveLoginCredential(root, {
    label: "grafana",
    service: "https://grafana.example.invalid",
    username: "kh",
    password: SECRET_PASSWORD,
  });
  const secret = saveSecretCredential(root, { label: "token", value: SECRET_VALUE });
  const apiKey = saveCredential(root, "claude-code", "personal", SECRET_API_KEY);

  // The whole point of the feature: the user can get their own secret back.
  assert.equal(revealCredential(root, login.id)?.fields.find((f) => f.name === "password")?.value, SECRET_PASSWORD);
  assert.equal(revealCredential(root, secret.id)?.fields[0].value, SECRET_VALUE);
  assert.equal(revealCredential(root, apiKey.id)?.fields[0].value, SECRET_API_KEY);

  // ...and doing so changed nothing about what a list serves. Asserted on the serialized
  // JSON, because the way this leaks is a field nobody looked at riding along.
  const serialized = JSON.stringify(listCredentials(root));
  for (const leaked of [SECRET_PASSWORD, SECRET_VALUE, SECRET_API_KEY]) {
    assert.ok(!serialized.includes(leaked), "a list started serving secrets once reveal existed");
  }

  // One entry's reveal carries nothing belonging to any other entry.
  const oneReveal = JSON.stringify(revealCredential(root, login.id));
  assert.ok(!oneReveal.includes(SECRET_VALUE));
  assert.ok(!oneReveal.includes(SECRET_API_KEY));
});

test("reveal of an unknown id returns undefined rather than throwing with the id in it", () => {
  const root = freshWorkspace();
  assert.equal(revealCredential(root, "no-such-id"), undefined);
});

test("reveal exposes the ssh passphrase and says what it unlocks", () => {
  const root = freshWorkspace();
  const keyPath = dummyKeyFile(root);
  const saved = saveSshCredential(root, {
    label: "prod",
    host: "h",
    username: "u",
    privateKeyPath: keyPath,
    passphrase: SECRET_PASSPHRASE,
  });

  // The user has to be able to SEE that Solace is holding this, without revealing it.
  assert.equal(saved.kind === "ssh" && saved.ssh.hasPassphrase, true);
  assert.ok(!JSON.stringify(listCredentials(root)).includes(SECRET_PASSPHRASE));

  const field = revealCredential(root, saved.id)?.fields.find((f) => f.name === "key passphrase");
  assert.equal(field?.value, SECRET_PASSPHRASE);
  // The honest part: the note names the key file sitting in the same plaintext store.
  assert.ok(field?.note?.includes(keyPath));
});

test("supplying both a key path and pasted key material is refused, not silently resolved", () => {
  const root = freshWorkspace();
  const keyPath = dummyKeyFile(root);
  // The old behaviour kept the path and dropped the pasted key with no error and no flag,
  // so the user believed a key was saved when it was not.
  const result = validateSshInput({
    label: "x",
    host: "h",
    username: "u",
    privateKeyPath: keyPath,
    privateKey: SECRET_KEY_MATERIAL,
  });
  assert.ok("error" in result && /both/.test(result.error));

  assert.throws(
    () =>
      saveSshCredential(root, {
        label: "x",
        host: "h",
        username: "u",
        privateKeyPath: keyPath,
        privateKey: SECRET_KEY_MATERIAL,
      }),
    /both/,
  );
  assert.ok(!existsSync(join(root, ".solace-credentials.json")));
});

test("a note containing the entry's own secret is refused at save, not at list time", () => {
  const root = freshWorkspace();
  // Otherwise toMeta's fail-closed scan would fire later and take the whole list down with
  // it - correct, but at the worst possible moment and with no way to tell which row did it.
  assert.throws(
    () => saveSecretCredential(root, { label: "x", value: SECRET_VALUE, notes: `it is ${SECRET_VALUE}` }),
    /notes/,
  );
  assert.ok(!existsSync(join(root, ".solace-credentials.json")));
});

test("only an api-key record resolves as an api key - a login or secret never does", () => {
  const root = freshWorkspace();
  const login = saveLoginCredential(root, { label: "l", service: "s", username: "u", password: SECRET_PASSWORD });
  const secret = saveSecretCredential(root, { label: "s", value: SECRET_VALUE });
  // Otherwise an agent mistakenly pointed at a saved password sends it as an Authorization
  // header to whatever endpoint it was configured with.
  assert.deepEqual(getCredentialSecrets(root, login.id), {});
  assert.deepEqual(getCredentialSecrets(root, secret.id), {});
});

test("legacy records survive alongside every new kind", () => {
  const root = freshWorkspace();
  writeFileSync(
    join(root, ".solace-credentials.json"),
    JSON.stringify([{ id: "legacy1", provider: "custom", label: "old", createdAt: "x", key: SECRET_API_KEY }]),
  );
  saveLoginCredential(root, { label: "l", service: "s", username: "u", password: SECRET_PASSWORD });
  saveSecretCredential(root, { label: "s", value: SECRET_VALUE });

  const listed = listCredentials(root);
  assert.equal(listed.length, 3);
  assert.equal(listed[0].kind, "api-key");
  assert.equal(getCredentialSecrets(root, "legacy1").key, SECRET_API_KEY);
  // A record with no `kind` reveals as the api-key it is.
  assert.equal(revealCredential(root, "legacy1")?.fields[0].value, SECRET_API_KEY);
  assert.equal(revealCredential(root, "legacy1")?.kind, "api-key");

  const serialized = JSON.stringify(listed);
  for (const leaked of [SECRET_API_KEY, SECRET_PASSWORD, SECRET_VALUE]) {
    assert.ok(!serialized.includes(leaked));
  }
});

test("a plan-mode agent cannot read the vault; every acting level can", () => {
  // Plan mode is what a user picks when they want thinking and no actions. An agent that
  // cannot run a command has nothing to sign into, and letting it pull credentials would make
  // the most restricted level the one with the most reach.
  assert.equal(canReadVaultAtTrustLevel("plan"), false);
  for (const level of ["manual", "acceptEdits", "bypassPermissions", "auto"] as const) {
    assert.equal(canReadVaultAtTrustLevel(level), true, `${level} should be able to sign into things`);
  }
});

test("an entry is found by its label or its id, and by nothing else", () => {
  const root = freshWorkspace();
  const saved = saveSecretCredential(root, { label: "Deploy Token", value: SECRET_VALUE });
  assert.equal(findCredentialByLabel(root, "deploy token")?.id, saved.id);
  assert.equal(findCredentialByLabel(root, "  Deploy Token ")?.id, saved.id);
  assert.equal(findCredentialByLabel(root, saved.id)?.id, saved.id);
  assert.equal(findCredentialByLabel(root, "deploy"), undefined);
  assert.equal(findCredentialByLabel(root, ""), undefined);
  // What it returns is metadata - getting the value is a separate, audited step.
  assert.ok(!JSON.stringify(findCredentialByLabel(root, "deploy token")).includes(SECRET_VALUE));
});

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SshCredentialMeta } from "@solace/shared";
import { checkCredential, checkSshTarget, NotCheckableError } from "./connectionChecks";
import { saveLoginCredential, saveSecretCredential, saveSshCredential } from "./credentials";

/**
 * The rule under test throughout: a check either really happened, or it does not produce a
 * result at all. Nothing here may return ok:true because something merely exists, and a
 * "there is nothing to verify" answer must be distinguishable from "the check ran and
 * failed" - the UI paints those two very differently, and conflating them is how an unbacked
 * green state gets back in.
 */

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "solace-checks-"));
}

function sshMeta(over: Partial<SshCredentialMeta["ssh"]>): SshCredentialMeta {
  return {
    kind: "ssh",
    id: "x",
    label: "prod",
    createdAt: new Date().toISOString(),
    ssh: { host: "deploy.example.com", port: 22, username: "deploy", ...over },
  };
}

test("an SSH target whose key file is still there passes, and says it proved nothing more", () => {
  const root = tempRoot();
  try {
    const key = join(root, "id_ed25519");
    writeFileSync(key, "-----BEGIN OPENSSH PRIVATE KEY-----\n");
    const result = checkSshTarget(sshMeta({ privateKeyPath: key }));
    assert.equal(result.ok, true);
    assert.ok(result.detail.includes(key));
    // The honesty requirement, asserted rather than left to a comment: a green SSH row must
    // not be readable as "this host accepts this key". Only the file was checked.
    assert.match(result.detail, /does not prove/i);
    assert.ok(Date.parse(result.checkedAt) > 0, "every check carries the time it ran");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a key file that has gone away fails, naming the path that moved", () => {
  const root = tempRoot();
  try {
    const key = join(root, "gone");
    const result = checkSshTarget(sshMeta({ privateKeyPath: key }));
    assert.equal(result.ok, false);
    assert.ok(result.detail.includes(key));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a path that is now a directory fails rather than passing on mere existence", () => {
  const root = tempRoot();
  try {
    const dir = join(root, "keys");
    mkdirSync(dir);
    const result = checkSshTarget(sshMeta({ privateKeyPath: dir }));
    assert.equal(result.ok, false);
    assert.match(result.detail, /not a file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing known_hosts is reported, not silently ignored", () => {
  const root = tempRoot();
  try {
    const key = join(root, "id_ed25519");
    writeFileSync(key, "k");
    const result = checkSshTarget(sshMeta({ privateKeyPath: key, knownHostsPath: join(root, "absent") }));
    assert.equal(result.ok, false);
    assert.match(result.detail, /known_hosts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a target whose key lives inside Solace says so instead of claiming a file check", () => {
  const result = checkSshTarget(sshMeta({ hasStoredKeyMaterial: true }));
  assert.match(result.detail, /no key file to check/);
  assert.match(result.detail, /does not prove/i);
});

test("a stored login or secret refuses to be checked rather than reporting a failure", async () => {
  const root = tempRoot();
  try {
    const login = saveLoginCredential(root, { label: "grafana", service: "https://g.example.com", username: "me", password: "pw" });
    const secret = saveSecretCredential(root, { label: "stripe", value: "sk_test_x" });

    for (const id of [login.id, secret.id]) {
      // Specifically NOT a ConnectionCheck with ok:false. A vault entry that exists has not
      // failed anything; there is simply nothing this app can verify about it without
      // signing in to a third party behind the user's back.
      await assert.rejects(() => checkCredential(root, id), NotCheckableError);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unknown id is refused, not reported as a failed check", async () => {
  const root = tempRoot();
  try {
    await assert.rejects(() => checkCredential(root, "no-such-id"), NotCheckableError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an SSH credential is checked through checkCredential by its real stored path", async () => {
  const root = tempRoot();
  try {
    const key = join(root, "id_ed25519");
    writeFileSync(key, "-----BEGIN OPENSSH PRIVATE KEY-----\n");
    const saved = saveSshCredential(root, { label: "prod", host: "h.example.com", username: "deploy", privateKeyPath: key });
    const result = await checkCredential(root, saved.id);
    assert.equal(result.ok, true);
    assert.ok(result.detail.includes(key));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an endpoint connection with no base URL and no known API host is refused", async () => {
  const root = tempRoot();
  try {
    // Saved as "custom" with no base URL: there is genuinely nowhere to send a request, which
    // is a refusal rather than a red dot pointing the user at a connection problem.
    const { saveCredential } = await import("./credentials");
    const saved = saveCredential(root, "custom", "half-configured", "sk-test");
    await assert.rejects(() => checkCredential(root, saved.id), NotCheckableError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

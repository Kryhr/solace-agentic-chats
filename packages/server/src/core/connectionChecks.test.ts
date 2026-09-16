import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SshCredentialMeta } from "@solace/shared";
import {
  checkCredential,
  checkSshTarget,
  describeSshCheck,
  inspectKnownHosts,
  inspectSshKeyFile,
  NotCheckableError,
  type SshFacts,
} from "./connectionChecks";
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

/** Facts with everything healthy, for tests that vary exactly one thing. */
function okFacts(over: Partial<SshFacts> = {}): SshFacts {
  return {
    dns: { ok: true, address: "203.0.113.7" },
    port: { ok: true },
    key: { state: "ok", path: "/keys/id_ed25519" },
    knownHosts: { state: "not-configured" },
    ...over,
  };
}

function describe(over: Partial<SshFacts>, metaOver: Partial<SshCredentialMeta["ssh"]> = {}) {
  return describeSshCheck(sshMeta(metaOver), okFacts(over), new Date().toISOString());
}

// --- the verdict, with no network involved -------------------------------------------------

test("a healthy SSH target passes and still says a login was never attempted", () => {
  const result = describe({});
  assert.equal(result.ok, true);
  assert.match(result.detail, /resolves to 203\.0\.113\.7/);
  // The honesty requirement, asserted rather than left to a comment: a green SSH row must
  // never be readable as "this host accepts this key".
  assert.match(result.detail, /does not prove/i);
  assert.ok(Date.parse(result.checkedAt) > 0, "every check carries the time it ran");
});

test("a host that does not resolve fails, and does not also report a second port fault", () => {
  const result = describe({ dns: { ok: false, error: "getaddrinfo ENOTFOUND" }, port: { ok: false, error: "no address" } });
  assert.equal(result.ok, false);
  assert.match(result.detail, /does not resolve/);
  // One real fault, reported once. A name that never resolved had nothing to connect to, so
  // listing a port failure beside it would read as two independent problems.
  assert.doesNotMatch(result.detail, /port 22 did not answer/);
});

test("a resolving host whose port is shut fails on the port", () => {
  const result = describe({ port: { ok: false, error: "connect ECONNREFUSED" } });
  assert.equal(result.ok, false);
  assert.match(result.detail, /port 22 did not answer.*ECONNREFUSED/);
});

test("an SSH banner is carried through verbatim as the evidence it is", () => {
  const result = describe({ port: { ok: true, banner: "SSH-2.0-OpenSSH_9.6" } });
  assert.equal(result.ok, true);
  assert.match(result.detail, /SSH-2\.0-OpenSSH_9\.6/);
});

test("a key file that has gone away fails, naming the path that moved", () => {
  const result = describe({ key: { state: "missing", path: "/keys/gone" } });
  assert.equal(result.ok, false);
  assert.match(result.detail, /\/keys\/gone/);
});

test("a path that is now a directory fails rather than passing on mere existence", () => {
  const result = describe({ key: { state: "not-a-file", path: "/keys" } });
  assert.equal(result.ok, false);
  assert.match(result.detail, /not a file/);
});

test("a key file that exists but cannot be opened fails - existing is not readable", () => {
  // The specific regression this rewrite exists for: the old check reported "present and
  // readable" after calling only existsSync + statSync, so a key with no read permission
  // passed while claiming a read that never happened.
  const result = describe({ key: { state: "unreadable", path: "/keys/id_ed25519", error: "EACCES: permission denied" } });
  assert.equal(result.ok, false);
  assert.match(result.detail, /could not be opened for reading.*EACCES/);
});

test("a target whose key lives inside Solace says so instead of claiming a file check", () => {
  const result = describe({ key: { state: "stored-in-solace" } });
  assert.match(result.detail, /no key file to check/);
  assert.match(result.detail, /does not prove/i);
});

test("a missing known_hosts is reported, not silently ignored", () => {
  const result = describe({ knownHosts: { state: "missing", path: "/home/me/.ssh/known_hosts" } });
  assert.equal(result.ok, false);
  assert.match(result.detail, /known_hosts/);
});

test("a known_hosts with no entry for this host is a reported problem, not a pass", () => {
  const result = describe({ knownHosts: { state: "no-entry", path: "/kh" } });
  assert.equal(result.ok, false);
  assert.match(result.detail, /no entry for deploy\.example\.com/);
});

test("hashed known_hosts entries are admitted as unreadable rather than called missing", () => {
  // We genuinely cannot tell without recomputing an HMAC per line. "Cannot tell" must not be
  // reported as "no entry", which would send the user looking for a problem they don't have.
  const result = describe({ knownHosts: { state: "only-hashed", path: "/kh" } });
  assert.equal(result.ok, true);
  assert.match(result.detail, /hashed entries/);
});

// --- the filesystem inspectors, on real files ----------------------------------------------

test("inspectSshKeyFile reads a real file, a real directory and a real absence", () => {
  const root = tempRoot();
  try {
    const key = join(root, "id_ed25519");
    writeFileSync(key, "-----BEGIN OPENSSH PRIVATE KEY-----\n");
    const dir = join(root, "keys");
    mkdirSync(dir);
    assert.deepEqual(inspectSshKeyFile(key), { state: "ok", path: key });
    assert.equal(inspectSshKeyFile(dir).state, "not-a-file");
    assert.equal(inspectSshKeyFile(join(root, "nope")).state, "missing");
    assert.equal(inspectSshKeyFile(undefined).state, "stored-in-solace");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inspectKnownHosts finds a real entry, including the [host]:port spelling", () => {
  const root = tempRoot();
  try {
    const kh = join(root, "known_hosts");
    writeFileSync(kh, "# a comment\ndeploy.example.com ssh-ed25519 AAAAC3Nz\nother.example.org ssh-rsa AAAAB3\n");
    assert.equal(inspectKnownHosts(kh, "deploy.example.com", 22).state, "has-entry");
    assert.equal(inspectKnownHosts(kh, "absent.example.com", 22).state, "no-entry");

    const ported = join(root, "kh2");
    writeFileSync(ported, "[deploy.example.com]:2222 ssh-ed25519 AAAAC3Nz\n");
    assert.equal(inspectKnownHosts(ported, "deploy.example.com", 2222).state, "has-entry");

    const hashed = join(root, "kh3");
    writeFileSync(hashed, "|1|abc=|def= ssh-ed25519 AAAAC3Nz\n");
    assert.equal(inspectKnownHosts(hashed, "deploy.example.com", 22).state, "only-hashed");

    assert.equal(inspectKnownHosts(join(root, "gone"), "h", 22).state, "missing");
    assert.equal(inspectKnownHosts(undefined, "h", 22).state, "not-configured");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- end to end, against a real socket on loopback (no external network) --------------------

function listenOnce(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port }));
  });
}

test("checkSshTarget really resolves a host and really connects to an open port", async () => {
  const root = tempRoot();
  const { server, port } = await listenOnce();
  try {
    const key = join(root, "id_ed25519");
    writeFileSync(key, "-----BEGIN OPENSSH PRIVATE KEY-----\n");
    // 127.0.0.1 and a port this test is genuinely listening on: the DNS lookup and the TCP
    // connect both actually happen, with nothing stubbed and nothing off this machine.
    const result = await checkSshTarget(sshMeta({ host: "127.0.0.1", port, privateKeyPath: key }));
    assert.equal(result.ok, true, result.detail);
    assert.match(result.detail, /resolves to 127\.0\.0\.1/);
    assert.match(result.detail, new RegExp(`port ${port} accepted`));
    assert.match(result.detail, /opened for reading/);
    assert.match(result.detail, /does not prove/i);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkSshTarget really fails against a port nothing is listening on", async () => {
  const root = tempRoot();
  // Bind then immediately release, so the port is real, ours, and now certainly closed.
  const { server, port } = await listenOnce();
  await new Promise((r) => server.close(r));
  try {
    const key = join(root, "id_ed25519");
    writeFileSync(key, "k");
    const result = await checkSshTarget(sshMeta({ host: "127.0.0.1", port, privateKeyPath: key }));
    assert.equal(result.ok, false);
    assert.match(result.detail, new RegExp(`port ${port} did not answer`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
  const { server, port } = await listenOnce();
  try {
    const key = join(root, "id_ed25519");
    writeFileSync(key, "-----BEGIN OPENSSH PRIVATE KEY-----\n");
    // A loopback host and a port this test is actually listening on, so the check's real DNS
    // and TCP probes can pass without this test depending on anything off the machine.
    const saved = saveSshCredential(root, { label: "prod", host: "127.0.0.1", port, username: "deploy", privateKeyPath: key });
    const result = await checkCredential(root, saved.id);
    assert.equal(result.ok, true, result.detail);
    assert.ok(result.detail.includes(key));
  } finally {
    server.close();
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

import { existsSync, readFileSync, statSync, accessSync, constants } from "node:fs";
import { lookup } from "node:dns/promises";
import { connect } from "node:net";
import type { ConnectionCheck, SshCredentialMeta } from "@solace/shared";
import { getCredentialSecrets, listCredentials } from "./credentials";
import { discoverModels } from "./modelDiscovery";

/**
 * The genuine, cheap check behind every saved connection's "Check" button.
 *
 * The rule this file exists to enforce: a check either really happened or it didn't. Every
 * path here either performs a real request / a real filesystem read and reports what came
 * back, or refuses to produce a ConnectionCheck at all. Nothing returns `ok: true` on the
 * strength of an assumption, and nothing summarises an upstream error into a friendlier
 * sentence than the one the upstream actually gave.
 *
 * Nothing here is ever run on a page load, a prefetch or a poll: these hit paid endpoints
 * and the user's own filesystem, so they only happen when the user presses the button.
 */

const TIMEOUT_MS = 10_000;

/**
 * A key saved for "claude-code" is used against api.anthropic.com, which is not
 * OpenAI-compatible: it wants `x-api-key` and an `anthropic-version` header rather than a
 * bearer token. `anthropic-version` is the same value adapters/claude-api.ts already sends,
 * so this check talks to the API exactly as the agent would.
 */
async function checkAnthropicKey(apiKey: string): Promise<ConnectionCheck> {
  const checkedAt = new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch("https://api.anthropic.com/v1/models", {
      method: "GET",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", accept: "application/json" },
      signal: controller.signal,
    });
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      return { ok: false, detail: `api.anthropic.com/v1/models returned ${response.status}: ${text.slice(0, 200)}`, checkedAt };
    }
    const ids = extractIds(text);
    return {
      ok: true,
      detail: ids.length
        ? `api.anthropic.com/v1/models listed ${ids.length} model${ids.length === 1 ? "" : "s"} (${ids.slice(0, 3).join(", ")}${ids.length > 3 ? ", …" : ""})`
        : "api.anthropic.com/v1/models answered 200 but listed no model ids",
      checkedAt,
    };
  } catch (err) {
    return { ok: false, detail: `could not reach api.anthropic.com/v1/models: ${(err as Error).message}`, checkedAt };
  } finally {
    clearTimeout(timer);
  }
}

function extractIds(text: string): string[] {
  try {
    const data = (JSON.parse(text) as { data?: unknown }).data;
    if (!Array.isArray(data)) return [];
    return data
      .map((m) => (m && typeof m === "object" ? (m as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------------------
// SSH deploy targets
//
// This check had never been verified end to end, and what it actually did was narrower than
// what it said: it called existsSync + statSync and then reported the key file as "present
// and readable" without ever having read it, which is precisely the kind of unbacked claim
// this file exists to prevent. A key file with no read permission passed.
//
// What it proves now, each part separately reported and separately falsifiable:
//   - the hostname resolves to an address (real DNS lookup);
//   - something is listening on the target port (real TCP connect, closed immediately);
//   - the key file exists, is a regular file, and can actually be opened for reading;
//   - whether the host has a known_hosts entry we can genuinely see.
//
// What it still does NOT prove, and says so in the same breath every time: that the host
// will accept this key. That needs a real login with real credentials, which this app does
// not perform on a button press. A TCP connect is not a login: the socket is destroyed the
// instant it opens, before any SSH banner exchange or authentication.
// ---------------------------------------------------------------------------------------

const DNS_TIMEOUT_MS = 5000;
const TCP_TIMEOUT_MS = 5000;

export type SshDnsFact = { ok: true; address: string } | { ok: false; error: string };
export type SshPortFact = { ok: true; banner?: string } | { ok: false; error: string };
export type SshKeyFact =
  | { state: "stored-in-solace" }
  | { state: "ok"; path: string }
  | { state: "missing"; path: string }
  | { state: "not-a-file"; path: string }
  | { state: "unreadable"; path: string; error: string };
export type SshKnownHostsFact =
  | { state: "not-configured" }
  | { state: "missing"; path: string }
  | { state: "has-entry"; path: string }
  | { state: "no-entry"; path: string }
  | { state: "only-hashed"; path: string }
  | { state: "unreadable"; path: string; error: string };

/** Everything the probes observed. Split from the verdict so that "what counts as a pass" is
 * directly testable without a network - same discipline as localDiscovery's
 * identifyProbeResponse. */
export interface SshFacts {
  dns: SshDnsFact;
  port: SshPortFact;
  key: SshKeyFact;
  knownHosts: SshKnownHostsFact;
}

/** Opens the key file for reading and closes it again. accessSync(R_OK) rather than
 * existsSync: a key file that exists but cannot be read is the exact case the old check
 * called "present and readable". */
export function inspectSshKeyFile(path: string | undefined, hasStoredKeyMaterial?: boolean): SshKeyFact {
  if (!path) return { state: "stored-in-solace" };
  if (!existsSync(path)) return { state: "missing", path };
  try {
    if (!statSync(path).isFile()) return { state: "not-a-file", path };
    accessSync(path, constants.R_OK);
    return { state: "ok", path };
  } catch (err) {
    return { state: "unreadable", path, error: (err as Error).message };
  }
}

/**
 * Does this known_hosts file actually pin this host?
 *
 * Hashed entries (`|1|salt|hash`) cannot be matched without recomputing the HMAC per line,
 * and guessing would be worse than admitting it: a file of hashed entries reports
 * "only-hashed" - we genuinely cannot tell - rather than "no entry", which would read as a
 * problem the user does not have.
 */
export function inspectKnownHosts(path: string | undefined, host: string, port: number): SshKnownHostsFact {
  if (!path) return { state: "not-configured" };
  if (!existsSync(path)) return { state: "missing", path };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return { state: "unreadable", path, error: (err as Error).message };
  }
  const wanted = host.trim().toLowerCase();
  // OpenSSH writes a non-22 port as [host]:port, and only then.
  const wantedWithPort = `[${wanted}]:${port}`;
  let sawHashed = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const first = line.split(/\s+/)[0];
    if (!first) continue;
    if (first.startsWith("|1|")) {
      sawHashed = true;
      continue;
    }
    for (const pattern of first.split(",")) {
      const p = pattern.trim().toLowerCase();
      if (p === wanted || p === wantedWithPort) return { state: "has-entry", path };
    }
  }
  return sawHashed ? { state: "only-hashed", path } : { state: "no-entry", path };
}

/** A real DNS lookup, timeboxed, never throwing. An IP literal resolves to itself. */
async function resolveHost(host: string): Promise<SshDnsFact> {
  try {
    const result = await Promise.race([
      lookup(host),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`DNS lookup timed out after ${DNS_TIMEOUT_MS / 1000}s`)), DNS_TIMEOUT_MS)),
    ]);
    return { ok: true, address: result.address };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * A real TCP connect, destroyed the moment it succeeds. Deliberately NOT an SSH handshake and
 * emphatically not a login: no credentials are sent, no key is read, nothing is offered to
 * the far end. If the server happens to send its identification banner before we hang up we
 * keep it, because "SSH-2.0-OpenSSH_9.6" is real evidence that the thing on that port is an
 * SSH server rather than something else that merely accepts connections.
 */
function probePort(host: string, port: number): Promise<SshPortFact> {
  return new Promise((resolve) => {
    let settled = false;
    let banner = "";
    const done = (fact: SshPortFact) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(fact);
    };
    const socket = connect({ host, port });
    socket.setTimeout(TCP_TIMEOUT_MS);
    socket.once("connect", () => {
      // Give the server a brief moment to volunteer its banner, then hang up regardless.
      setTimeout(() => done({ ok: true, banner: banner.trim() || undefined }), 250);
    });
    socket.on("data", (chunk) => {
      banner += chunk.toString("utf8").slice(0, 120);
      if (banner.includes("\n")) done({ ok: true, banner: banner.split("\n")[0].trim() });
    });
    socket.once("timeout", () => done({ ok: false, error: `no answer from ${host}:${port} within ${TCP_TIMEOUT_MS / 1000}s` }));
    socket.once("error", (err) => done({ ok: false, error: (err as Error).message }));
  });
}

/**
 * Turns observed facts into the verdict. Pure, so every branch is testable without a network.
 *
 * `ok` is true only when nothing was actually found to be wrong. The two cases that are NOT
 * failures but are also not proof - a key held inside Solace, and a host whose known_hosts
 * entries are all hashed - are carried in the text rather than being allowed to flip the
 * result either way.
 */
export function describeSshCheck(meta: SshCredentialMeta, facts: SshFacts, checkedAt: string): ConnectionCheck {
  const { host, port } = meta.ssh;
  const proved: string[] = [];
  const problems: string[] = [];

  if (facts.dns.ok) proved.push(`${host} resolves to ${facts.dns.address}`);
  else problems.push(`${host} does not resolve: ${facts.dns.error}`);

  if (facts.port.ok) {
    proved.push(facts.port.banner ? `port ${port} answered: ${facts.port.banner}` : `port ${port} accepted a TCP connection`);
  } else if (facts.dns.ok) {
    // Only meaningful when we had an address to connect to; otherwise the DNS line above
    // already says why, and repeating it as a second failure reads as two separate faults.
    problems.push(`port ${port} did not answer: ${facts.port.error}`);
  }

  switch (facts.key.state) {
    case "ok":
      proved.push(`key file ${facts.key.path} opened for reading`);
      break;
    case "stored-in-solace":
      proved.push("the key for this target is stored inside Solace, so there is no key file to check");
      break;
    case "missing":
      problems.push(`no file exists at ${facts.key.path} any more - the key this target points at has moved or been deleted`);
      break;
    case "not-a-file":
      problems.push(`${facts.key.path} exists but is not a file`);
      break;
    case "unreadable":
      problems.push(`${facts.key.path} exists but could not be opened for reading: ${facts.key.error}`);
      break;
  }

  switch (facts.knownHosts.state) {
    case "has-entry":
      proved.push(`${host} has an entry in ${facts.knownHosts.path}`);
      break;
    case "missing":
      problems.push(`known_hosts at ${facts.knownHosts.path} is missing`);
      break;
    case "unreadable":
      problems.push(`known_hosts at ${facts.knownHosts.path} could not be read: ${facts.knownHosts.error}`);
      break;
    case "no-entry":
      problems.push(`${facts.knownHosts.path} has no entry for ${host}, so the first connection will have nothing to verify the host key against`);
      break;
    case "only-hashed":
      proved.push(`${facts.knownHosts.path} uses hashed entries, so whether ${host} is pinned there cannot be read off the file`);
      break;
    case "not-configured":
      proved.push("no known_hosts file is configured for this target, so ssh will use your default one");
      break;
  }

  // Never dropped, on either outcome. The whole point of this row is that a green tick here
  // must not be readable as "this host accepts this key".
  const caveat = `Not a sign-in test - it does not prove ${host} accepts this key.`;
  const body = problems.length > 0 ? problems.join("; ") : proved.join("; ");
  return { ok: problems.length === 0, detail: `${body}. ${caveat}`, checkedAt };
}

/**
 * A deploy target's check: the real probes, then the verdict above.
 *
 * DNS and a TCP connect are the two things that can be honestly established about a remote
 * host without authenticating to it, and they are the two that catch the failures people
 * actually hit - a renamed host, a VPN that is not up, a firewall, a moved SSH port. No
 * credential is transmitted and no login is attempted.
 */
export async function checkSshTarget(meta: SshCredentialMeta): Promise<ConnectionCheck> {
  const checkedAt = new Date().toISOString();
  const { host, port, privateKeyPath, knownHostsPath, hasStoredKeyMaterial } = meta.ssh;

  const dns = await resolveHost(host);
  const facts: SshFacts = {
    dns,
    // Connecting is only meaningful once we have an address; a name that does not resolve has
    // nothing to connect to, and reporting a synthesized socket error would be inventing one.
    port: dns.ok ? await probePort(dns.address, port) : { ok: false, error: `${host} did not resolve` },
    key: inspectSshKeyFile(privateKeyPath, hasStoredKeyMaterial),
    knownHosts: inspectKnownHosts(knownHostsPath, host, port),
  };
  return describeSshCheck(meta, facts, checkedAt);
}

/** Why a given entry cannot be checked, for the kinds where that is the honest answer. */
export class NotCheckableError extends Error {}

/**
 * Checks one saved credential, whatever kind it is. Returns the credential's meta alongside
 * the result so the caller doesn't have to look it up twice.
 */
export async function checkCredential(workspaceRoot: string, id: string): Promise<ConnectionCheck> {
  const meta = listCredentials(workspaceRoot).find((c) => c.id === id);
  if (!meta) throw new NotCheckableError("no saved connection with that id");

  if (meta.kind === "ssh") return await checkSshTarget(meta);

  if (meta.kind === "login" || meta.kind === "secret") {
    // Not a failure - there is genuinely nothing to check. Signing in to a third-party
    // service to find out whether a stored password still works is not something this app
    // does on a button press, and pretending the entry is "verified" because it exists would
    // be exactly the unbacked green state this panel was rebuilt to remove.
    throw new NotCheckableError(
      "a stored login or secret can't be verified from here - only the service it belongs to can say whether it still works",
    );
  }

  const { key, baseUrl } = getCredentialSecrets(workspaceRoot, id);
  const checkedAt = new Date().toISOString();

  if (!baseUrl) {
    // A key saved against one of the CLI providers has no base URL of its own; it is used
    // against that provider's own API host. Anything else genuinely has nowhere to send a
    // request, and says so instead of failing vaguely.
    if (meta.provider === "claude-code") {
      if (!key) return { ok: false, detail: "no key is stored for this connection, so there is nothing to check", checkedAt };
      return checkAnthropicKey(key);
    }
    if (meta.provider === "codex-cli") {
      if (!key) return { ok: false, detail: "no key is stored for this connection, so there is nothing to check", checkedAt };
      return checkOpenAiCompatible("https://api.openai.com/v1", key, checkedAt);
    }
    throw new NotCheckableError(
      `this connection has no base URL saved, and there is no known API host for "${meta.provider}" to check it against`,
    );
  }

  return checkOpenAiCompatible(baseUrl, key || undefined, checkedAt);
}

/**
 * The real GET {baseUrl}/models. This is the same call Add Agent uses to populate a model
 * list, run here for its other meaning: an endpoint that lists its models for this key is an
 * endpoint this key can actually reach. A local runtime answers it too, and its reply - a
 * genuine OpenAI-shaped model list - is what identifies it as a model server rather than
 * some other thing listening on that port.
 */
async function checkOpenAiCompatible(baseUrl: string, apiKey: string | undefined, checkedAt: string): Promise<ConnectionCheck> {
  try {
    // force: a check must hit the network. See discoverModels' own note - without this the
    // 60s cache answered, and the fresh checkedAt below made a dead endpoint read as "Working".
    const result = await discoverModels(baseUrl, apiKey, { force: true });
    const shown = result.models.slice(0, 3).join(", ");
    return {
      ok: true,
      detail: `${baseUrl}/models listed ${result.models.length} model${result.models.length === 1 ? "" : "s"} (${shown}${result.models.length > 3 ? ", …" : ""})`,
      checkedAt,
    };
  } catch (err) {
    // The upstream's own message, not a rewrite of it - a 401 body and a DNS failure send the
    // user to completely different places and must not read the same.
    return { ok: false, detail: (err as Error).message, checkedAt };
  }
}

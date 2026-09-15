import { existsSync, statSync } from "node:fs";
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

/**
 * A deploy target's check, and the one place where being clear about what was NOT proven
 * matters most. Solace stores a reference to a key file; whether the far-end host still
 * accepts that key can only be learned by signing in, which this app will not do on its own.
 * So the check is exactly what it says it is - the file is still there, and it is a file -
 * and the detail text says so rather than letting "SSH ✓" imply a working login.
 */
export function checkSshTarget(meta: SshCredentialMeta): ConnectionCheck {
  const checkedAt = new Date().toISOString();
  const path = meta.ssh.privateKeyPath;

  if (!path) {
    return {
      ok: true,
      detail: "the key for this target is stored inside Solace, so there is no key file to check. This does not prove the host accepts it.",
      checkedAt,
    };
  }
  if (!existsSync(path)) {
    return { ok: false, detail: `no file exists at ${path} any more - the key this target points at has moved or been deleted`, checkedAt };
  }
  try {
    if (!statSync(path).isFile()) {
      return { ok: false, detail: `${path} exists but is not a file`, checkedAt };
    }
  } catch (err) {
    return { ok: false, detail: `could not read ${path}: ${(err as Error).message}`, checkedAt };
  }

  const extras: string[] = [];
  if (meta.ssh.knownHostsPath && !existsSync(meta.ssh.knownHostsPath)) {
    extras.push(`known_hosts at ${meta.ssh.knownHostsPath} is missing`);
  }
  return {
    // Deliberately not "connected". The key file is present and readable; that is the whole
    // claim. Signing in to find out more is the user's to trigger, not this button's.
    ok: extras.length === 0,
    detail:
      extras.length === 0
        ? `key file ${path} is present and readable. Not a sign-in test - it does not prove ${meta.ssh.host} accepts this key.`
        : extras.join("; "),
    checkedAt,
  };
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

  if (meta.kind === "ssh") return checkSshTarget(meta);

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
    const result = await discoverModels(baseUrl, apiKey);
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

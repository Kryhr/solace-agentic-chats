import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import type { CredentialMeta, ProviderId } from "@solace/shared";

interface StoredCredential extends CredentialMeta {
  /** The actual API key, or "" for a keyless connection (a local model server usually has no
   * key at all - see adapters/custom-api.ts, which sends no Authorization header when this is
   * empty). Never returned from listCredentials() or any GET route - only
   * getCredentialSecrets() (server-internal, used right before an API call) can see it. */
  key: string;
}

/**
 * Raw API keys live in their own file, separate from .solace-state.json, and - like that
 * file - outside the git repo entirely (WORKSPACE_ROOT is ~/Desktop/solace-workspace by
 * default), so there's nothing to .gitignore: it's simply never inside a directory git
 * tracks. Metadata (id/provider/label) is what the client ever sees; the key itself only
 * ever travels from the browser once (POST /api/credentials) and from this file into an
 * outgoing API request - never back out to any client.
 */
function credentialsPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".solace-credentials.json");
}

function loadAll(workspaceRoot: string): StoredCredential[] {
  const path = credentialsPath(workspaceRoot);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveAll(workspaceRoot: string, all: StoredCredential[]) {
  writeFileSync(credentialsPath(workspaceRoot), JSON.stringify(all), "utf-8");
}

function toMeta(c: StoredCredential): CredentialMeta {
  return {
    id: c.id,
    provider: c.provider,
    label: c.label,
    createdAt: c.createdAt,
    baseUrl: c.baseUrl,
    connectionName: c.connectionName,
    hasKey: Boolean(c.key),
  };
}

export function listCredentials(workspaceRoot: string): CredentialMeta[] {
  return loadAll(workspaceRoot).map(toMeta);
}

export function saveCredential(
  workspaceRoot: string,
  provider: ProviderId,
  label: string,
  /** Empty for a keyless connection - see StoredCredential.key. */
  rawKey: string,
  /** Both only meaningful for providers "custom" and "local" - see CredentialMeta in @solace/shared. */
  baseUrl?: string,
  connectionName?: string,
): CredentialMeta {
  const all = loadAll(workspaceRoot);
  const entry: StoredCredential = {
    id: nanoid(),
    provider,
    label: label || "unlabeled",
    createdAt: new Date().toISOString(),
    key: rawKey?.trim() ?? "",
    // Trailing slashes would produce "https://host/v1//chat/completions"; normalise once here
    // rather than at every call site.
    baseUrl: baseUrl?.trim().replace(/\/+$/, "") || undefined,
    connectionName: connectionName?.trim() || undefined,
  };
  all.push(entry);
  saveAll(workspaceRoot, all);
  return toMeta(entry);
}

export function deleteCredential(workspaceRoot: string, id: string): boolean {
  const all = loadAll(workspaceRoot);
  const next = all.filter((c) => c.id !== id);
  if (next.length === all.length) return false;
  saveAll(workspaceRoot, next);
  return true;
}

/** Server-internal only - resolves a credentialId to its raw key + (for a "custom"
 * connection) base URL right before an API call, in one file read. Every turn for an
 * API-key agent needs both, and they were previously two separate exported functions each
 * independently re-reading and re-parsing the whole credentials file - cheap in isolation,
 * but pure waste on the hot path of every single chat turn. Never exposed through any route. */
export function getCredentialSecrets(workspaceRoot: string, id: string): { key?: string; baseUrl?: string } {
  const found = loadAll(workspaceRoot).find((c) => c.id === id);
  return { key: found?.key, baseUrl: found?.baseUrl };
}

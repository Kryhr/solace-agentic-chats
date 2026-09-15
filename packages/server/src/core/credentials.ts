import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { nanoid } from "nanoid";
import type {
  ApiKeyCredentialMeta,
  CredentialMeta,
  ProviderId,
  SshCredentialMeta,
  SshTargetMeta,
} from "@solace/shared";

type StoredApiKeyCredential = ApiKeyCredentialMeta & {
  /** The actual API key. Never returned from listCredentials() or any GET route - only
   * getCredentialSecrets() (server-internal, used right before an API call) can see it. */
  key: string;
};

type StoredSshCredential = SshCredentialMeta & {
  /** Only set when the user explicitly pasted key material instead of pointing at a key
   * file. Pointing at a file is the default because the file already has the permissions
   * the user chose for it; a copy in here inherits only what saveAll() can manage. */
  privateKey?: string;
  /** Passphrase for the referenced/stored key, if the user supplied one. */
  passphrase?: string;
};

type StoredCredential = StoredApiKeyCredential | StoredSshCredential;

/**
 * Raw secrets live in their own file, separate from .solace-state.json, and - like that
 * file - outside the git repo entirely (WORKSPACE_ROOT is ~/Desktop/solace-workspace by
 * default), so there's nothing to .gitignore: it's simply never inside a directory git
 * tracks. Metadata (id/kind/label/connection details) is what the client ever sees; a
 * secret only ever travels from the browser once (POST /api/credentials) and from this
 * file into an outgoing API request - never back out to any client.
 */
function credentialsPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".solace-credentials.json");
}

/**
 * Owner-only, because this file is plaintext JSON holding live API keys (and possibly SSH
 * key material). `mode` is honoured on POSIX; on Windows Node maps it onto the read-only
 * attribute alone and every other local account still gets whatever the parent directory's
 * ACL grants - hardenWindowsAcl() below is what actually narrows it there.
 */
export const CREDENTIALS_FILE_MODE = 0o600;

/** Exported so a test can assert the write options rather than the resulting stat mode,
 * which is meaningless on Windows (see CREDENTIALS_FILE_MODE). */
export function credentialsWriteOptions(): { encoding: "utf-8"; mode: number } {
  return { encoding: "utf-8", mode: CREDENTIALS_FILE_MODE };
}

/** Result of the last ACL attempt, so the UI/report can be honest about what protection
 * this file actually has rather than implying 0600 semantics on Windows. */
export interface CredentialsFileProtection {
  path: string;
  /** chmod succeeded (real owner-only bits on POSIX; read-only bit only on Windows). */
  modeApplied: boolean;
  /** win32 only: icacls narrowed the DACL to this user. false with a reason on failure. */
  aclRestricted?: boolean;
  detail?: string;
}

let lastProtection: CredentialsFileProtection | undefined;

export function getCredentialsFileProtection(): CredentialsFileProtection | undefined {
  return lastProtection;
}

/**
 * Windows ignores POSIX mode bits, so a 0o600 write there still leaves the file readable by
 * any other account the directory's inherited ACL allows. icacls is built into Windows, so
 * dropping inheritance and granting only this user is doable without shipping a dependency -
 * but it can still fail (domain accounts, redirected profiles, a locked file), and when it
 * does we record the failure instead of pretending the file is protected.
 */
function hardenFilePermissions(path: string) {
  const protection: CredentialsFileProtection = { path, modeApplied: false };
  try {
    // Applied on every save, not just creation: `mode` in writeFileSync only takes effect
    // when the file is created, so a file written before this existed would otherwise keep
    // its original permissions forever.
    chmodSync(path, CREDENTIALS_FILE_MODE);
    protection.modeApplied = true;
  } catch (err) {
    protection.detail = `chmod failed: ${(err as Error).message}`;
  }

  if (process.platform === "win32") {
    try {
      const { username } = userInfo();
      execFileSync("icacls", [path, "/inheritance:r", "/grant:r", `${username}:F`], {
        stdio: "ignore",
        timeout: 5000,
        windowsHide: true,
      });
      protection.aclRestricted = true;
    } catch (err) {
      protection.aclRestricted = false;
      protection.detail = `icacls could not restrict this file's ACL (${(err as Error).message}); it is still readable by any account the parent directory grants access to`;
    }
  }
  lastProtection = protection;
}

/** Legacy records predate `kind` and are all API keys - anything without a discriminator
 * has a `key` and a `provider` and nothing else, so reading it as "api-key" is not a guess. */
function normalizeKind(raw: unknown): StoredCredential {
  const record = raw as Record<string, unknown>;
  return (record.kind ? record : { ...record, kind: "api-key" }) as unknown as StoredCredential;
}

function loadAll(workspaceRoot: string): StoredCredential[] {
  const path = credentialsPath(workspaceRoot);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeKind);
  } catch {
    return [];
  }
}

function saveAll(workspaceRoot: string, all: StoredCredential[]) {
  const path = credentialsPath(workspaceRoot);
  writeFileSync(path, JSON.stringify(all), credentialsWriteOptions());
  hardenFilePermissions(path);
}

/** Every field of a stored record that is secret, whatever its kind. Listed in one place so
 * that adding a new secret field and forgetting to redact it is a compile error below. */
const SECRET_FIELDS = ["key", "privateKey", "passphrase"] as const;

function secretValuesOf(c: StoredCredential): string[] {
  const record = c as unknown as Record<string, unknown>;
  return SECRET_FIELDS.map((f) => record[f]).filter((v): v is string => typeof v === "string" && v.length > 0);
}

/**
 * The redaction boundary. Two independent mechanisms, because an allowlist alone silently
 * stops covering a field somebody adds later:
 *  1. the returned object is built field by field per kind - nothing is spread in, so a new
 *     stored field is invisible here until somebody deliberately adds it;
 *  2. the result is then serialized and checked against the record's actual secret values,
 *     so if step 1 is ever broken the call throws instead of returning a leaked secret.
 * Failing closed here means GET /api/credentials errors rather than serving key material.
 */
function toMeta(c: StoredCredential): CredentialMeta {
  const meta: CredentialMeta =
    c.kind === "ssh"
      ? {
          kind: "ssh",
          id: c.id,
          label: c.label,
          createdAt: c.createdAt,
          ssh: {
            host: c.ssh.host,
            port: c.ssh.port,
            username: c.ssh.username,
            privateKeyPath: c.ssh.privateKeyPath,
            knownHostsPath: c.ssh.knownHostsPath,
            hasStoredKeyMaterial: c.ssh.hasStoredKeyMaterial,
          },
        }
      : {
          kind: "api-key",
          id: c.id,
          provider: c.provider,
          label: c.label,
          createdAt: c.createdAt,
          baseUrl: c.baseUrl,
          connectionName: c.connectionName,
        };

  const serialized = JSON.stringify(meta);
  for (const secret of secretValuesOf(c)) {
    // Very short secrets are skipped: a 3-character "key" could collide with a substring of
    // a label and brick the whole list for no security benefit. Nothing a real provider or
    // SSH key issues is that short.
    if (secret.length >= 6 && serialized.includes(secret)) {
      throw new Error(`refusing to serve credential ${c.id}: redaction failed`);
    }
  }
  return meta;
}

export function listCredentials(workspaceRoot: string): CredentialMeta[] {
  return loadAll(workspaceRoot).map(toMeta);
}

export function saveCredential(
  workspaceRoot: string,
  provider: ProviderId,
  label: string,
  rawKey: string,
  /** Both only meaningful for provider "custom" - see CredentialMeta in @solace/shared. */
  baseUrl?: string,
  connectionName?: string,
): CredentialMeta {
  const all = loadAll(workspaceRoot);
  const entry: StoredApiKeyCredential = {
    kind: "api-key",
    id: nanoid(),
    provider,
    label: label || "unlabeled",
    createdAt: new Date().toISOString(),
    key: rawKey,
    // Trailing slashes would produce "https://host/v1//chat/completions"; normalise once here
    // rather than at every call site.
    baseUrl: baseUrl?.trim().replace(/\/+$/, "") || undefined,
    connectionName: connectionName?.trim() || undefined,
  };
  all.push(entry);
  saveAll(workspaceRoot, all);
  return toMeta(entry);
}

export interface SshCredentialInput {
  label: string;
  host: string;
  username: string;
  port?: number;
  /** Path to an existing private key file. Preferred over privateKey below. */
  privateKeyPath?: string;
  knownHostsPath?: string;
  /** Pasted key material. Only used when privateKeyPath is absent. */
  privateKey?: string;
  passphrase?: string;
}

/** `~/.ssh/id_ed25519` is how people actually write key paths; resolve it here so the
 * existence check below tests the same file ssh itself would open. */
export function resolveKeyPath(raw: string): string {
  const trimmed = raw.trim().replace(/^"(.*)"$/, "$1");
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) return join(homedir(), trimmed.slice(2));
  return normalize(trimmed);
}

/** Honest, specific failure text - a path that is missing and a path that is a directory are
 * different mistakes, and "invalid key" would send the user looking in the wrong place. Never
 * includes anything but the path the user themselves typed. */
export function validateKeyPath(raw: string, what: string): { path: string } | { error: string } {
  const path = resolveKeyPath(raw);
  if (!path) return { error: `${what} is required` };
  if (!isAbsolute(path)) return { error: `${what} must be an absolute path (got "${raw}")` };
  if (!existsSync(path)) return { error: `no file exists at ${path}` };
  try {
    if (!statSync(path).isFile()) return { error: `${path} is not a file` };
  } catch (err) {
    return { error: `could not read ${path}: ${(err as Error).message}` };
  }
  return { path };
}

export function validateSshInput(input: SshCredentialInput): { error: string } | { ssh: SshTargetMeta } {
  const host = input.host?.trim();
  const username = input.username?.trim();
  if (!host) return { error: "host is required" };
  if (!username) return { error: "username is required" };

  const port = input.port ?? 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: "port must be a whole number from 1 to 65535" };

  const ssh: SshTargetMeta = { host, port, username };

  if (input.privateKeyPath?.trim()) {
    const result = validateKeyPath(input.privateKeyPath, "private key path");
    if ("error" in result) return result;
    ssh.privateKeyPath = result.path;
  } else if (input.privateKey?.trim()) {
    ssh.hasStoredKeyMaterial = true;
  } else {
    return { error: "point at a private key file on this machine, or paste key material" };
  }

  if (input.knownHostsPath?.trim()) {
    const result = validateKeyPath(input.knownHostsPath, "known_hosts path");
    if ("error" in result) return result;
    ssh.knownHostsPath = result.path;
  }

  return { ssh };
}

/** Throws with a plain-language reason on invalid input. The thrown message is built from
 * named fields only - never from the raw request body - so a mistyped key can't end up in a
 * 400 response, a log line or a chat message. */
export function saveSshCredential(workspaceRoot: string, input: SshCredentialInput): CredentialMeta {
  const validated = validateSshInput(input);
  if ("error" in validated) throw new Error(validated.error);

  const entry: StoredSshCredential = {
    kind: "ssh",
    id: nanoid(),
    label: input.label?.trim() || `${validated.ssh.username}@${validated.ssh.host}`,
    createdAt: new Date().toISOString(),
    ssh: validated.ssh,
    privateKey: validated.ssh.hasStoredKeyMaterial ? input.privateKey : undefined,
    passphrase: input.passphrase?.trim() || undefined,
  };
  const all = loadAll(workspaceRoot);
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

/** Non-secret SSH targets, for the one thing an agent needs: knowing a deploy target exists
 * and what to put on its own ssh command line. Goes through toMeta like every other read, so
 * it cannot return key material even if this function is later called from somewhere new. */
export function listSshCredentials(workspaceRoot: string): SshCredentialMeta[] {
  return listCredentials(workspaceRoot).filter((c): c is SshCredentialMeta => c.kind === "ssh");
}

/** Server-internal only - resolves a credentialId to its raw key + (for a "custom"
 * connection) base URL right before an API call, in one file read. Every turn for an
 * API-key agent needs both, and they were previously two separate exported functions each
 * independently re-reading and re-parsing the whole credentials file - cheap in isolation,
 * but pure waste on the hot path of every single chat turn. Never exposed through any route. */
export function getCredentialSecrets(workspaceRoot: string, id: string): { key?: string; baseUrl?: string } {
  const found = loadAll(workspaceRoot).find((c) => c.id === id);
  // An SSH record has no API key; returning anything for one would mean an agent pointed at a
  // deploy target by mistake starts sending SSH material as an Authorization header.
  if (!found || found.kind === "ssh") return {};
  return { key: found.key, baseUrl: found.baseUrl };
}

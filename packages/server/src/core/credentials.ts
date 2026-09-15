import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { nanoid } from "nanoid";
import type {
  ApiKeyCredentialMeta,
  CredentialMeta,
  CredentialReveal,
  LoginCredentialMeta,
  ProviderId,
  RevealedField,
  SecretCredentialMeta,
  SshCredentialMeta,
  SshTargetMeta,
  TrustLevel,
} from "@solace/shared";

type StoredApiKeyCredential = ApiKeyCredentialMeta & {
  /** The actual API key, or "" for a keyless connection (a local model server usually has no
   * key at all - see adapters/custom-api.ts, which sends no Authorization header when this is
   * empty). Never returned from listCredentials() or any GET route - only
   * getCredentialSecrets() (server-internal, used right before an API call) can see it. */
  key: string;
};

type StoredSshCredential = SshCredentialMeta & {
  /** Only set when the user explicitly pasted key material instead of pointing at a key
   * file. Pointing at a file is the default because the file already has the permissions
   * the user chose for it; a copy in here inherits only what saveAll() can manage. */
  privateKey?: string;
  /**
   * Passphrase for the referenced/stored key, if the user supplied one.
   *
   * Storing this next to `ssh.privateKeyPath` is the weakest combination in the whole store:
   * the passphrase is the only thing protecting the key file being pointed at, so anyone who
   * can read this JSON gets both halves, and the file-permission argument for referencing a
   * key by path rather than copying it stops applying. It is kept rather than dropped because
   * the vault's job is to hold what the user needs to sign in later and a passphrase is
   * exactly that - but it is now a first-class secret: in SECRET_FIELDS, redacted by toMeta,
   * flagged as present via ssh.hasPassphrase so the user can SEE that Solace has it, and
   * warned about at the point it is typed.
   */
  passphrase?: string;
};

type StoredLoginCredential = LoginCredentialMeta & {
  password?: string;
  /** TOTP seed or backup codes, as free text - people keep these in wildly different shapes
   * (a base32 seed, ten numbered codes, an otpauth:// URL) and normalizing them would mean
   * rejecting whichever form the user's provider actually gave them. */
  totpSecret?: string;
};

type StoredSecretCredential = SecretCredentialMeta & {
  value?: string;
};

type StoredCredential =
  | StoredApiKeyCredential
  | StoredSshCredential
  | StoredLoginCredential
  | StoredSecretCredential;

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
const SECRET_FIELDS = ["key", "privateKey", "passphrase", "password", "totpSecret", "value"] as const;

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
  let meta: CredentialMeta;
  switch (c.kind) {
    case "ssh":
      meta = {
        kind: "ssh",
        id: c.id,
        label: c.label,
        createdAt: c.createdAt,
        notes: c.notes,
        ssh: {
          host: c.ssh.host,
          port: c.ssh.port,
          username: c.ssh.username,
          privateKeyPath: c.ssh.privateKeyPath,
          knownHostsPath: c.ssh.knownHostsPath,
          hasStoredKeyMaterial: c.ssh.hasStoredKeyMaterial,
          // Derived from the stored secret, never trusted from the record's own flag: a
          // hand-edited file claiming hasPassphrase:false while holding one would otherwise
          // hide it from the only screen that could tell the user it exists.
          hasPassphrase: Boolean(c.passphrase) || undefined,
        },
      };
      break;
    case "login":
      meta = {
        kind: "login",
        id: c.id,
        label: c.label,
        createdAt: c.createdAt,
        notes: c.notes,
        service: c.service,
        username: c.username,
        hasPassword: Boolean(c.password),
        hasTotp: Boolean(c.totpSecret),
      };
      break;
    case "secret":
      meta = {
        kind: "secret",
        id: c.id,
        label: c.label,
        createdAt: c.createdAt,
        notes: c.notes,
        hasValue: Boolean(c.value),
      };
      break;
    default:
      meta = {
        kind: "api-key",
        id: c.id,
        provider: c.provider,
        label: c.label,
        createdAt: c.createdAt,
        notes: c.notes,
        baseUrl: c.baseUrl,
        connectionName: c.connectionName,
        hasKey: Boolean(c.key),
      };
  }

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
  /** Empty for a keyless connection - see StoredCredential.key. */
  rawKey: string,
  /** Both only meaningful for providers "custom" and "local" - see CredentialMeta in @solace/shared. */
  baseUrl?: string,
  connectionName?: string,
  notes?: string,
): CredentialMeta {
  const all = loadAll(workspaceRoot);
  const entry: StoredApiKeyCredential = {
    kind: "api-key",
    id: nanoid(),
    provider,
    label: label || "unlabeled",
    createdAt: new Date().toISOString(),
    notes: notes?.trim() || undefined,
    key: rawKey?.trim() ?? "",
    // Trailing slashes would produce "https://host/v1//chat/completions"; normalise once here
    // rather than at every call site.
    baseUrl: baseUrl?.trim().replace(/\/+$/, "") || undefined,
    connectionName: connectionName?.trim() || undefined,
  };
  assertNotesCarryNoSecret(entry);
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
  /** Pasted key material. Supplying this AND privateKeyPath is refused, not silently
   * resolved in favour of one of them - see validateSshInput. */
  privateKey?: string;
  passphrase?: string;
  notes?: string;
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

  const hasPath = Boolean(input.privateKeyPath?.trim());
  const hasMaterial = Boolean(input.privateKey?.trim());
  // Refused rather than resolved in favour of the path. The previous version took the path
  // and dropped the pasted key silently, with no error and no flag, so a user who filled in
  // both came away believing their key was saved when only a reference to a different file
  // had been. Silently discarding typed key material is the one outcome that leaves the user
  // wrong about what the store holds.
  if (hasPath && hasMaterial) {
    return {
      error:
        "you supplied both a private key path and pasted key material - keep one. Referencing the key file is preferred; clear the pasted text to use it, or clear the path to store the pasted key instead",
    };
  }

  if (hasPath) {
    const result = validateKeyPath(input.privateKeyPath!, "private key path");
    if ("error" in result) return result;
    ssh.privateKeyPath = result.path;
  } else if (hasMaterial) {
    ssh.hasStoredKeyMaterial = true;
  } else {
    return { error: "point at a private key file on this machine, or paste key material" };
  }

  if (input.passphrase?.trim()) ssh.hasPassphrase = true;

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
    notes: input.notes?.trim() || undefined,
    ssh: validated.ssh,
    privateKey: validated.ssh.hasStoredKeyMaterial ? input.privateKey : undefined,
    passphrase: input.passphrase?.trim() || undefined,
  };
  assertNotesCarryNoSecret(entry);
  const all = loadAll(workspaceRoot);
  all.push(entry);
  saveAll(workspaceRoot, all);
  return toMeta(entry);
}

/**
 * `notes` is shown in the list, so a note containing the entry's own secret verbatim would
 * make toMeta throw and take the whole Connections panel down with it (fail-closed doing
 * exactly its job, but at the worst possible moment). Catching it here turns that into one
 * clear message at the point the user typed it, and keeps the scan in toMeta as the backstop
 * for records that arrive some other way - a hand-edited file, a future writer.
 */
function assertNotesCarryNoSecret(entry: StoredCredential) {
  const notes = entry.notes;
  if (!notes) return;
  for (const secret of secretValuesOf(entry)) {
    if (secret.length >= 6 && notes.includes(secret)) {
      throw new Error("the notes field contains this entry's own secret - notes are shown in the list, so keep the secret in its own field");
    }
  }
}

export interface LoginCredentialInput {
  label: string;
  /** URL or plain service name - whatever the user is actually signing into. */
  service: string;
  username: string;
  password?: string;
  totpSecret?: string;
  notes?: string;
}

/** A service sign-in. `password` is optional because magic-link and SSO logins are real and
 * an entry recording "this is the account I use" is still worth having; hasPassword in the
 * metadata is what stops that being confused with a reveal that returned nothing. */
export function saveLoginCredential(workspaceRoot: string, input: LoginCredentialInput): CredentialMeta {
  const service = input.service?.trim();
  const username = input.username?.trim();
  if (!service) throw new Error("service (a URL or a name) is required");
  if (!username) throw new Error("username is required");

  const entry: StoredLoginCredential = {
    kind: "login",
    id: nanoid(),
    label: input.label?.trim() || service,
    createdAt: new Date().toISOString(),
    notes: input.notes?.trim() || undefined,
    service,
    username,
    hasPassword: Boolean(input.password?.trim()),
    hasTotp: Boolean(input.totpSecret?.trim()),
    password: input.password?.trim() || undefined,
    totpSecret: input.totpSecret?.trim() || undefined,
  };
  assertNotesCarryNoSecret(entry);
  const all = loadAll(workspaceRoot);
  all.push(entry);
  saveAll(workspaceRoot, all);
  return toMeta(entry);
}

export interface SecretCredentialInput {
  label: string;
  value: string;
  notes?: string;
}

/** The catch-all kind: a token, a licence key, a recovery code, anything the user wants held
 * under the same file protection as the rest. A value IS required here - unlike a login,
 * an entry of this kind with nothing in it records nothing at all. */
export function saveSecretCredential(workspaceRoot: string, input: SecretCredentialInput): CredentialMeta {
  const label = input.label?.trim();
  const value = input.value?.trim();
  if (!label) throw new Error("a label is required so you can find this again");
  if (!value) throw new Error("a secret value is required");

  const entry: StoredSecretCredential = {
    kind: "secret",
    id: nanoid(),
    label,
    createdAt: new Date().toISOString(),
    notes: input.notes?.trim() || undefined,
    hasValue: true,
    value,
  };
  assertNotesCarryNoSecret(entry);
  const all = loadAll(workspaceRoot);
  all.push(entry);
  saveAll(workspaceRoot, all);
  return toMeta(entry);
}

/**
 * The ONE function in this file that deliberately returns real secret values, and the only
 * thing behind POST /api/credentials/:id/reveal. Everything else about the store is built so
 * that a secret cannot travel outward by accident; this is the single place where it travels
 * outward on purpose, which is why it:
 *  - takes exactly one id and has no list/bulk form. There is no code path that reveals two
 *    entries in one call, so nothing can ever "reveal everything" by passing a wildcard;
 *  - does not go through toMeta, and toMeta is not weakened to accommodate it. The redaction
 *    boundary still holds for every other read;
 *  - returns undefined for an unknown id rather than throwing with the id echoed anywhere.
 *
 * Callers must not log the result. The route and the MCP bridge both handle it as a value to
 * pass straight through, never to interpolate into a log line, an error, or a chat message.
 */
export function revealCredential(workspaceRoot: string, id: string): CredentialReveal | undefined {
  const found = loadAll(workspaceRoot).find((c) => c.id === id);
  if (!found) return undefined;

  const fields: RevealedField[] = [];
  switch (found.kind) {
    case "ssh":
      if (found.privateKey) fields.push({ name: "private key", value: found.privateKey });
      if (found.passphrase) {
        fields.push({
          name: "key passphrase",
          value: found.passphrase,
          note: found.ssh.privateKeyPath
            ? `unlocks ${found.ssh.privateKeyPath}. Both the path and this passphrase are in Solace's own plaintext file, so anyone who can read that file has both halves.`
            : "unlocks the key material stored in Solace.",
        });
      }
      break;
    case "login":
      if (found.password) fields.push({ name: "password", value: found.password });
      if (found.totpSecret) fields.push({ name: "TOTP / backup codes", value: found.totpSecret });
      break;
    case "secret":
      if (found.value) fields.push({ name: "secret", value: found.value });
      break;
    default:
      // A keyless connection (a local model server) legitimately has no key - that yields an
      // empty field list, not an error, and the UI says "nothing stored" rather than implying
      // the reveal failed.
      if (found.key) fields.push({ name: "API key", value: found.key });
  }

  return { id: found.id, kind: found.kind ?? "api-key", label: found.label, fields };
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
  // Only an api-key record has an API key. Checked as an allowlist rather than "not ssh",
  // because the exclusion list silently stopped covering everything the moment login/secret
  // kinds existed - an agent mistakenly pointed at a saved password would otherwise start
  // sending it as an Authorization header to whatever endpoint it was configured with.
  if (!found || found.kind !== "api-key") return {};
  return { key: found.key, baseUrl: found.baseUrl };
}

/**
 * Whether an agent at this trust level may pull a secret out of the vault.
 *
 * "plan" is the level a user picks when they want the agent to think and not act - it cannot
 * run a command, so it has nothing legitimate to sign into, and handing it a live credential
 * would quietly make the weakest trust level the one with the most reach. Split out of the
 * route so the rule is a testable fact rather than a branch inside an HTTP handler, and so a
 * second caller cannot re-implement it slightly differently.
 */
export function canReadVaultAtTrustLevel(trustLevel: TrustLevel): boolean {
  return trustLevel !== "plan";
}

/** Resolve the label an agent (or a slash command) typed to exactly one entry. Case- and
 * whitespace-insensitive because the label is something a human typed twice, in two places.
 * Returns the metadata only - getting the secret is a separate, audited step. */
export function findCredentialByLabel(workspaceRoot: string, labelOrId: string): CredentialMeta | undefined {
  const wanted = labelOrId.trim().toLowerCase();
  if (!wanted) return undefined;
  const all = listCredentials(workspaceRoot);
  return all.find((c) => c.id === labelOrId.trim()) ?? all.find((c) => c.label.trim().toLowerCase() === wanted);
}

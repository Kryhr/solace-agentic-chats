import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderId } from "@solace/shared";
import { spawnCli } from "./spawnCli";

/**
 * Running several accounts of the same provider at once.
 *
 * The problem, which is the same for every CLI here: it keeps ONE set of credentials in one
 * place, so signing into a second account overwrites the first and silently signs it out.
 * Anyone with two subscriptions discovers this by losing the login they were using.
 *
 * The fix is per-provider but always the same shape: an environment variable that relocates the
 * directory the CLI derives its credentials from. One directory per account is two independent
 * logins, and neither can evict the other.
 *
 * An account here is only a LABEL the user picks. Solace maps it to a directory it owns and
 * hands that to the CLI as an env var. It never reads, writes, copies or inspects the
 * credentials inside - it only decides which folder the CLI is pointed at.
 *
 * **Solace cannot sign anyone in.** That is a browser or device flow the user performs; this
 * module's job ends at handing over the exact command with the variable already set, so the
 * login lands in the new directory instead of on top of the account in use.
 *
 * Every entry below was verified against the real binary. A provider is absent unless there was
 * evidence, because a guess here fails silently and expensively: an invented variable is ignored
 * by the CLI, both agents quietly share one login, and the UI claims they are separate while one
 * subscription takes all the load.
 */

/**
 * Overridable so tests never write into a real home directory.
 *
 * They did once: the unit tests called accountEnv("claude-code", "work"), which creates the
 * directory it names, and "work" and "personal" then appeared in the operator's own account
 * picker as phantom logins.
 */
function accountsRoot(): string {
  return process.env.SOLACE_ACCOUNTS_ROOT ?? join(homedir(), ".solace", "accounts");
}

/**
 * The variable that relocates each CLI's credential storage.
 *
 * Absent providers, and exactly why - these are findings, not omissions:
 *
 *  - **copilot-cli**: `COPILOT_HOME` is real and documented, but it moves config and state ONLY.
 *    The token lives in the Windows credential store under a fixed target, which every
 *    COPILOT_HOME shares. Proven live: with COPILOT_HOME pointed at an empty directory and no
 *    token variables set, a real turn still authenticated and spent credits, and a hand-written
 *    config naming another account was rewritten and ignored. `COPILOT_GITHUB_TOKEN` is
 *    documented to take precedence but was silently ignored in favour of the stored login -
 *    silent fallback to a shared account is precisely what this module exists to prevent.
 *  - **continue**: there is no login to isolate. Its own bundled source says Hub/WorkOS
 *    authentication has been removed, `loadAuthConfig()` returns null unconditionally, and
 *    `login()` throws. Continue reaches a model through API keys in config.yaml, so there is no
 *    second subscription for a second login to evict. `CONTINUE_GLOBAL_DIR` does relocate its
 *    directory, but pointing an agent at an empty one only strips it of the config that lets it
 *    reach a model at all.
 *  - **crush**: unverifiable without performing a login. `crush dirs` confirms
 *    CRUSH_GLOBAL_CONFIG / CRUSH_GLOBAL_DATA relocate, and its schema puts `api_key`/`oauth`
 *    inside the provider config - but no credential file exists on the probe machine, so there
 *    was nothing to contrast against. Unverified stays unimplemented.
 */
const CONFIG_DIR_ENV: Partial<Record<ProviderId, string>> = {
  /**
   * Verified live (claude 2.1.272). Pointed at an empty directory, `claude auth status` returned
   * {"loggedIn": false, "authMethod": "none"} and moved its projects directory with it, while
   * ~/.claude/.credentials.json was byte-identical before and after.
   */
  "claude-code": "CLAUDE_CONFIG_DIR",
  /**
   * Verified live (codex-cli 0.149.0). Credentials are a single `<CODEX_HOME>/auth.json`.
   *   CODEX_HOME=<empty>  codex login status  ->  "Not logged in"
   *                       codex login status  ->  "Logged in using ChatGPT"
   * and `codex doctor --json` named the relocated auth file with "auth storage mode": "File".
   * Caveat, read not verified: the binary carries keyring strings and an auth_storage flag. If a
   * user moves credentials into the OS keyring, per-account homes would likely stop separating.
   */
  "codex-cli": "CODEX_HOME",
  /**
   * Verified live. Kimi's own resolver is
   * `homeDir ?? env["KIMI_CODE_HOME"] ?? join(osHomeDir, ".kimi-code")` and its token store is
   * `join(homeDir, "credentials")` - so this moves credentials, not merely settings. Driving
   * `kimi acp` over stdio: with the variable at an empty temp dir, session/new answered
   * {"code":-32000,"message":"Authentication required"}; without it, a real session was minted.
   * Kimi's own ACP handshake advertises terminal-auth carrying this same variable.
   */
  kimi: "KIMI_CODE_HOME",
  /**
   * Directory relocation verified live (`qwen -l` read and wrote in the override, naming the
   * relocated path in its own error). That credentials ride along is read from source, not
   * demonstrated: getGlobalQwenDir() honours QWEN_HOME and the credential path is
   * join(getGlobalQwenDir(), "oauth_creds.json") - one resolver - but qwen is not signed in on
   * the probe machine, so signed-in-vs-signed-out could not be shown.
   */
  "qwen-code": "QWEN_HOME",
  /**
   * Verified live that this replaces the home Gemini derives everything from: its "Please set an
   * Auth method in <path>/settings.json" named the relocated path, and it created its directory
   * tree there. NOTE it is a HOME, not the config dir - the CLI appends `.gemini` itself, which
   * is why providerConfigDir() exists below.
   *
   * Insufficient on its own. OAuth credentials go to the OS keychain by default under a FIXED
   * service name, which no home override touches - so GEMINI_FORCE_FILE_STORAGE is required too
   * (see EXTRA_ACCOUNT_ENV). Confirmed live that the native keychain really is the default here.
   */
  "gemini-cli": "GEMINI_CLI_HOME",
  /**
   * Verified live (opencode 1.18.31). Credentials are auth.json in the DATA directory, not the
   * config directory - which is why the obvious variables do not work:
   *   (none)                -> ~/.local/share/opencode/auth.json   1 credentials
   *   XDG_DATA_HOME=<empty> -> <temp>/opencode/auth.json           0 credentials
   *   OPENCODE_CONFIG_DIR   -> ~/.local/share/opencode/auth.json   1 credentials  (settings only)
   *   XDG_CONFIG_HOME       -> ~/.local/share/opencode/auth.json   1 credentials  (settings only)
   *
   * Two consequences worth knowing. XDG_DATA_HOME is a GENERIC variable, so anything else the
   * agent spawns during a turn inherits it; broader than the others here. And the data directory
   * also holds opencode.db, so SESSIONS are per-account - moving an existing agent onto an
   * account loses its resumable history, the same property Claude's relocated projects dir has.
   */
  opencode: "XDG_DATA_HOME",
  /**
   * Kilo is an OpenCode fork and takes the same variable; `kilo auth list` reported a relocated
   * credentials path in the same format. Stated precisely: Kilo had zero credentials on the
   * probe machine, so the signed-in -> signed-out transition is OpenCode's, through the
   * identical fork code path, not Kilo's own.
   */
  kilo: "XDG_DATA_HOME",
  /**
   * Path relocation verified live (droid 0.220.0): `droid doctor --json` reported
   * "factoryDir": "<override>/.factory" and recreated its whole tree there. Like Gemini's, this
   * is a HOME override - droid appends `.factory` itself.
   *
   * That the LOGIN lands there is read from the binary, not demonstrated - droid is not signed
   * in on the probe machine. Only the AES key sits in the OS keyring; the encrypted credentials
   * are per-directory, and a shared key is not a shared identity.
   *
   * FACTORY_API_KEY is deliberately NOT used as the mechanism. It works - `droid doctor --auth`
   * says verbatim "using FACTORY_API_KEY (overrides any stored login session)" - but it is a
   * plaintext long-lived key in every child process's environment, and one such key in the
   * server's own environment would silently override EVERY account directory and put all agents
   * on one subscription.
   */
  droid: "FACTORY_HOME_OVERRIDE",
};

/**
 * Additional variables an account needs beyond the directory override.
 *
 * Only Gemini needs one, and it is not optional: without it the CLI writes OAuth credentials to
 * a machine-wide keychain entry under a fixed service name, so every "account" would share one
 * login while appearing separate. Spread into the sign-in command too, or the sign-in itself
 * lands in the keychain.
 */
const EXTRA_ACCOUNT_ENV: Partial<Record<ProviderId, Record<string, string>>> = {
  "gemini-cli": { GEMINI_FORCE_FILE_STORAGE: "true" },
};

/**
 * Where a CLI puts its files INSIDE the directory we hand it.
 *
 * Gemini and Droid take a HOME and append their own folder; everything else treats the value as
 * the config directory itself. This matters only for reading an account's state off disk.
 */
function providerConfigDir(provider: ProviderId, dir: string): string {
  if (provider === "gemini-cli") return join(dir, ".gemini");
  if (provider === "droid") return join(dir, ".factory");
  return dir;
}

/** The command that signs an account in, per provider. Absent where the CLI has no such command. */
const SIGN_IN_COMMAND: Partial<Record<ProviderId, { command?: string; note?: string }>> = {
  "claude-code": { command: "claude auth login" },
  "codex-cli": { command: "codex login" },
  kimi: { command: "kimi login" },
  opencode: { command: "opencode auth login" },
  kilo: { command: "kilo auth login" },
  // `qwen auth` is listed "(removed)" in its own help; sign-in is the /auth slash command inside
  // the session. Printing `qwen login` would be printing a command that does not exist.
  "qwen-code": { command: "qwen", note: "then run /auth inside the session" },
  // Gemini has no auth subcommand at all.
  "gemini-cli": { command: "gemini", note: "then sign in from the session it opens" },
  // Signed-out `droid doctor` says verbatim: Run `droid` and complete the login flow.
  droid: { command: "droid", note: "then complete the login flow it opens" },
};

export function supportsMultipleAccounts(provider: ProviderId): boolean {
  return provider in CONFIG_DIR_ENV;
}

/** A label is a directory name, so it must not be able to climb out of the accounts root. */
export function isValidAccountLabel(label: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9 _-]{0,38}[A-Za-z0-9]$/.test(label) && !label.includes("..");
}

export function accountDir(provider: ProviderId, label: string): string {
  if (!isValidAccountLabel(label)) throw new Error(`"${label}" is not a valid account name`);
  return join(accountsRoot(), provider, label);
}

/**
 * The env additions that put this turn on the chosen account.
 *
 * An agent with no account named gets `{}` - it runs on the CLI's normal login, exactly as
 * before. That is the default and must stay the default: someone with one subscription should
 * never have to know this feature exists.
 */
export function accountEnv(provider: ProviderId, label: string | undefined): Record<string, string> {
  if (!label) return {};
  const varName = CONFIG_DIR_ENV[provider];
  if (!varName) return {};
  const dir = accountDir(provider, label);
  // Created if absent so the CLI has somewhere to write. An empty directory reads as "not signed
  // in", which is the honest state until the user completes the sign-in.
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return { [varName]: dir, ...(EXTRA_ACCOUNT_ENV[provider] ?? {}) };
}

/**
 * The exact command for the user to run in their own terminal to sign this account in.
 *
 * Handed over rather than run: this is a device login for a real subscription, and an app
 * completing that on somebody's behalf - or running it with the wrong environment and clobbering
 * their existing login - is exactly the failure this module exists to prevent.
 */
export function signInCommandFor(
  provider: ProviderId,
  label: string,
): { powershell: string; bash: string; note?: string } | undefined {
  const varName = CONFIG_DIR_ENV[provider];
  const signIn = SIGN_IN_COMMAND[provider];
  if (!varName || !signIn?.command) return undefined;
  const dir = accountDir(provider, label);
  const env: Record<string, string> = { [varName]: dir, ...(EXTRA_ACCOUNT_ENV[provider] ?? {}) };
  const ps = Object.entries(env)
    .map(([k, v]) => `$env:${k}="${v}"`)
    .join("; ");
  const sh = Object.entries(env)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
  return { powershell: `${ps}; ${signIn.command}`, bash: `${sh} ${signIn.command}`, note: signIn.note };
}

/**
 * Who a given account is, as far as its own CLI will say.
 *
 * Every field is copied from the CLI's own output. Where a CLI reports nothing, the account is
 * marked `identityUnknown` and the UI says "sign-in state not reported" rather than "not signed
 * in" - those are different claims, and showing the second for the first would tell a user their
 * working account was signed out.
 */
export interface AccountIdentity {
  /** The user's label, or undefined for the CLI's own default login. */
  label?: string;
  loggedIn: boolean;
  /** Straight from the CLI. Undefined when signed out, or when it does not say. */
  email?: string;
  /** e.g. "max", "team", "pro". The CLI's own word for it. */
  subscriptionType?: string;
  /** True when this CLI has no read-only way to report its sign-in state at all. */
  identityUnknown?: boolean;
  /** Present only when something went wrong, carrying the CLI's own words. */
  error?: string;
}

const STATUS_TIMEOUT_MS = 15_000;

/**
 * The read-only command that reports sign-in state, per provider.
 *
 * Only commands that spend NOTHING and change NOTHING belong here - this runs every time the
 * account picker opens. Kimi is deliberately absent: its only truthful auth signal is an ACP
 * session/new, which mints a session in the user's home on every refresh.
 */
const STATUS_COMMAND: Partial<Record<ProviderId, string[]>> = {
  "claude-code": ["auth", "status"],
  "codex-cli": ["login", "status"],
  opencode: ["auth", "list"],
  kilo: ["auth", "list"],
  droid: ["doctor", "--config", "--auth", "--json"],
};

/** The binary each provider id actually invokes. */
const BIN: Partial<Record<ProviderId, string>> = {
  "claude-code": "claude",
  "codex-cli": "codex",
  opencode: "opencode",
  kilo: "kilo",
  droid: "droid",
};

function parseStatus(provider: ProviderId, out: string): AccountIdentity {
  if (provider === "claude-code") {
    try {
      const json = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
      return {
        loggedIn: json.loggedIn === true,
        email: typeof json.email === "string" ? json.email : undefined,
        subscriptionType: typeof json.subscriptionType === "string" ? json.subscriptionType : undefined,
      };
    } catch {
      return { loggedIn: false };
    }
  }
  // `codex login status` prints "Logged in using ChatGPT" or "Not logged in". It has no --json,
  // and `codex doctor --json` calls itself redacted and carries no email or plan - so this is
  // sign-in state only, and nothing about identity is invented.
  if (provider === "codex-cli") return { loggedIn: /logged in using/i.test(out) };
  // `opencode auth list` / `kilo auth list` end with "N credentials".
  if (provider === "opencode" || provider === "kilo") {
    const m = out.match(/(\d+)\s+credentials?/i);
    return { loggedIn: m ? Number(m[1]) > 0 : false };
  }
  if (provider === "droid") {
    // Its doctor emits no identity at all, so sign-in state only.
    return { loggedIn: !/no stored login found|no usable credentials/i.test(out) && /"status"\s*:\s*"ok"/.test(out) };
  }
  return { loggedIn: false, identityUnknown: true };
}

function probeStatus(provider: ProviderId, dir?: string): Promise<AccountIdentity> {
  const bin = BIN[provider];
  const args = STATUS_COMMAND[provider];
  // No read-only probe exists for this CLI. Saying so is the honest answer; running its login or
  // minting a session to find out would cost the user something for a picker refresh.
  if (!bin || !args) return Promise.resolve({ loggedIn: false, identityUnknown: true });
  return new Promise((resolve) => {
    let out = "";
    const child = spawnCli(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: dir ? { ...process.env, ...accountEnvForDir(provider, dir) } : process.env,
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ loggedIn: false, error: `\`${bin} ${args.join(" ")}\` did not answer within ${STATUS_TIMEOUT_MS}ms` });
    }, STATUS_TIMEOUT_MS);
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (out += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ loggedIn: false, error: (err as Error).message });
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(parseStatus(provider, out));
    });
  });
}

/** The same variables accountEnv sets, for a directory that is already known. */
function accountEnvForDir(provider: ProviderId, dir: string): Record<string, string> {
  const varName = CONFIG_DIR_ENV[provider];
  if (!varName) return {};
  return { [varName]: dir, ...(EXTRA_ACCOUNT_ENV[provider] ?? {}) };
}

/**
 * Gemini has no auth-status command - starting it would open its UI or begin a sign-in - so its
 * state is read off disk instead, from the files the CLI itself writes.
 */
function geminiStatus(dir?: string): AccountIdentity {
  const base = dir ? providerConfigDir("gemini-cli", dir) : join(homedir(), ".gemini");
  // Written only when FileKeychain is in use, i.e. when GEMINI_FORCE_FILE_STORAGE was set for
  // the sign-in. Absent means the login went to the shared machine-wide keychain instead, which
  // is NOT an isolated account - reported as not-signed-in with a reason rather than as a
  // separate subscription.
  const credentials = join(base, "gemini-credentials.json");
  if (!existsSync(credentials)) {
    return dir
      ? { loggedIn: false, error: "No per-account credential file. Sign in using the command below so it is not stored machine-wide." }
      : { loggedIn: false, identityUnknown: true };
  }
  let email: string | undefined;
  try {
    const accounts = JSON.parse(readFileSync(join(base, "google_accounts.json"), "utf8"));
    if (typeof accounts?.active === "string") email = accounts.active;
  } catch {
    // No account file, or unreadable. The credential file is still the fact that matters.
  }
  return { loggedIn: true, email };
}

function statusFor(provider: ProviderId, dir?: string): Promise<AccountIdentity> {
  if (provider === "gemini-cli") return Promise.resolve(geminiStatus(dir));
  return probeStatus(provider, dir);
}

/** Every account for a provider: the CLI's own default first, then each labelled one. */
export async function listAccounts(provider: ProviderId): Promise<AccountIdentity[]> {
  if (!supportsMultipleAccounts(provider)) return [];
  const labels: string[] = [];
  const root = join(accountsRoot(), provider);
  try {
    if (existsSync(root)) {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory() && isValidAccountLabel(entry.name)) labels.push(entry.name);
      }
    }
  } catch {
    // An unreadable accounts root means no labelled accounts, not a failed request.
  }
  // Probed in parallel: each is a separate process, and in series the picker took
  // labels.length * up-to-15s to open.
  const [def, ...rest] = await Promise.all([
    statusFor(provider, undefined),
    ...labels.map((l) => statusFor(provider, accountDir(provider, l))),
  ]);
  return [def, ...rest.map((r, i) => ({ ...r, label: labels[i] }))];
}

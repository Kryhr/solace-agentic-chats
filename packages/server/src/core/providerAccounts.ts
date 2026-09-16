import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { spawnCli } from "./spawnCli";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderId } from "@solace/shared";

/**
 * Running two accounts of the same CLI at once.
 *
 * The problem: a coding CLI keeps ONE set of credentials in one place. Claude Code holds them
 * in `~/.claude/.credentials.json`, a single file - so signing into a second account overwrites
 * the first and silently signs it out. Anyone with two subscriptions who wants an agent on each
 * discovers this by losing the login they were using.
 *
 * The fix, verified live on 2026-09-16 against claude 2.1.272: `CLAUDE_CONFIG_DIR` relocates the
 * WHOLE config directory, not just one file. Pointed at an empty directory, `claude auth status`
 * answered `{"loggedIn": false, "authMethod": "none"}` with its projects directory moved there
 * too, while `~/.claude/.credentials.json` was left byte-for-byte identical. So two directories
 * are two independent logins, and neither can evict the other.
 *
 * An account here is just a LABEL the user picks. Solace maps it to a directory it owns and
 * hands that to the CLI as an env var. It never reads, writes, copies or inspects the
 * credentials inside - it only decides which folder the CLI is pointed at.
 *
 * **Solace cannot sign you in.** Signing in is a browser/device flow the user performs
 * themselves; this module's job ends at telling them the exact command to run, with the env var
 * already set, so the login lands in the right directory instead of over the top of their other
 * account. See `signInCommandFor`.
 */

/**
 * Everything Solace owns for multi-account lives under here, never inside the CLI's own dirs.
 *
 * Overridable so tests never write into a real home directory. They did once: the unit tests
 * called accountEnv("claude-code", "work"), which creates the directory, and "work" and
 * "personal" then showed up as phantom accounts in the operator's own UI.
 */
function accountsRoot(): string {
  return process.env.SOLACE_ACCOUNTS_ROOT ?? join(homedir(), ".solace", "accounts");
}

/**
 * Which env var relocates a given CLI's config, where one is known to exist.
 *
 * ONLY providers verified to honour one appear here. A guess would be worse than nothing: the
 * variable would be ignored, both agents would quietly share the same credentials, and the user
 * would believe they were on separate accounts while one subscription took all the load.
 */
const CONFIG_DIR_ENV: Partial<Record<ProviderId, string>> = {
  // Verified live: an empty dir yields loggedIn:false and moves projectsDirectory with it.
  "claude-code": "CLAUDE_CONFIG_DIR",
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
 * before. That is the default and it must stay the default: someone with one account should
 * never have to know this feature exists.
 */
export function accountEnv(provider: ProviderId, label: string | undefined): Record<string, string> {
  if (!label) return {};
  const varName = CONFIG_DIR_ENV[provider];
  if (!varName) return {};
  const dir = accountDir(provider, label);
  // Created if absent so the CLI has somewhere to write. An empty directory reads as
  // "not signed in", which is the honest state until the user completes the sign-in below.
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return { [varName]: dir };
}

/**
 * The exact command for the user to run in their own terminal to sign this account in.
 *
 * Deliberately a command handed over rather than something Solace runs: this is a browser
 * device-login for a real subscription, and an app completing that on someone's behalf - or
 * running it with the wrong env and clobbering their existing login - is exactly the failure
 * this module exists to prevent.
 */
export function signInCommandFor(provider: ProviderId, label: string): { powershell: string; bash: string } | undefined {
  const varName = CONFIG_DIR_ENV[provider];
  if (!varName) return undefined;
  const dir = accountDir(provider, label);
  const login = provider === "claude-code" ? "claude auth login" : "";
  return {
    powershell: `$env:${varName}="${dir}"; ${login}`,
    bash: `${varName}="${dir}" ${login}`,
  };
}


/**
 * Who a given account actually is.
 *
 * `claude auth status` prints JSON including `email` and `subscriptionType` for whichever config
 * directory it is pointed at, and it does so WITHOUT spending a turn. That answers the question
 * the UI otherwise cannot: two agents both say "claude-code", so which subscription is each one
 * really on? Every field here is copied from that output - nothing is derived, and an account
 * that does not answer reports `loggedIn: false` rather than a guess at who it might be.
 */
export interface AccountIdentity {
  /** The user's label, or undefined for the CLI's own default login. */
  label?: string;
  loggedIn: boolean;
  /** Straight from the CLI. Undefined when signed out or when it did not say. */
  email?: string;
  /** e.g. "max", "team", "pro". The CLI's own word for it. */
  subscriptionType?: string;
  /** Present only when something went wrong, carrying the CLI's own words. */
  error?: string;
}

const STATUS_TIMEOUT_MS = 15_000;

function claudeAuthStatus(dir?: string): Promise<AccountIdentity> {
  return new Promise((resolve) => {
    let out = "";
    const child = spawnCli("claude", ["auth", "status"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // Only this one variable is overridden; everything else the CLI needs is inherited.
      env: dir ? { ...process.env, CLAUDE_CONFIG_DIR: dir } : process.env,
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ loggedIn: false, error: `\`claude auth status\` did not answer within ${STATUS_TIMEOUT_MS}ms` });
    }, STATUS_TIMEOUT_MS);
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (out += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ loggedIn: false, error: (err as Error).message });
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const json = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
        resolve({
          loggedIn: json.loggedIn === true,
          email: typeof json.email === "string" ? json.email : undefined,
          subscriptionType: typeof json.subscriptionType === "string" ? json.subscriptionType : undefined,
        });
      } catch {
        // Not signed in is the ordinary case for a brand-new account directory, and it is not
        // an error worth showing as one.
        resolve({ loggedIn: false });
      }
    });
  });
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
  // Probed in parallel: each is a separate process and doing them in series made the picker
  // take labels.length * up-to-15s to open.
  const [def, ...rest] = await Promise.all([
    claudeAuthStatus(undefined),
    ...labels.map((l) => claudeAuthStatus(accountDir(provider, l))),
  ]);
  return [def, ...rest.map((r, i) => ({ ...r, label: labels[i] }))];
}

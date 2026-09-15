import type { GithubConnection } from "@solace/shared";
import { spawnCli } from "./spawnCli";

export interface GithubAuthStatus {
  authenticated: boolean;
  account?: string;
  detail?: string;
}

/** One timeboxed, never-throwing `gh` invocation. Same discipline as providerStatus.ts's
 * probeVersion(): async, individually bounded, and a missing binary is an answer rather than
 * an exception. Both streams are captured because `gh auth status` has printed to stdout in
 * some versions and stderr in others, and we want whichever one it actually used. */
function runGh(args: string[], timeoutMs = 6000): Promise<{ code: number | null; stdout: string; stderr: string; spawnError?: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    try {
      const child = spawnCli("gh", args, { stdio: ["ignore", "pipe", "pipe"] });
      const timer = setTimeout(() => {
        child.kill();
        resolve({ code: null, stdout, stderr, spawnError: `\`gh ${args.join(" ")}\` did not answer within ${timeoutMs / 1000}s` });
      }, timeoutMs);
      child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
      child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ code: null, stdout, stderr, spawnError: (err as Error).message });
      });
    } catch (err) {
      resolve({ code: null, stdout: "", stderr: "", spawnError: (err as Error).message });
    }
  });
}

/**
 * Checks GitHub auth asynchronously (never spawnSync - see spawnCli.ts's own comment and
 * providerStatus.ts's history: a synchronous spawn here would block the whole server's event
 * loop, including in-flight WebSocket handshakes, exactly like the bug fixed earlier).
 *
 * Uses `gh api user` rather than parsing `gh auth status`'s text: `gh auth status` caches the
 * account name from when the token was first stored and can report a stale username after a
 * GitHub account rename (confirmed on this machine - it still said "hainesdrewh" long after
 * the account was renamed to "Kryhr"). `gh api user` asks GitHub directly for the current login.
 */
export async function checkGithubAuth(): Promise<GithubAuthStatus> {
  const result = await runGh(["api", "user", "--jq", ".login"]);
  if (result.spawnError) return { authenticated: false, detail: "gh CLI not found - install from cli.github.com" };
  const login = result.stdout.trim();
  if (result.code !== 0 || !login) return { authenticated: false, detail: "run `gh auth login` to sign in" };
  return { authenticated: true, account: login };
}

/**
 * The real install command for this OS, or - on Linux, where it genuinely depends on the
 * distribution - the page that has the right one. Guessing `apt install gh` on a Fedora box
 * would be a made-up instruction, which is the thing this panel is not allowed to do.
 */
function installGuidance(): { fixCommand?: string; fixHint: string } {
  if (process.platform === "win32") {
    return { fixCommand: "winget install --id GitHub.cli", fixHint: "The GitHub CLI isn't on this machine's PATH. Install it, then reopen this panel." };
  }
  if (process.platform === "darwin") {
    return { fixCommand: "brew install gh", fixHint: "The GitHub CLI isn't on this machine's PATH. Install it, then reopen this panel." };
  }
  return {
    fixHint:
      "The GitHub CLI isn't on this machine's PATH. The install command depends on your distribution's package manager - cli.github.com/manual/installation has the right one.",
  };
}

/** Token scopes exactly as gh listed them. gh prints a line like
 *  `- Token scopes: 'gist', 'read:org', 'repo'`; older builds used `Token scopes: repo, gist`.
 *  Both are handled, and anything else returns undefined rather than an invented list. */
export function parseTokenScopes(statusText: string): string[] | undefined {
  const line = statusText.split(/\r?\n/).find((l) => /token scopes:/i.test(l));
  if (!line) return undefined;
  const tail = line.slice(line.toLowerCase().indexOf("token scopes:") + "token scopes:".length);
  return tail
    .split(",")
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
    .filter((s) => s.length > 0);
}

/** The account name `gh auth status` itself printed, which is NOT necessarily the current
 * login - see checkGithubAuth above. Returned so the UI can show the disagreement rather than
 * silently preferring one. Matches both `account NAME (keyring)` and the older `as NAME`. */
export function parseReportedAccount(statusText: string): string | undefined {
  const modern = statusText.match(/Logged in to \S+ account ([^\s(]+)/i);
  if (modern) return modern[1];
  const legacy = statusText.match(/Logged in to \S+ as ([^\s(]+)/i);
  return legacy?.[1];
}

/**
 * Everything Connections needs to show GitHub honestly, in one call.
 *
 * Two `gh` invocations on purpose, because they answer different questions and neither alone
 * is enough:
 *   - `gh auth status` is what the user asked to see: which host, which account gh thinks it
 *     is, and which token scopes are actually granted. Its text is carried through verbatim
 *     rather than summarised, because a summary is where invented capabilities creep in. gh
 *     masks the token in this output itself; nothing here un-masks it and nothing is added.
 *   - `gh api user` is the authoritative current login, for the stale-name reason documented
 *     on checkGithubAuth. When the two disagree we report both instead of picking.
 *
 * Both are read-only and cheap. Neither writes anything or changes any auth state.
 */
export async function checkGithubConnection(): Promise<GithubConnection> {
  const checkedAt = new Date().toISOString();

  const status = await runGh(["auth", "status"]);
  if (status.spawnError) {
    // A spawn error here means the binary could not be run at all - gh is missing, not
    // signed out. Said as such: implying it's optional or that sign-in would fix it would
    // send the user to the wrong command.
    const guidance = installGuidance();
    return { installed: false, authenticated: false, checkedAt, ...guidance };
  }

  // gh exits non-zero when not logged in but still prints a useful explanation, so the text
  // is kept either way - that text IS the answer to "what does gh say".
  const statusText = `${status.stdout}${status.stderr}`.trim();

  const user = await runGh(["api", "user", "--jq", ".login"]);
  const account = user.code === 0 ? user.stdout.trim() || undefined : undefined;
  const authenticated = Boolean(account);

  return {
    installed: true,
    authenticated,
    account,
    reportedAccount: parseReportedAccount(statusText),
    statusText: statusText || undefined,
    scopes: parseTokenScopes(statusText),
    fixCommand: authenticated ? undefined : "gh auth login",
    fixHint: authenticated
      ? undefined
      : "gh is installed but has no usable token for GitHub. Run this in a terminal and follow its prompts.",
    checkedAt,
  };
}

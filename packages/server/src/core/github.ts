import { spawnCli } from "./spawnCli";

export interface GithubAuthStatus {
  authenticated: boolean;
  account?: string;
  detail?: string;
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
export function checkGithubAuth(): Promise<GithubAuthStatus> {
  return new Promise((resolve) => {
    let output = "";
    try {
      const child = spawnCli("gh", ["api", "user", "--jq", ".login"], { stdio: ["ignore", "pipe", "pipe"] });
      child.stdout?.on("data", (chunk) => (output += chunk.toString()));
      child.on("close", (code) => {
        const login = output.trim();
        if (code !== 0 || !login) {
          resolve({ authenticated: false, detail: "run `gh auth login` to sign in" });
          return;
        }
        resolve({ authenticated: true, account: login });
      });
      child.on("error", () => {
        resolve({ authenticated: false, detail: "gh CLI not found - install from cli.github.com" });
      });
    } catch {
      resolve({ authenticated: false, detail: "gh CLI not found - install from cli.github.com" });
    }
  });
}

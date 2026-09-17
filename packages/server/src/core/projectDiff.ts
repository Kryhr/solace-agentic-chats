import { spawnCli } from "./spawnCli";

/**
 * `/diff`: what has actually changed in this chat's project since the chat was created.
 *
 * Every line of the answer comes from git. Nothing here describes, characterises or summarises a
 * change - if git prints nothing, the answer is that git printed nothing, not "no significant
 * changes were made".
 *
 * "Since this chat started" is honoured in the only way that is actually knowable after the
 * fact: the chat's own createdAt is handed to `git log --since`, and the working tree is
 * compared against HEAD. There is no baseline commit recorded when a chat is created (chats
 * predate this command, and a chat can be moved between projects), so inventing one would be
 * worse than saying plainly what the two halves of the answer mean - which is what the header
 * below does.
 */

const GIT_TIMEOUT_MS = 8000;

export interface GitRun {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
}

/** One timeboxed, never-throwing `git` invocation, in `cwd`. Same discipline as github.ts's
 * runGh: a missing binary is an answer rather than an exception. */
export function runGit(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<GitRun> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    try {
      const child = spawnCli("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      const timer = setTimeout(() => {
        child.kill();
        resolve({ code: null, stdout, stderr, spawnError: `\`git ${args.join(" ")}\` did not answer within ${timeoutMs / 1000}s` });
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

/** Chat output is not a terminal. A 4,000-line diff pasted into a room of four is the 1,300-char
 * dump problem with a bigger number, so the body is clipped and the clipping says so. */
const MAX_DIFF_CHARS = 3000;

function clip(text: string): string {
  const trimmed = text.trimEnd();
  if (trimmed.length <= MAX_DIFF_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_DIFF_CHARS)}\n…(clipped - ${trimmed.length - MAX_DIFF_CHARS} more characters; run the command yourself for the rest)`;
}

/**
 * Assembles the answer from real git output.
 *
 * Exported and pure so the shape of the answer is testable without a repository: the caller
 * supplies what git said, this decides what to print. `stat` mode prints the per-file summary
 * only, which is what is usually wanted in a chat.
 */
export function formatDiff(opts: {
  projectName: string;
  since: string;
  /** `git log --oneline --since=<since>` stdout. */
  log: string;
  /** `git diff --stat HEAD` stdout. */
  stat: string;
  /** `git diff HEAD` stdout. Omitted in stat mode. */
  patch?: string;
}): string {
  const commits = opts.log.trim();
  const stat = opts.stat.trim();
  const out: string[] = [
    `${opts.projectName} - git, since this chat was created (${new Date(opts.since).toLocaleString()}):`,
  ];

  out.push(
    "",
    commits
      ? `Commits since then:\n${clip(commits)}`
      : "Commits since then: none.",
  );
  out.push(
    "",
    stat
      ? `Uncommitted changes against HEAD:\n${clip(stat)}`
      : "Uncommitted changes against HEAD: none - the working tree is clean.",
  );
  if (opts.patch !== undefined) {
    const patch = opts.patch.trim();
    if (patch) out.push("", clip(patch));
  }
  return out.join("\n");
}

export interface DiffResult {
  ok: boolean;
  text: string;
}

/**
 * Runs the three commands and formats them, or explains exactly why it could not.
 *
 * A directory that is not a git repository is an answer, not an error to swallow: without this
 * the command would print an empty diff, which reads as "nothing has changed" for a project
 * where in fact nothing is being tracked at all.
 */
export async function projectDiff(opts: {
  cwd: string;
  projectName: string;
  since: string;
  stat: boolean;
}): Promise<DiffResult> {
  const inside = await runGit(opts.cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.spawnError) {
    return { ok: false, text: `Could not run git in ${opts.cwd}: ${inside.spawnError}` };
  }
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    return {
      ok: false,
      text:
        `${opts.cwd} is not a git repository, so there is no diff to show. ` +
        `git said: ${(inside.stderr || inside.stdout).trim() || "(nothing)"}`,
    };
  }
  const [log, stat, patch] = await Promise.all([
    runGit(opts.cwd, ["log", "--oneline", `--since=${opts.since}`]),
    runGit(opts.cwd, ["diff", "--stat", "HEAD"]),
    opts.stat ? Promise.resolve<GitRun>({ code: 0, stdout: "", stderr: "" }) : runGit(opts.cwd, ["diff", "HEAD"]),
  ]);
  return {
    ok: true,
    text: formatDiff({
      projectName: opts.projectName,
      since: opts.since,
      log: log.stdout,
      stat: stat.stdout,
      patch: opts.stat ? undefined : patch.stdout,
    }),
  };
}

import crossSpawn from "cross-spawn";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { SpawnOptions } from "node:child_process";

/**
 * Minimal `where`-equivalent, matching how Windows itself resolves a bare command name: each
 * PATH directory in order, each PATHEXT extension in order. Extensions are tried BEFORE the
 * bare name on purpose - npm installs both an extensionless shell script (`claude`) and a
 * `claude.cmd` next to each other, and Windows runs the .cmd, so checking the bare name first
 * would resolve to the wrong file and miss exactly the case this guard exists to catch.
 */
function resolveOnPath(bin: string): string | undefined {
  if (/[\\/]/.test(bin)) return existsSync(bin) ? bin : undefined;
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(delimiter).filter(Boolean);
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const ext of [...exts, ""]) {
      const candidate = join(dir, bin + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Provider CLIs (claude, codex, gemini, qwen) are installed as npm-global .cmd shims on
 * Windows, which plain node:child_process.spawn can only execute via `shell: true` - and
 * shell:true just joins the args array with spaces with no quoting at all (see the DEP0190
 * warning), so any argument containing whitespace (a multi-word prompt, most of them)
 * silently splits into multiple CLI arguments.
 *
 * This used to be patched with a hand-rolled `winQuote()` that backslash-escaped embedded
 * quotes - but cmd.exe does not treat a backslash as an escape character at all, so an
 * argument containing a `"` (e.g. one agent's chat output being fed as another agent's
 * prompt) could close cmd.exe's quoting early and expose the rest of the argument to
 * cmd.exe's own operators (&, |, ^, %VAR%) - a real command-injection surface. cross-spawn
 * is the standard, widely-audited fix for this exact problem (used by npm itself): it
 * implements the actual Windows argv-quoting rules cmd.exe expects, rather than guessing.
 */
/**
 * cross-spawn fixes *quoting*, but there is one thing no amount of quoting can fix: a
 * cmd.exe command line ends at a literal newline, so an argv element containing one is
 * silently truncated there, with everything after it thrown away and a zero exit code. That
 * cost a real debugging session - every multi-line group prompt reached Claude Code with only
 * its first line intact, and the agent reported "I don't see an actual message or task in
 * this turn" while the server believed it had sent the whole thing. Failing loudly is the
 * only honest option: a caller with a multi-line argument must pass it over stdin instead
 * (see claude-code.ts), which has no such limit.
 *
 * Only .cmd/.bat go through cmd.exe. A native .exe (codex on this machine) takes its argv
 * straight through CreateProcess and handles newlines fine, so this deliberately doesn't
 * punish it - it checks what the command actually resolved to rather than assuming.
 */
function assertNoNewlineArgsOnWindowsShim(bin: string, args: string[]) {
  if (process.platform !== "win32") return;
  const offender = args.findIndex((a) => typeof a === "string" && /[\r\n]/.test(a));
  if (offender === -1) return;
  const resolved = resolveOnPath(bin);
  if (!resolved || !/\.(cmd|bat)$/i.test(resolved)) return;
  throw new Error(
    `spawnCli("${bin}"): argument #${offender} contains a newline, and "${bin}" resolves to ` +
      `${resolved}, which runs via cmd.exe - the argument would be silently truncated at the ` +
      `first newline. Pass this value on stdin instead of as a CLI argument.`,
  );
}

export function spawnCli(bin: string, args: string[], options: SpawnOptions = {}) {
  assertNoNewlineArgsOnWindowsShim(bin, args);
  return crossSpawn(bin, args, options);
}

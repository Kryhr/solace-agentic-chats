import crossSpawn from "cross-spawn";
import type { SpawnOptions } from "node:child_process";

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
export function spawnCli(bin: string, args: string[], options: SpawnOptions = {}) {
  return crossSpawn(bin, args, options);
}

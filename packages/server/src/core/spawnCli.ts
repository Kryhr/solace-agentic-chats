import { spawn, spawnSync, type SpawnOptions, type SpawnSyncOptions } from "node:child_process";

/**
 * Provider CLIs (claude, codex, gemini, qwen) are installed as npm-global .cmd shims on
 * Windows, which Node can only execute via `shell: true`. But Node's shell:true mode just
 * joins the args array with spaces with NO quoting - see the DEP0190 warning - so any
 * argument containing whitespace (a multi-word prompt, most of them) silently gets split
 * into multiple CLI arguments and breaks the target CLI's own arg parser. Quote manually
 * before handing args to spawn so a prompt like "reply with the word OK" survives as one
 * argument instead of exploding into five.
 */
function winQuote(arg: string): string {
  if (arg === "") return '""';
  if (!/[\s"]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

function prepareArgs(args: string[]): string[] {
  return process.platform === "win32" ? args.map(winQuote) : args;
}

export function spawnCli(bin: string, args: string[], options: SpawnOptions = {}) {
  const isWin = process.platform === "win32";
  return spawn(bin, prepareArgs(args), { ...options, shell: isWin });
}

export function spawnCliSync(bin: string, args: string[], options: SpawnSyncOptions = {}) {
  const isWin = process.platform === "win32";
  return spawnSync(bin, prepareArgs(args), { ...options, shell: isWin });
}

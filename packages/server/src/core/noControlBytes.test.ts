import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * No source file may contain a raw control byte.
 *
 * This has now happened five times in one day, in five different files, and every instance came
 * from the same place: writing source through a shell, where `\b` in a script becomes an actual
 * backspace (0x08) and `\0` becomes an actual NUL rather than the two-character escape TEXT the
 * code needs.
 *
 * It is invisible in every editor and in every diff, and the failures it produces look like
 * anything but a stray byte:
 *   - a regex `/\b(?:please|can you)\b/i` became `/<BS>(?:please|can you)<BS>/i`, which cannot
 *     match anything, so a guard that was supposed to stop suppressing a real request silently
 *     never fired and the message was swallowed;
 *   - a NUL in agentManager.ts made git treat the whole file as binary, so it stopped showing
 *     diffs for the most important file in the repo.
 *
 * Tabs, newlines and carriage returns are the only control characters that legitimately appear.
 */
const ROOTS = [join(import.meta.dirname, ".."), join(import.meta.dirname, "..", "..", "..", "shared", "src")];
const ALLOWED = new Set([9, 10, 13]); // tab, LF, CR

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

test("no source file contains a raw control byte", () => {
  const offenders: string[] = [];
  for (const root of ROOTS) {
    for (const f of sourceFiles(root)) {
      const buf = readFileSync(f);
      for (let i = 0; i < buf.length; i++) {
        const b = buf[i];
        if (b < 0x20 && !ALLOWED.has(b)) {
          const line = buf.subarray(0, i).toString("utf8").split("\n").length;
          offenders.push(`${f}:${line} contains 0x${b.toString(16).padStart(2, "0")}`);
          break;
        }
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a raw control byte is almost always an escape eaten while writing source through a shell - " +
      "it needed to be the two-character escape TEXT:\n  " + offenders.join("\n  "),
  );
});

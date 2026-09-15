import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  AGENT_TOOLS,
  createToolExecutor,
  gateFor,
  resolveInside,
  toolsWireFormat,
  type ToolCapability,
} from "./agentTools";
import type { TrustLevel } from "@solace/shared";

const isWindows = process.platform === "win32";

let root: string;
let outside: string;

before(() => {
  // mkdtemp under the OS temp dir, which on Windows is itself commonly reached through a
  // junction - which makes this a real test of the realpath step rather than a happy path.
  const base = mkdtempSync(join(tmpdir(), "solace-tools-"));
  root = join(base, "workspace");
  outside = join(base, "outside");
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, "hello.txt"), "line one\nline two\nline three\n", "utf8");
  writeFileSync(join(outside, "secret.txt"), "TOP SECRET\n", "utf8");
});

after(() => {
  try {
    rmSync(join(root, ".."), { recursive: true, force: true });
  } catch {
    /* a leaked temp dir is not worth failing a test run over */
  }
});

// -------------------------------------------------------------------------------------------
// Containment
// -------------------------------------------------------------------------------------------

describe("resolveInside", () => {
  test("accepts a plain relative path", () => {
    const result = resolveInside(root, "hello.txt");
    assert.equal(result.ok, true);
    assert.ok(result.ok && result.path.endsWith(`${sep}hello.txt`));
  });

  test("accepts an absolute path inside the root", () => {
    const result = resolveInside(root, join(root, "nested", "new.txt"));
    assert.equal(result.ok, true);
  });

  test("accepts the root itself", () => {
    assert.equal(resolveInside(root, root).ok, true);
    assert.equal(resolveInside(root, ".").ok, true);
  });

  test("rejects .. traversal rather than sanitising it", () => {
    const result = resolveInside(root, "../outside/secret.txt");
    assert.equal(result.ok, false);
    assert.ok(!result.ok && /outside this agent's working directory/.test(result.reason));
  });

  test("rejects deeply buried .. traversal", () => {
    assert.equal(resolveInside(root, "a/b/c/../../../../outside/secret.txt").ok, false);
  });

  test("rejects an absolute path outside the root", () => {
    assert.equal(resolveInside(root, join(outside, "secret.txt")).ok, false);
  });

  test("rejects a sibling directory that shares the root's string prefix", () => {
    // `<root>-evil` literally startsWith(root), which is exactly the bug a naive check has.
    assert.equal(resolveInside(root, `${root}-evil${sep}x.txt`).ok, false);
  });

  test("rejects empty and non-string paths", () => {
    assert.equal(resolveInside(root, "").ok, false);
    assert.equal(resolveInside(root, "   ").ok, false);
    assert.equal(resolveInside(root, 42).ok, false);
    assert.equal(resolveInside(root, undefined).ok, false);
    assert.equal(resolveInside(root, { path: "x" }).ok, false);
  });

  test("rejects a NUL byte in the path", () => {
    assert.equal(resolveInside(root, "hello\0.txt").ok, false);
  });

  test("follows a link out of the root and rejects it", (t) => {
    // Creating a symlink/junction needs privileges that may not be granted; skip rather than
    // fail, but keep the assertion for the machines where it does work.
    const link = join(root, "escape");
    try {
      symlinkSync(outside, link, "junction");
    } catch {
      t.skip("cannot create a link in this environment");
      return;
    }
    const result = resolveInside(root, "escape/secret.txt");
    assert.equal(result.ok, false, "a link pointing out of the root must not be treated as contained");
  });

  test("resolves a path whose parent does not exist yet (so write_file can create it)", () => {
    const result = resolveInside(root, "brand/new/deep/file.txt");
    assert.equal(result.ok, true);
  });

  test("rejects a not-yet-existing path that still escapes", () => {
    assert.equal(resolveInside(root, "../outside/brand/new/file.txt").ok, false);
  });

  // ---- Windows-specific ----

  test("windows: rejects a UNC path", (t) => {
    if (!isWindows) return t.skip("win32 only");
    assert.equal(resolveInside(root, "\\\\server\\share\\x.txt").ok, false);
  });

  test("windows: rejects an extended-length \\\\?\\ path", (t) => {
    if (!isWindows) return t.skip("win32 only");
    // \\?\ tells Win32 to skip normalisation entirely, so `..` inside one is NOT collapsed.
    assert.equal(resolveInside(root, "\\\\?\\C:\\Windows\\System32\\drivers\\etc\\hosts").ok, false);
  });

  test("windows: rejects a drive-relative path like C:foo", (t) => {
    if (!isWindows) return t.skip("win32 only");
    const result = resolveInside(root, "C:evil.txt");
    assert.equal(result.ok, false);
    assert.ok(!result.ok && /drive-relative/.test(result.reason));
  });

  test("windows: rejects another drive letter", (t) => {
    if (!isWindows) return t.skip("win32 only");
    assert.equal(resolveInside(root, "Z:\\anything.txt").ok, false);
  });

  test("windows: rejects reserved device names in any segment", (t) => {
    if (!isWindows) return t.skip("win32 only");
    for (const name of ["NUL", "nul", "CON", "com1", "LPT9", "NUL.txt"]) {
      const result = resolveInside(root, name);
      assert.equal(result.ok, false, `${name} must be refused`);
      assert.ok(!result.ok && /reserved Windows device name/.test(result.reason));
    }
    assert.equal(resolveInside(root, "sub/CON/x.txt").ok, false);
  });

  test("windows: a differently-cased path inside the root is still contained", (t) => {
    if (!isWindows) return t.skip("win32 only");
    assert.equal(resolveInside(root.toUpperCase(), join(root.toLowerCase(), "hello.txt")).ok, true);
    assert.equal(resolveInside(root.toLowerCase(), join(root.toUpperCase(), "hello.txt")).ok, true);
  });

  test("windows: forward slashes behave the same as backslashes", (t) => {
    if (!isWindows) return t.skip("win32 only");
    assert.equal(resolveInside(root, "sub/dir/file.txt").ok, true);
    assert.equal(resolveInside(root, "../outside/secret.txt".replace(/\//g, "\\")).ok, false);
  });
});

// -------------------------------------------------------------------------------------------
// Trust gating (pure)
// -------------------------------------------------------------------------------------------

describe("gateFor", () => {
  const levels: TrustLevel[] = ["plan", "manual", "acceptEdits", "bypassPermissions", "auto"];

  test("reads are always allowed, at every level", () => {
    for (const level of levels) assert.equal(gateFor(level, "read").kind, "allow");
  });

  test("plan refuses writes and commands outright, never asks", () => {
    assert.equal(gateFor("plan", "write").kind, "deny");
    assert.equal(gateFor("plan", "exec").kind, "deny");
  });

  test("manual asks for both writes and commands", () => {
    assert.equal(gateFor("manual", "write").kind, "ask");
    assert.equal(gateFor("manual", "exec").kind, "ask");
  });

  test("acceptEdits allows writes but still asks for commands", () => {
    assert.equal(gateFor("acceptEdits", "write").kind, "allow");
    assert.equal(gateFor("acceptEdits", "exec").kind, "ask");
  });

  test("bypassPermissions and auto allow everything", () => {
    for (const level of ["bypassPermissions", "auto"] as TrustLevel[]) {
      assert.equal(gateFor(level, "write").kind, "allow");
      assert.equal(gateFor(level, "exec").kind, "allow");
    }
  });

  test("an unknown trust level fails closed", () => {
    const decision = gateFor("nonsense" as TrustLevel, "exec");
    assert.equal(decision.kind, "deny");
  });
});

// -------------------------------------------------------------------------------------------
// Tool schemas
// -------------------------------------------------------------------------------------------

describe("tool schemas", () => {
  test("every tool is a valid OpenAI function definition", () => {
    const wire = toolsWireFormat() as any[];
    assert.equal(wire.length, AGENT_TOOLS.length);
    for (const entry of wire) {
      assert.equal(entry.type, "function");
      assert.equal(typeof entry.function.name, "string");
      assert.ok(entry.function.description.length > 10);
      assert.equal(entry.function.parameters.type, "object");
    }
  });

  test("the wire format never leaks our internal capability field", () => {
    const json = JSON.stringify(toolsWireFormat());
    assert.ok(!json.includes("capability"));
  });

  test("names match core/toolLabel entries so the activity UI labels them", async () => {
    const { describeToolCall } = await import("./toolLabel");
    assert.equal(describeToolCall("read_file", { path: "a/b/x.ts" }).label, "Reading x.ts");
    assert.equal(describeToolCall("write_file", { path: "a/b/x.ts" }).label, "Writing x.ts");
    assert.equal(describeToolCall("edit_file", { path: "a/b/x.ts" }).label, "Editing x.ts");
    assert.equal(describeToolCall("list_directory", { path: "a/b" }).label, "Listing b");
    assert.equal(describeToolCall("search_file_content", { pattern: "foo" }).label, "Searching for foo");
    assert.equal(describeToolCall("run_shell_command", { command: "git status" }).label, "Running git");
  });

  test("each tool declares exactly one capability", () => {
    const valid: ToolCapability[] = ["read", "write", "exec"];
    for (const tool of AGENT_TOOLS) assert.ok(valid.includes(tool.capability), tool.name);
  });
});

// -------------------------------------------------------------------------------------------
// Executor
// -------------------------------------------------------------------------------------------

function exec(trustLevel: TrustLevel, approval?: (d: string) => Promise<boolean>) {
  return createToolExecutor({
    cwd: root,
    trustLevel,
    agentId: "agent-test",
    turnToken: "token-test",
    requestApproval: approval ?? (async () => true),
  });
}

describe("tool executor", () => {
  test("read_file returns real contents", async () => {
    const result = await exec("plan").execute("read_file", JSON.stringify({ path: "hello.txt" }));
    assert.equal(result.isError, false);
    assert.ok(result.content.includes("line two"));
  });

  test("read_file honours start_line/max_lines", async () => {
    const result = await exec("plan").execute("read_file", JSON.stringify({ path: "hello.txt", start_line: 2, max_lines: 1 }));
    assert.ok(result.content.includes("line two"));
    assert.ok(!result.content.includes("line three"));
  });

  test("read_file outside the cwd is refused and reads nothing", async () => {
    const result = await exec("auto").execute("read_file", JSON.stringify({ path: join(outside, "secret.txt") }));
    assert.equal(result.isError, true);
    assert.match(result.content, /^refused:/);
    assert.ok(!result.content.includes("TOP SECRET"));
  });

  test("plan mode refuses a write and does not create the file", async () => {
    const target = join(root, "plan-should-not-exist.txt");
    const result = await exec("plan").execute("write_file", JSON.stringify({ path: target, content: "x" }));
    assert.equal(result.isError, true);
    assert.match(result.content, /refused: this agent is in plan mode/);
    assert.throws(() => readFileSync(target, "utf8"));
  });

  test("plan mode refuses a command", async () => {
    const result = await exec("plan").execute("run_shell_command", JSON.stringify({ command: "echo hi" }));
    assert.equal(result.isError, true);
    assert.match(result.content, /plan mode/);
  });

  test("manual mode asks before writing, and a denial writes nothing", async () => {
    const asked: string[] = [];
    const target = join(root, "manual-denied.txt");
    const result = await exec("manual", async (d) => {
      asked.push(d);
      return false;
    }).execute("write_file", JSON.stringify({ path: target, content: "nope" }));
    assert.equal(asked.length, 1);
    assert.match(asked[0], /^write_file: /);
    assert.equal(result.isError, true);
    assert.match(result.content, /denied/);
    assert.throws(() => readFileSync(target, "utf8"));
  });

  test("manual mode approval lets the write through", async () => {
    const target = join(root, "manual-allowed.txt");
    const result = await exec("manual", async () => true).execute(
      "write_file",
      JSON.stringify({ path: target, content: "yes" }),
    );
    assert.equal(result.isError, false);
    assert.equal(readFileSync(target, "utf8"), "yes");
  });

  test("manual mode asks before a command, with the command itself on the card", async () => {
    const asked: string[] = [];
    await exec("manual", async (d) => {
      asked.push(d);
      return false;
    }).execute("run_shell_command", JSON.stringify({ command: "git push --force" }));
    assert.deepEqual(asked, ["run_shell_command: git push --force"]);
  });

  test("acceptEdits writes without asking but still asks for a command", async () => {
    const asked: string[] = [];
    const ex = exec("acceptEdits", async (d) => {
      asked.push(d);
      return false;
    });
    const target = join(root, "accept-edits.txt");
    const write = await ex.execute("write_file", JSON.stringify({ path: target, content: "ok" }));
    assert.equal(write.isError, false);
    assert.equal(asked.length, 0, "a write must not raise an approval at acceptEdits");
    await ex.execute("run_shell_command", JSON.stringify({ command: "echo hi" }));
    assert.equal(asked.length, 1, "a command must still raise an approval at acceptEdits");
  });

  test("a failing approval round-trip denies rather than defaulting to allow", async () => {
    const result = await exec("manual", async () => {
      throw new Error("server unreachable");
    }).execute("write_file", JSON.stringify({ path: join(root, "unreachable.txt"), content: "x" }));
    // The rejection surfaces as an error result, and crucially not as a success.
    assert.equal(result.isError, true);
    assert.throws(() => readFileSync(join(root, "unreachable.txt"), "utf8"));
  });

  test("an approval is never raised for a refused write outside the cwd", async () => {
    // Order matters: the trust gate runs first, so a `manual` agent asking to write outside the
    // workspace must still be stopped by containment when the user clicks Allow.
    const result = await exec("manual", async () => true).execute(
      "write_file",
      JSON.stringify({ path: join(outside, "pwned.txt"), content: "x" }),
    );
    assert.equal(result.isError, true);
    assert.match(result.content, /^refused:/);
    assert.throws(() => readFileSync(join(outside, "pwned.txt"), "utf8"));
  });

  test("write_file creates missing parent directories", async () => {
    const result = await exec("auto").execute(
      "write_file",
      JSON.stringify({ path: "deep/nested/dir/file.txt", content: "made it" }),
    );
    assert.equal(result.isError, false);
    assert.equal(readFileSync(join(root, "deep", "nested", "dir", "file.txt"), "utf8"), "made it");
  });

  test("edit_file replaces an exact string", async () => {
    writeFileSync(join(root, "edit-me.txt"), "alpha\nbeta\ngamma\n", "utf8");
    const result = await exec("auto").execute(
      "edit_file",
      JSON.stringify({ path: "edit-me.txt", old_text: "beta", new_text: "BETA" }),
    );
    assert.equal(result.isError, false);
    assert.equal(readFileSync(join(root, "edit-me.txt"), "utf8"), "alpha\nBETA\ngamma\n");
  });

  test("edit_file refuses an ambiguous match instead of guessing", async () => {
    writeFileSync(join(root, "dupe.txt"), "x\nx\n", "utf8");
    const result = await exec("auto").execute("edit_file", JSON.stringify({ path: "dupe.txt", old_text: "x", new_text: "y" }));
    assert.equal(result.isError, true);
    assert.match(result.content, /appears 2 times/);
    assert.equal(readFileSync(join(root, "dupe.txt"), "utf8"), "x\nx\n");
  });

  test("edit_file reports a missing old_text honestly", async () => {
    const result = await exec("auto").execute(
      "edit_file",
      JSON.stringify({ path: "hello.txt", old_text: "not present", new_text: "z" }),
    );
    assert.equal(result.isError, true);
    assert.match(result.content, /was not found/);
  });

  test("list_directory lists real entries", async () => {
    const result = await exec("plan").execute("list_directory", JSON.stringify({}));
    assert.equal(result.isError, false);
    assert.ok(result.content.includes("hello.txt"));
  });

  test("search_file_content finds real matches and reports none honestly", async () => {
    const hit = await exec("plan").execute("search_file_content", JSON.stringify({ pattern: "line t" }));
    assert.equal(hit.isError, false);
    assert.ok(hit.content.includes("hello.txt"));
    const miss = await exec("plan").execute("search_file_content", JSON.stringify({ pattern: "zzz-not-there-zzz" }));
    assert.equal(miss.isError, false);
    assert.match(miss.content, /No matches/);
  });

  test("search_file_content rejects an invalid regex", async () => {
    const result = await exec("plan").execute("search_file_content", JSON.stringify({ pattern: "([" }));
    assert.equal(result.isError, true);
    assert.match(result.content, /not a valid regular expression/);
  });

  test("run_shell_command really runs and reports the real exit code", async () => {
    const ok = await exec("auto").execute("run_shell_command", JSON.stringify({ command: "echo solace-ok" }));
    assert.equal(ok.exitCode, 0);
    assert.ok(ok.content.includes("solace-ok"));

    const fail = await exec("auto").execute(
      "run_shell_command",
      JSON.stringify({ command: isWindows ? "exit /b 3" : "exit 3" }),
    );
    assert.equal(fail.exitCode, 3);
    assert.equal(fail.isError, true);
  });

  test("run_shell_command rejects a newline rather than silently truncating it", async () => {
    const result = await exec("auto").execute("run_shell_command", JSON.stringify({ command: "echo a\necho b" }));
    assert.equal(result.isError, true);
    assert.match(result.content, /newline/);
  });

  test("run_shell_command passes quotes and shell metacharacters through intact", async () => {
    // The whole reason this does not use shell:true: an argument containing a quote used to be
    // able to close cmd.exe's quoting early and expose the rest to cmd.exe's own operators.
    const result = await exec("auto").execute(
      "run_shell_command",
      JSON.stringify({ command: 'echo "a b & c"' }),
    );
    assert.equal(result.exitCode, 0);
    assert.ok(result.content.includes("a b & c"), result.content);
  });

  test("run_shell_command kills a command that outlives its timeout", async () => {
    const command = isWindows ? "ping -n 20 127.0.0.1 > nul" : "sleep 20";
    const started = Date.now();
    const result = await exec("auto").execute("run_shell_command", JSON.stringify({ command, timeout_ms: 1200 }));
    assert.equal(result.isError, true);
    assert.match(result.content, /killed/);
    assert.ok(Date.now() - started < 15_000, "the timeout must actually fire");
  });

  test("an already-aborted signal stops the command instead of running it to completion", async () => {
    const controller = new AbortController();
    controller.abort();
    const ex = createToolExecutor({
      cwd: root,
      trustLevel: "auto",
      agentId: "a",
      turnToken: "t",
      signal: controller.signal,
      requestApproval: async () => true,
    });
    const result = await ex.execute("run_shell_command", JSON.stringify({ command: isWindows ? "ping -n 10 127.0.0.1" : "sleep 10" }));
    assert.match(result.content, /cancelled/);
  });

  test("an unknown tool name is reported, not silently ignored", async () => {
    const result = await exec("auto").execute("delete_everything", "{}");
    assert.equal(result.isError, true);
    assert.match(result.content, /no tool named/);
  });

  test("malformed JSON arguments are reported without touching the disk", async () => {
    const result = await exec("auto").execute("write_file", "{not json");
    assert.equal(result.isError, true);
    assert.match(result.content, /not a JSON object/);
  });

  test("a JSON array as arguments is rejected", async () => {
    const result = await exec("auto").execute("read_file", "[1,2,3]");
    assert.equal(result.isError, true);
  });

  test("no refusal ever looks like a success", async () => {
    for (const [name, args] of [
      ["write_file", { path: "../outside/x.txt", content: "x" }],
      ["run_shell_command", { command: "echo hi" }],
    ] as const) {
      const result = await exec("plan").execute(name, JSON.stringify(args));
      assert.equal(result.isError, true);
      assert.match(result.content, /^refused:/);
    }
  });
});

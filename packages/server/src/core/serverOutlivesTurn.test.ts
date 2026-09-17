import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killCliTree } from "./spawnCli";
import { PortRegistry, pidAlive } from "./portRegistry";
import { checkLocalUrl } from "./urlVerification";

/**
 * The incident, verbatim from the measurement: **22 "it's live" claims, 4 contradicted within
 * fifteen messages.** The cause is mechanical, not a matter of agent honesty - a server started
 * inside a turn is a descendant of that turn's process, and `killCliTree` kills the whole tree
 * when the turn ends or is stopped. So the URL is live while the agent is writing about it and
 * dead by the time the operator clicks it.
 *
 * Both halves have to hold at once, and this file asserts both against real processes:
 *
 *  1. A server started through `start_server` survives a `killCliTree` of the turn's tree.
 *  2. `killCliTree` still kills a hung CLI's whole tree - including a grandchild it spawned,
 *     which is the entire reason taskkill /T is there and the thing that must not regress.
 *
 * Nothing here is mocked. Real processes, real pids, a real HTTP request.
 */

const isWindows = process.platform === "win32";

/** Best-effort temp cleanup. On Windows a directory a process was using can stay locked for a
 * moment after that process dies, and a failed rm of a temp folder must never be reported as
 * this test failing - the assertions above it are the test. */
function cleanup(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* the OS will clear it */
  }
}

const AGENT = { id: "agent-a", handle: "claude" };

/** Poll until `predicate` holds or the budget runs out. Process death is asynchronous - taskkill
 * is itself a process - so asserting immediately after a kill is a flake, not a test. */
async function waitFor(predicate: () => boolean, budgetMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return predicate();
}

/**
 * A stand-in for a provider CLI that has spawned a child and hung: a shell, which spawns node,
 * which records its own pid and then does nothing for a minute. Two levels deep on purpose -
 * killing only the handle we hold leaves the node process running, which is the exact failure
 * killCliTree exists to prevent.
 */
function spawnFakeHungCli(root: string) {
  const pidFile = join(root, `child-${Math.random().toString(36).slice(2)}.pid`);
  const script = join(root, "hang.js");
  writeFileSync(
    script,
    "require('fs').writeFileSync(process.argv[2], String(process.pid));\nsetTimeout(() => {}, 60000);\n",
    "utf8",
  );
  const command = `node "${script}" "${pidFile}"`;
  const child = isWindows
    ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${command}"`], {
        cwd: root,
        windowsVerbatimArguments: true,
        windowsHide: true,
        stdio: "ignore",
      })
    : spawn("/bin/sh", ["-c", command], { cwd: root, stdio: "ignore" });
  return { child, pidFile };
}

async function readChildPid(pidFile: string): Promise<number> {
  const appeared = await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").replace(/\r\n/g, "\n").trim().length > 0, 15_000);
  assert.ok(appeared, "the fake CLI's own child never started, so this test proves nothing");
  return Number(readFileSync(pidFile, "utf8").replace(/\r\n/g, "\n").trim());
}

test("a server started through start_server outlives the turn that asked for it", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "solace-outlive-"));
  const registry = new PortRegistry(undefined, root);
  let serverPid: number | undefined;
  t.after(() => {
    if (serverPid && pidAlive(serverPid)) {
      try {
        process.kill(serverPid);
      } catch {
        /* already gone */
      }
    }
    cleanup(root);
  });

  // A turn is running, with its own process tree.
  const turn = spawnFakeHungCli(root);
  const turnChildPid = await readChildPid(turn.pidFile);
  assert.equal(pidAlive(turnChildPid), true);

  // The agent reserves a port and starts a real HTTP server through the registry.
  const reserved = await registry.reserve(AGENT, { purpose: "the preview" });
  assert.equal(reserved.ok, true);
  const port = reserved.ok ? reserved.port : 0;

  const serve = join(root, "serve.js");
  writeFileSync(
    serve,
    "const port = Number(process.argv[2]);\n" +
      "require('http').createServer((_, res) => { res.statusCode = 200; res.end('ok'); }).listen(port, '127.0.0.1');\n",
    "utf8",
  );
  const started = await registry.startServer(AGENT, { command: `node "${serve}" ${port}`, cwd: root, port });
  assert.equal(started.ok, true, started.ok ? "" : started.error);
  serverPid = started.ok ? started.server.pid : undefined;

  assert.ok(await waitForHttp(`http://127.0.0.1:${port}/`), "the server never came up, so nothing below is meaningful");

  // The turn ends the way a stopped or timed-out turn ends: its whole tree is killed.
  killCliTree(turn.child);
  assert.ok(await waitFor(() => !pidAlive(turnChildPid)), "the turn's tree must actually die");

  // THE ASSERTION. The server is still there, and still answering - it was never in that tree.
  assert.equal(pidAlive(serverPid!), true, "the agent's server died with the turn - the bug is back");
  const check = await checkLocalUrl(`http://127.0.0.1:${port}/`);
  assert.ok(check, "the URL check could not run");
  assert.equal(check!.reachable, true);
  assert.equal(check!.status, 200);

  // And it is killable from the UI afterwards, which is the other half of "recorded".
  const stopped = registry.stopServer(started.ok ? started.server.id : "");
  assert.equal(stopped.ok, true);
  assert.ok(await waitFor(() => !pidAlive(serverPid!)), "Kill must actually stop it");
  // Its port goes back into circulation.
  assert.equal(registry.holderOf(port), undefined);
});

test("killCliTree still kills a hung CLI's whole tree", async (t) => {
  // The thing that must not regress. Nothing about detached servers may weaken this: a provider
  // CLI that hangs leaves real filesystem writes and real billed tokens running against a turn
  // the user already stopped, and child.kill() alone reaches only the shim we hold a handle to.
  const root = mkdtempSync(join(tmpdir(), "solace-killtree-"));
  const hung = spawnFakeHungCli(root);
  const childPid = await readChildPid(hung.pidFile);
  t.after(() => {
    if (pidAlive(childPid)) {
      try {
        process.kill(childPid);
      } catch {
        /* already gone */
      }
    }
    cleanup(root);
  });

  assert.equal(pidAlive(childPid), true, "the grandchild must be running before we kill anything");
  killCliTree(hung.child);
  assert.ok(
    await waitFor(() => !pidAlive(childPid)),
    "killCliTree left the CLI's own child alive - this is the orphaned-work bug it exists to prevent",
  );
});

/** Poll an HTTP endpoint until it answers. A freshly spawned server legitimately needs a moment
 * to bind, and treating the first failed connect as the answer is how a correct server gets
 * reported as dead. */
async function waitForHttp(url: string, budgetMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const check = await checkLocalUrl(url, 1000);
    if (check?.reachable) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

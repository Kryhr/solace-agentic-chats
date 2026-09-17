import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NEVER_ALLOCATE_PORTS } from "@solace/shared";
import { PortRegistry, isPortFree, pidAlive, killServerTree } from "./portRegistry";

/**
 * The incidents these pin, all from the 28-chat measurement that produced ROADMAP v1.5:
 *
 *  - Two separate port fights (4545, then 5453). Each time, two agents settled on one port in
 *    conversation and each restarted a server the other was holding.
 *  - "It's live at localhost:4321" - true when written, false when clicked, because a server
 *    started inside a turn dies with the turn's process tree.
 *  - An agent "freeing up" a port that turned out to belong to something else entirely.
 */

const AGENT_A = { id: "agent-a", handle: "claude" };
const AGENT_B = { id: "agent-b", handle: "codex" };

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "solace-ports-"));
}

/** A real listener on a real port, so "occupied" in these tests means occupied and not mocked. */
function occupy(host = "127.0.0.1"): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer(() => {});
    server.once("error", reject);
    server.listen(0, host, () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

test("two agents are never given the same port", async () => {
  // The 4545 incident, and then the 5453 one. Both agents asked; both were told 4545 by a human
  // sentence in a chat, and both bound it.
  const root = tempRoot();
  try {
    const registry = new PortRegistry(undefined, root);
    const first = await registry.reserve(AGENT_A);
    const second = await registry.reserve(AGENT_B);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.ok(first.ok && second.ok && first.port !== second.port, "two agents must not get one port");

    // And the second agent is told WHO has the first, because "here is a different number" is
    // not enough to stop them asking for the same one again next turn.
    const asked = await registry.reserve(AGENT_B, { preferred: first.ok ? first.port : 0 });
    assert.equal(asked.ok, true);
    assert.ok(asked.ok && asked.preferredRefused, "a refused preference must say why");
    assert.match(asked.ok ? asked.preferredRefused! : "", /@claude/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a port that something is actually listening on is never handed out", async () => {
  // The registry knowing a port is unclaimed is not the same as the port being free. Solace is
  // not the only thing on this machine that binds ports, and a reservation that hands out an
  // occupied number is worse than no registry at all - the agent is told it owns something it
  // cannot bind, and then invents its own port again.
  const root = tempRoot();
  const taken = await occupy();
  try {
    assert.equal(await isPortFree(taken.port), false, "the probe must see a real listener");
    const registry = new PortRegistry(undefined, root);
    const result = await registry.reserve(AGENT_A, { preferred: taken.port });
    assert.equal(result.ok, true);
    assert.ok(result.ok && result.port !== taken.port, "an occupied port must not be reserved");
    assert.match(result.ok ? result.preferredRefused! : "", /already listening/);
  } finally {
    await taken.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the operator's own live instances can never be allocated", () => {
  // An agent once "freed up" a port by killing what was on it. 4310/4320 are the two Solace
  // servers and 5173/5183 their web dev servers: handing one out invites an agent to take down
  // the app it is talking through, mid-conversation.
  for (const port of [4310, 4320, 5173, 5183]) {
    assert.ok(NEVER_ALLOCATE_PORTS.includes(port), `${port} must be on the never-allocate list`);
  }
});

test("a reserved port asked for by its own holder is simply confirmed, not swapped", async () => {
  // An agent calling reserve_port twice in one turn (or across a retry) must not quietly end up
  // with two ports and a server on the wrong one.
  const root = tempRoot();
  try {
    const registry = new PortRegistry(undefined, root);
    const first = await registry.reserve(AGENT_A, { purpose: "preview" });
    assert.equal(first.ok, true);
    const again = await registry.reserve(AGENT_A, { preferred: first.ok ? first.port : 0 });
    assert.ok(again.ok && again.port === (first.ok ? first.port : -1));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("only the holder can release a port", async () => {
  // "I'll tidy up the stale reservations" is exactly how one agent takes another's port while
  // believing it is being helpful.
  const root = tempRoot();
  try {
    const registry = new PortRegistry(undefined, root);
    const held = await registry.reserve(AGENT_A);
    assert.equal(held.ok, true);
    const port = held.ok ? held.port : 0;
    assert.equal(registry.releasePort(port, AGENT_B.id), false, "a non-holder must not release it");
    assert.equal(registry.holderOf(port)?.agentId, AGENT_A.id);
    assert.equal(registry.releasePort(port, AGENT_A.id), true);
    assert.equal(registry.holderOf(port), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a persisted server whose process is gone loads as stopped, never as running", () => {
  // The registry's own version of the bug it exists to fix. A restart is the one moment where
  // every server record is a remembered claim rather than an observation, and a panel that
  // showed a dead pid as green would be Solace making the same unverified claim it badges
  // agents for.
  const root = tempRoot();
  try {
    const registry = new PortRegistry(
      {
        reservations: [{ port: 4455, agentId: AGENT_A.id, handle: AGENT_A.handle, at: new Date().toISOString() }],
        servers: [
          {
            id: "s1",
            port: 4455,
            // A pid that cannot be alive: pid 0 is not a process any user can signal.
            pid: 0,
            command: "npm run dev",
            cwd: root,
            agentId: AGENT_A.id,
            handle: AGENT_A.handle,
            startedAt: new Date().toISOString(),
            logPath: join(root, "s1.log"),
          },
        ],
      },
      root,
    );
    const state = registry.snapshot();
    assert.equal(state.servers[0].stoppedAt !== undefined, true, "a dead pid must load as stopped");
    assert.equal(state.servers[0].stoppedReason, "exited");
    // And its port goes back into circulation, because nothing is using it.
    assert.equal(state.reservations.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a bare reservation with no server survives a restart", () => {
  // The inverse of the test above, and it matters just as much: an agent that reserved a port
  // and has not started its server yet must not silently lose it. Revoking a port an agent was
  // told it owned is the fight this whole registry exists to prevent.
  const root = tempRoot();
  try {
    const registry = new PortRegistry(
      {
        reservations: [{ port: 4456, agentId: AGENT_A.id, handle: AGENT_A.handle, at: new Date().toISOString() }],
        servers: [],
      },
      root,
    );
    assert.equal(registry.holderOf(4456)?.agentId, AGENT_A.id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("start_server refuses a port somebody else holds, instead of restarting over them", async () => {
  // Literally the incident: each agent restarted a server the other was holding.
  const root = tempRoot();
  try {
    const registry = new PortRegistry(undefined, root);
    const held = await registry.reserve(AGENT_A, { purpose: "the docs preview" });
    assert.equal(held.ok, true);
    const result = await registry.startServer(AGENT_B, {
      command: "node -e \"setTimeout(()=>{},60000)\"",
      cwd: root,
      port: held.ok ? held.port : 0,
    });
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.error, /@claude holds/);
    assert.match(result.ok ? "" : result.error, /do not restart/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a multi-line command is refused rather than silently truncated", async () => {
  // A cmd.exe command line ends at the first newline and throws away the rest with a ZERO exit
  // code. Here that would mean a recorded, apparently-running server that is not the thing the
  // agent asked for - the worst available outcome for a registry whose job is honesty.
  const root = tempRoot();
  try {
    const registry = new PortRegistry(undefined, root);
    const port = await registry.reserve(AGENT_A);
    const result = await registry.startServer(AGENT_A, {
      command: "npm install\nnpm run dev",
      cwd: root,
      port: port.ok ? port.port : 0,
    });
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.error, /newline/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pidAlive says no for a pid that cannot exist", () => {
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(-1), false);
  assert.equal(pidAlive(Number.NaN), false);
  assert.equal(pidAlive(process.pid), true);
});

test("killing a server that is already gone is not an error", () => {
  // Clicking Kill on a row for a process that died a second ago is not a mistake by the
  // operator, and must not read as one.
  assert.doesNotThrow(() => killServerTree(0));
});

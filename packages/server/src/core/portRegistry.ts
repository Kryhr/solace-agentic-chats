import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import {
  emptyPortRegistry,
  NEVER_ALLOCATE_PORTS,
  type PortRegistryState,
  type PortReservation,
  type RunningServer,
} from "@solace/shared";
import { spawnCli } from "./spawnCli";
import { SERVER_PORT } from "./serverPort";

/**
 * The port and server registry: who holds which port, and which processes are actually up.
 *
 * ---------------------------------------------------------------------------------------------
 * Why a port is BIND-TESTED and never guessed
 * ---------------------------------------------------------------------------------------------
 * The obvious implementation is a counter: hand out 4400, then 4401, then 4402. It is wrong in
 * the exact case that caused the incident. Solace is not the only thing on this machine that
 * binds ports - the operator's own two instances, a model runtime, a Vite server somebody left
 * running from yesterday, another agent's server started before this registry existed. A counter
 * hands out a number that is already taken, the agent's server fails to bind, and the agent
 * either reports success it did not have or picks its own port at random, which is where "@codex
 * took 4545 while I was on it" comes from in the first place.
 *
 * So: every port this registry hands out has just been proven bindable, on BOTH 127.0.0.1 and
 * 0.0.0.0. Both, because a server bound only to loopback and a server bound to every interface
 * occupy the port for different callers, and testing one address alone lets the other kind of
 * conflict through. The bind is released immediately - there is an unavoidable race between
 * proving a port free and the agent binding it, and nothing short of handing the agent a live
 * socket closes it. The race is seconds wide and between cooperating parties; the alternative
 * failure (handing out an occupied port) happens every time.
 *
 * ---------------------------------------------------------------------------------------------
 * Why an agent's server is a child of THIS process, not of the turn
 * ---------------------------------------------------------------------------------------------
 * `core/spawnCli.ts`'s killCliTree kills a CLI and its entire process tree, with taskkill /T on
 * Windows. That is correct and must stay: a hung provider CLI leaves real, billed work running
 * against a turn the user already stopped, and killing only the handle we hold misses it.
 *
 * But a dev server the agent started inside that turn IS in the tree, so the same kill that
 * saves the user from a runaway CLI is what makes "it's live at localhost:4321" false by the
 * time they click it. Both things are true at once and neither can be given up.
 *
 * The resolution is not to change what killCliTree kills, but to stop the server ever being in
 * that tree. `start_server` is a tool the agent CALLS, and the process it starts is spawned HERE,
 * by the Solace server, detached and unref'd. It is a sibling of the turn, not a descendant, so
 * killCliTree cannot reach it no matter how thoroughly it walks the tree - and killCliTree needs
 * no exception, no allowlist and no pid filtering to stay exactly as correct as it was.
 *
 * ---------------------------------------------------------------------------------------------
 * Why a TOOL and not detection
 * ---------------------------------------------------------------------------------------------
 * The alternative considered was watching what an agent backgrounds and adopting anything that
 * looks like a server. It was rejected, and the reason is worth keeping:
 *
 *  1. It requires guessing which child is a server and which is a runaway CLI - which is the
 *     precise distinction killCliTree's correctness rests on. A wrong guess either orphans a hung
 *     CLI (the bug killCliTree exists to fix) or kills a working dev server. There is no evidence
 *     available at detection time that separates them: both are long-lived, both hold sockets.
 *  2. Most agents here run inside a provider CLI whose own child processes this app never sees.
 *     Detection would work for one provider and silently not for the others, which is worse than
 *     not working - it would make the panel's emptiness meaningless.
 *  3. A detected process yields no reliable port, no intent and no owner. The tool call yields
 *     all three by construction, at the moment the agent commits to them.
 *
 * The cost is honest and stated in the tool description: a server started with a plain shell
 * command still dies with its turn. That is a thing the agent can see and fix, unlike a
 * detection layer that silently misses half the cases.
 */

/** Where an agent's server gets its stdout/stderr. Under the workspace root so it survives
 * restarts and the operator can read why a server died on boot. */
const LOG_DIR_NAME = ".solace-servers";

/** The default hunting ground. Deliberately away from 3000/5173/8080 - the ranges every
 * framework's own default lands in, and therefore where a collision with something this
 * registry knows nothing about is most likely. */
const DEFAULT_RANGE_START = 4400;
const DEFAULT_RANGE_END = 4599;

export interface ReserveOptions {
  /** A port the agent specifically wants. Honoured only if it is free AND unheld; otherwise the
   * registry says why and hands back a different one. */
  preferred?: number;
  purpose?: string;
  chatId?: string;
}

export type ReserveResult =
  | {
      ok: true;
      port: number;
      /** Set when `preferred` was asked for and refused, saying exactly why - "@codex holds it"
       * or "something outside Solace is listening on it". This is the message that ends a port
       * fight, so it is a first-class field rather than prose in a log line. */
      preferredRefused?: string;
    }
  | { ok: false; error: string };

/**
 * Is this port genuinely free right now?
 *
 * A bind, not a connect. A connect test says "nothing answered", which is also what a port held
 * by a process that is bound but not yet accepting says, and what a firewalled port says. A bind
 * that succeeds is the operating system stating that this port is available to us.
 */
export async function isPortFree(port: number): Promise<boolean> {
  for (const host of ["127.0.0.1", "0.0.0.0"]) {
    if (!(await bindable(port, host))) return false;
  }
  return true;
}

function bindable(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      probe.removeAllListeners();
      try {
        probe.close();
      } catch {
        /* already closed */
      }
      resolve(ok);
    };
    probe.once("error", () => finish(false));
    probe.once("listening", () => finish(true));
    try {
      // exclusive: true asks the OS NOT to share the port with another socket that set
      // SO_REUSEADDR. Without it, on some platforms this probe can succeed on a port another
      // process is already serving on, which would make the whole test a lie.
      probe.listen({ port, host, exclusive: true });
    } catch {
      finish(false);
    }
  });
}

/** Is a process with this pid still alive? Signal 0 performs the permission-and-existence check
 * without delivering anything. EPERM means it exists and is not ours to signal, which for our
 * purposes is still "alive" - we spawned it, so in practice this only fires across a restart. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Kill a detached server and everything it spawned.
 *
 * Same reasoning as killCliTree (`npm run dev` is a shell that forks the real server), but it
 * takes a pid rather than a ChildProcess handle: after a Solace restart the record is all we
 * have, and a kill that only worked while we still held the handle would mean a server survives
 * a restart with no way to stop it.
 */
export function killServerTree(pid: number): void {
  if (!pidAlive(pid)) return;
  if (process.platform !== "win32") {
    // Negative pid = the process group, which detached:true gave this process its own of.
    try {
      process.kill(-pid, "SIGTERM");
      return;
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* gone between the liveness check and here */
      }
      return;
    }
  }
  try {
    spawnCli("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {
      try {
        process.kill(pid);
      } catch {
        /* gone */
      }
    });
  } catch {
    try {
      process.kill(pid);
    } catch {
      /* gone */
    }
  }
}

export class PortRegistry {
  private reservations: PortReservation[];
  private servers: RunningServer[];

  /** Set by index.ts, to persist. */
  onChange: (() => void) | null = null;
  /** Set by index.ts, to broadcast. Called after every change that alters what the UI shows. */
  onBroadcast: ((state: PortRegistryState) => void) | null = null;

  constructor(
    initial: PortRegistryState = emptyPortRegistry(),
    private readonly workspaceRoot: string = process.cwd(),
  ) {
    this.reservations = Array.isArray(initial?.reservations) ? [...initial.reservations] : [];
    // A restart is the one moment where every server record is a claim rather than an
    // observation: the processes were our children and we no longer hold their handles. Each
    // one is re-verified against its pid on the way in, and anything gone is marked stopped
    // rather than being listed as running - which is the same class of bug as the one this
    // whole file exists to fix, in our own UI this time.
    this.servers = (Array.isArray(initial?.servers) ? initial.servers : []).map((s) =>
      s.stoppedAt || pidAlive(s.pid) ? s : { ...s, stoppedAt: new Date().toISOString(), stoppedReason: "exited" as const },
    );
    // A reservation whose server has died is released: the whole point of the registry is that
    // a port nobody is using goes to whoever asks next. A reservation with no server record at
    // all is a bare reserve_port and is KEPT - the agent may simply not have started it yet, and
    // silently revoking a port it was told it owned is the fight this is here to prevent.
    this.reservations = this.reservations.filter((r) => {
      const anyServer = this.servers.some((s) => s.port === r.port);
      if (!anyServer) return true;
      return this.servers.some((s) => s.port === r.port && !s.stoppedAt);
    });
  }

  snapshot(): PortRegistryState {
    return { reservations: [...this.reservations], servers: [...this.servers] };
  }

  /** The live view. Re-checks every pid, so a server that died on its own reads as stopped the
   * next time anyone looks rather than staying green forever. */
  list(): PortRegistryState {
    let changed = false;
    for (const server of this.servers) {
      if (server.stoppedAt) continue;
      if (pidAlive(server.pid)) continue;
      server.stoppedAt = new Date().toISOString();
      server.stoppedReason = "exited";
      this.releasePort(server.port, server.agentId);
      changed = true;
    }
    if (changed) this.changed();
    return this.snapshot();
  }

  private changed() {
    this.onChange?.();
    this.onBroadcast?.(this.snapshot());
  }

  holderOf(port: number): PortReservation | undefined {
    return this.reservations.find((r) => r.port === port);
  }

  // -------------------------------------------------------------------------------------
  // Reserving
  // -------------------------------------------------------------------------------------

  /**
   * Hand this agent a port nobody else holds and nothing else is listening on.
   *
   * Two separate gates, and both are load-bearing:
   *
   *  - the REGISTRY gate stops two agents being given the same number, which is the 4545
   *    incident. It is answered from memory and is exact.
   *  - the BIND gate stops any of them being given a number that is already occupied by
   *    something this app never knew about, which is every other way a server fails to start.
   *
   * Neither alone is enough, and the second one costs a real syscall per candidate, which is
   * why it is second.
   */
  async reserve(
    agent: { id: string; handle: string },
    options: ReserveOptions = {},
  ): Promise<ReserveResult> {
    let preferredRefused: string | undefined;

    if (options.preferred !== undefined) {
      const port = options.preferred;
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        preferredRefused = `${port} is not a usable port number - ports below 1024 are privileged and 65535 is the maximum.`;
      } else if (this.isNeverAllocatable(port)) {
        preferredRefused = `${port} is reserved: it belongs to Solace itself or to a local model runtime, and taking it would break the app you are talking through.`;
      } else {
        const held = this.holderOf(port);
        if (held && held.agentId !== agent.id) {
          preferredRefused = `@${held.handle} reserved ${port} at ${new Date(held.at).toLocaleTimeString()}${held.purpose ? ` for ${held.purpose}` : ""}. Talk to them rather than taking it.`;
        } else if (!(await isPortFree(port))) {
          preferredRefused = `something outside Solace is already listening on ${port}.`;
        } else {
          return { ok: true, port: this.record(agent, port, options).port };
        }
      }
    }

    for (let port = DEFAULT_RANGE_START; port <= DEFAULT_RANGE_END; port += 1) {
      if (this.isNeverAllocatable(port)) continue;
      const held = this.holderOf(port);
      if (held && held.agentId !== agent.id) continue;
      if (!(await isPortFree(port))) continue;
      return { ok: true, port: this.record(agent, port, options).port, preferredRefused };
    }

    return {
      ok: false,
      error:
        `No port between ${DEFAULT_RANGE_START} and ${DEFAULT_RANGE_END} is both unreserved and actually free. ` +
        `Something is holding all of them - check the Running servers panel and stop what you no longer need.`,
    };
  }

  private isNeverAllocatable(port: number): boolean {
    return NEVER_ALLOCATE_PORTS.includes(port) || port === SERVER_PORT;
  }

  private record(agent: { id: string; handle: string }, port: number, options: ReserveOptions): PortReservation {
    const existing = this.holderOf(port);
    if (existing && existing.agentId === agent.id) {
      existing.purpose = options.purpose ?? existing.purpose;
      this.changed();
      return existing;
    }
    const reservation: PortReservation = {
      port,
      agentId: agent.id,
      handle: agent.handle,
      chatId: options.chatId,
      purpose: options.purpose,
      at: new Date().toISOString(),
    };
    this.reservations.push(reservation);
    this.changed();
    return reservation;
  }

  /** Give a port back. Only the holder may release it: a release by anyone else is how one
   * agent takes another's port while believing it is tidying up. */
  releasePort(port: number, agentId: string): boolean {
    const before = this.reservations.length;
    this.reservations = this.reservations.filter((r) => !(r.port === port && r.agentId === agentId));
    const removed = this.reservations.length !== before;
    if (removed) this.changed();
    return removed;
  }

  /** Drop everything an agent held, for when it is deleted - otherwise its ports would be
   * unavailable forever with nobody able to release them. Running servers it started are left
   * alone and explicitly NOT killed: the process is serving something, and deleting the agent
   * that happened to start it is not a request to take that down. */
  forgetAgent(agentId: string): void {
    const before = this.reservations.length;
    this.reservations = this.reservations.filter((r) => r.agentId !== agentId);
    if (this.reservations.length !== before) this.changed();
  }

  // -------------------------------------------------------------------------------------
  // Servers
  // -------------------------------------------------------------------------------------

  /**
   * Start a long-running process that will outlive the turn that asked for it.
   *
   * The port is reserved as part of the same act rather than being trusted from the argument:
   * a server started on a port somebody else holds is the incident, and there is no version of
   * "start it anyway and sort it out later" that ends well.
   */
  async startServer(
    agent: { id: string; handle: string },
    input: { command: string; cwd: string; port: number; chatId?: string; purpose?: string },
  ): Promise<{ ok: true; server: RunningServer } | { ok: false; error: string }> {
    const command = input.command.trim();
    if (!command) return { ok: false, error: "start_server needs a command to run." };
    if (/[\r\n]/.test(command)) {
      // Identical reasoning to agentTools.doRunCommand: a cmd.exe command line ends at the
      // first newline and throws the rest away with a zero exit code, which here would mean a
      // recorded, "running" server that is not the thing the agent asked for.
      return {
        ok: false,
        error:
          "the command contains a newline. A Windows command line ends at the first newline, so the rest would be silently discarded. Put it on one line with &&, or run a script file.",
      };
    }
    if (command.includes("\0")) return { ok: false, error: "the command contains a NUL byte." };

    const port = input.port;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      return { ok: false, error: `${input.port} is not a usable port. Call reserve_port first and pass what it gave you.` };
    }
    if (this.isNeverAllocatable(port)) {
      return { ok: false, error: `${port} is reserved: it belongs to Solace itself or to a local model runtime.` };
    }
    const held = this.holderOf(port);
    if (held && held.agentId !== agent.id) {
      return {
        ok: false,
        error:
          `@${held.handle} holds ${port}${held.purpose ? ` for ${held.purpose}` : ""}. ` +
          `Call reserve_port to get one of your own - do not restart what they are running.`,
      };
    }
    const runningHere = this.servers.find((s) => s.port === port && !s.stoppedAt && pidAlive(s.pid));
    if (runningHere) {
      return {
        ok: false,
        error: `@${runningHere.handle}'s server (pid ${runningHere.pid}) is already running on ${port}: ${runningHere.command}`,
      };
    }
    if (!(await isPortFree(port))) {
      return { ok: false, error: `something is already listening on ${port}. Call reserve_port and use the port it gives you.` };
    }

    const id = nanoid();
    const logDir = join(this.workspaceRoot, LOG_DIR_NAME);
    let logPath: string;
    let logFd: number;
    try {
      mkdirSync(logDir, { recursive: true });
      logPath = join(logDir, `${id}.log`);
      logFd = openSync(logPath, "a");
    } catch (err) {
      return { ok: false, error: `could not open a log file for the server: ${(err as Error).message}` };
    }

    let pid: number | undefined;
    try {
      // detached: true is the whole mechanism. On Windows it gives the child its own console
      // and process group; elsewhere it makes it a session leader. Either way it is no longer
      // reachable by a tree-walk from the turn's CLI - and, critically, it is a child of the
      // Solace server process, which outlives every turn by construction.
      //
      // stdio goes to a real file descriptor, not a pipe: a pipe would keep this process
      // attached to the child's output, so unref() would not actually let the event loop
      // forget it, and a chatty server would eventually block on a full buffer nobody reads.
      const child =
        process.platform === "win32"
          ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${command}"`], {
              cwd: input.cwd,
              detached: true,
              windowsVerbatimArguments: true,
              windowsHide: true,
              stdio: ["ignore", logFd, logFd],
            })
          : spawn(process.env.SHELL ?? "/bin/sh", ["-c", command], {
              cwd: input.cwd,
              detached: true,
              stdio: ["ignore", logFd, logFd],
            });
      pid = child.pid;
      // unref so Solace itself can exit without waiting on a server that is meant to keep
      // running. The child keeps its own reference to the log fd.
      child.unref();
    } catch (err) {
      closeSync(logFd);
      return { ok: false, error: `could not start the server: ${(err as Error).message}` };
    }
    // Our copy of the descriptor; the child inherited its own. Left open, every server started
    // would leak one for the lifetime of the Solace process.
    closeSync(logFd);

    if (typeof pid !== "number") {
      return { ok: false, error: "the process started but the OS reported no pid, so it could not be recorded or killed later." };
    }

    // Deliberately not falling back to the command as the purpose: this reservation now has a
    // server behind it, and the panel already shows the command line. A row reading
    // "reserved for node ..." would repeat it in the one place it adds nothing.
    this.record(agent, port, { chatId: input.chatId, purpose: input.purpose });
    const server: RunningServer = {
      id,
      port,
      pid,
      command,
      cwd: input.cwd,
      agentId: agent.id,
      handle: agent.handle,
      chatId: input.chatId,
      startedAt: new Date().toISOString(),
      logPath,
    };
    this.servers.push(server);
    this.changed();
    return { ok: true, server };
  }

  /** Stop a recorded server. Idempotent: a record whose process is already gone is marked
   * stopped rather than reported as an error, because from the operator's side clicking Kill on
   * something that just died is not a mistake. */
  stopServer(id: string, reason: "killed" | "exited" = "killed"): { ok: boolean; error?: string } {
    const server = this.servers.find((s) => s.id === id);
    if (!server) return { ok: false, error: "no server with that id" };
    if (!server.stoppedAt) {
      killServerTree(server.pid);
      server.stoppedAt = new Date().toISOString();
      server.stoppedReason = reason;
    }
    this.releasePort(server.port, server.agentId);
    this.changed();
    return { ok: true };
  }

  /** Stopped rows are kept so the panel can say "it stopped" instead of a row vanishing, but
   * not forever. Called when the list is fetched. */
  pruneStopped(keepMs = 30 * 60 * 1000): void {
    const cutoff = Date.now() - keepMs;
    const before = this.servers.length;
    this.servers = this.servers.filter((s) => !s.stoppedAt || Date.parse(s.stoppedAt) > cutoff);
    if (this.servers.length !== before) this.changed();
  }
}

/**
 * Ports and servers, as facts rather than claims.
 *
 * Three things in a real 28-chat run were prose where they needed to be state:
 *
 *  - Two agents fought over one port, twice (4545, then 5453). Each restarted a server the
 *    other was holding, because "I'll take 4545" was a sentence in a chat, not a record
 *    anybody could consult.
 *  - A server an agent started inside its turn died with the turn's process tree, so
 *    "it's live at localhost:4321" was true when written and false when clicked.
 *  - 22 "it's live" claims, 4 contradicted within fifteen messages. The URL checker existed
 *    and its result was a note in the stream, not a state on the message.
 *
 * Everything below is the shape of the answer. Nothing here carries an assumption: a
 * reservation names who holds it, a server carries the pid that proves it, and a UrlCheck
 * exists ONLY when a check actually ran.
 */

/** A port one agent holds. Handed out only after a real bind test - see core/portRegistry.ts. */
export interface PortReservation {
  port: number;
  /** AgentConfig.id of the holder. */
  agentId: string;
  handle: string;
  /** The chat the reservation was made in, for display. Reservations themselves are global:
   * a port is a property of the machine, and two agents in two chats fighting over one port
   * is the same fight as two agents in one chat doing it. */
  chatId?: string;
  /** What the agent said it was for, verbatim. */
  purpose?: string;
  at: string;
}

/**
 * A process Solace started on the agent's behalf and deliberately did NOT parent to the turn.
 *
 * `pid` is the whole point: it is what makes "running" checkable rather than remembered. Every
 * list of these re-verifies liveness before reporting, so a record that outlived its process
 * reads as stopped rather than as a server.
 */
export interface RunningServer {
  id: string;
  /** The port the agent declared. Reserved in the same act, so it cannot be double-handed. */
  port: number;
  /** The OS pid of the detached process. */
  pid: number;
  /** The command line, exactly as the agent gave it. */
  command: string;
  cwd: string;
  agentId: string;
  handle: string;
  chatId?: string;
  startedAt: string;
  /** Where the process's combined output is being written, so a server that dies on boot can
   * be explained instead of just disappearing. */
  logPath: string;
  /** Set once the process is observed gone (killed from the UI, or exited on its own). A
   * stopped record is kept briefly so the UI can say "it stopped" rather than silently
   * dropping the row out from under the reader. */
  stoppedAt?: string;
  /** Why it stopped, when we know: "killed" (from the UI) or "exited". Never guessed. */
  stoppedReason?: "killed" | "exited";
}

/**
 * One real check of one localhost URL an agent posted.
 *
 * There is no "assumed", "probably" or "pending" member here, on purpose. A URL that could not
 * be checked is represented by the ABSENCE of a UrlCheck, which the UI renders as nothing at
 * all - not as a tick, and not as a cross. `checkedAt` is mandatory for the same reason it is
 * on ConnectionCheck: every one of these stops being true the moment the process exits.
 */
export interface UrlCheck {
  /** The URL exactly as it appeared in the message, so the UI can attach the badge to it. */
  url: string;
  host: string;
  port: number;
  /** True only when something actually answered. An ECONNREFUSED is a real answer: false. */
  reachable: boolean;
  /** The HTTP status line's code, when an HTTP response actually came back. Absent when the
   * TCP connection succeeded but no HTTP response was parsed - which is still `reachable`. */
  status?: number;
  /** What was observed, verbatim where possible: "HTTP 200", "ECONNREFUSED", "timed out after
   * 2000ms". Never a phrase invented about what probably happened. */
  detail: string;
  checkedAt: string;
}

export interface PortRegistryState {
  reservations: PortReservation[];
  servers: RunningServer[];
}

export function emptyPortRegistry(): PortRegistryState {
  return { reservations: [], servers: [] };
}

/**
 * Ports this registry will never hand out, whatever the range says.
 *
 * The first four are the operator's two live Solace instances (server + web dev server for
 * each). An agent handed one of those would take down the very app it is talking through, and
 * it has happened: an agent "freed up" a port by killing what was on it. The rest are the
 * loopback endpoints in providerCatalog.ts - Ollama, LM Studio, Jan and friends - which are
 * somebody's model runtime, not a free port.
 */
export const NEVER_ALLOCATE_PORTS: readonly number[] = [
  4310, 4320, 5173, 5183, // Solace itself, stable + dev, server + web
  11434, 1234, 1337, 5001, 4891, 8080, 8000, // local model runtimes
];

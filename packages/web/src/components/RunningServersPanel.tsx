import { useEffect, useState } from "react";
import type { PortRegistryState, RunningServer } from "@solace/shared";
import { fetchServers, stopServer } from "../api";

/**
 * Running servers: what is up, on which port, started by which agent, with Open and Kill.
 *
 * Two rules, both inherited from ConnectionsPanel and both load-bearing here:
 *
 *  1. Nothing is green that was not checked. Every row in this list was verified against a real
 *     process id by the server immediately before it was sent (see core/portRegistry.ts), and a
 *     record whose process has gone reads as "stopped", not as a server. A panel that showed a
 *     dead pid as running would be Solace making exactly the unverified claim it badges agents
 *     for.
 *  2. The port is the first thing on the row, because the port is what agents fight over. Two
 *     separate incidents had two agents each restarting a server the other was holding; the
 *     answer to "is 4545 taken, and by whom" has to be readable at a glance, not derived from
 *     a command line.
 *
 * Spacing carries the grouping here rather than borders: the port and the command are one unit
 * (--space-1 apart), the owner line is a second (--space-1 below), and rows are separated by
 * --space-1 with the row's own padding doing the rest. Every value comes off the space scale.
 */

function uptime(startedAt: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(startedAt)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function shortTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function RunningServersPanel() {
  const [state, setState] = useState<PortRegistryState>({ reservations: [], servers: [] });
  /** Which row's Kill is in flight, so the button can say so instead of looking unresponsive
   * while taskkill walks the tree. */
  const [killing, setKilling] = useState<string | null>(null);
  /** Re-rendered on a timer only so the uptime figure stays honest; the data itself arrives
   * over the socket. */
  const [, setTick] = useState(0);

  const refresh = () => void fetchServers().then(setState);

  useEffect(() => {
    refresh();
    // The socket carries servers:updated, which App forwards by calling refresh through the
    // custom event below. This interval exists for the uptime column alone.
    const timer = setInterval(() => setTick((t) => t + 1), 30_000);
    const onUpdate = () => refresh();
    window.addEventListener("solace:servers-updated", onUpdate);
    return () => {
      clearInterval(timer);
      window.removeEventListener("solace:servers-updated", onUpdate);
    };
  }, []);

  const running = state.servers.filter((s) => !s.stoppedAt);
  // A reservation with no server behind it is an agent that has taken a port and not started
  // anything on it yet. It is shown, because "who has 4545" is the question this panel exists
  // to answer, and the answer is not only "whoever is serving on it".
  const heldOnly = state.reservations.filter((r) => !running.some((s) => s.port === r.port));

  const kill = async (server: RunningServer) => {
    if (!confirm(`Stop ${server.command} on port ${server.port}? It was started by @${server.handle}.`)) return;
    setKilling(server.id);
    try {
      await stopServer(server.id);
      refresh();
    } finally {
      setKilling(null);
    }
  };

  if (running.length === 0 && heldOnly.length === 0) {
    return (
      <section className="sidebar-group">
        <div className="sidebar-section-label">Running servers</div>
        <div className="sidebar-empty">
          Nothing is running. A server an agent starts with <code>start_server</code> appears here and keeps running
          after that agent's turn ends.
        </div>
      </section>
    );
  }

  return (
    <section className="sidebar-group">
      <div className="sidebar-section-label">
        Running servers
        <span className="count">{running.length}</span>
      </div>

      <div className="server-list">
        {running.map((server) => (
          <div className="server-row" key={server.id}>
            <div className="server-head">
              <a
                className="server-port"
                href={`http://localhost:${server.port}`}
                target="_blank"
                rel="noreferrer"
                title={`Open http://localhost:${server.port}`}
              >
                :{server.port}
              </a>
              {/* The command is what distinguishes two servers on two ports, so it gets the
                  room, truncating rather than wrapping the row into two heights. */}
              <span className="server-command" title={`${server.command}\n${server.cwd}`}>
                {server.command}
              </span>
              <button
                className="icon-btn server-kill"
                onClick={() => void kill(server)}
                disabled={killing === server.id}
                aria-label={`Stop the server on port ${server.port}`}
                title="Stop this server"
              >
                <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                  <rect x="4.25" y="4.25" width="7.5" height="7.5" rx="1" />
                </svg>
              </button>
            </div>
            {/* Owner, uptime and pid on one quiet line. The pid is here because it is the thing
                that makes "running" checkable, and the operator occasionally needs it. */}
            <div className="server-meta">
              <span className="server-owner">@{server.handle}</span>
              <span className="sep">·</span>
              <span>up {uptime(server.startedAt)}</span>
              <span className="sep">·</span>
              <span title={`started ${shortTime(server.startedAt)}`}>pid {server.pid}</span>
            </div>
          </div>
        ))}

        {heldOnly.map((reservation) => (
          <div className="server-row is-held" key={`held-${reservation.port}`}>
            <div className="server-head">
              <span className="server-port is-held">:{reservation.port}</span>
              <span className="server-command">{reservation.purpose ?? "reserved, nothing started yet"}</span>
            </div>
            <div className="server-meta">
              <span className="server-owner">@{reservation.handle}</span>
              <span className="sep">·</span>
              <span>held since {shortTime(reservation.at)}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

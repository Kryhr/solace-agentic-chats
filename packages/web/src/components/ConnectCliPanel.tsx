import { useEffect, useMemo, useRef, useState } from "react";
import type { ConnectionCheck, ProviderId } from "@solace/shared";
import {
  checkCliConnection,
  CliNotInstalledError,
  connectCli,
  disconnectCli,
  type ConnectableProvider,
} from "../api";
import { ProviderIcon } from "./ProviderIcon";

/**
 * The connect flow for coding-agent CLIs: a card per supported provider, a search box over
 * them, and two buttons per card that do two genuinely different things.
 *
 * Why this screen replaced the old one. The previous CLI screen was a read-only report of what
 * was installed, and the panel behind it listed a sidebar row for every installed binary. That
 * conflated two things the user keeps separate: **installed is a fact about the machine,
 * connected is a decision.** Six CLIs on PATH became six rows nobody asked for. So connecting
 * is now an explicit act, performed here.
 *
 * Three rules this file is built around:
 *
 *  1. The command shown is the SIGN-IN command, not the install command. Somebody looking at
 *     this card already has, or is about to have, the binary; "npm install -g …" tells them
 *     nothing about getting signed in. Each one was read off that CLI's own --help, and the
 *     line that says where is rendered on the card, so it can be re-checked rather than
 *     believed. Where a CLI has no sign-in subcommand at all, the card says that instead of
 *     printing a command that does not exist.
 *
 *  2. "Add connection" verifies first. It calls the server, which runs the real `<bin>
 *     --version` and refuses on anything but a pass. A refusal is rendered as a refusal, with
 *     the install command - never as a connection that quietly happened anyway.
 *
 *  3. Nothing here claims a sign-in state. `--version` proves the binary RUNS. It does not and
 *     cannot prove the CLI is signed in, and no word on this screen suggests otherwise - the
 *     note at the top says so outright, and the Test result is the probe's own sentence rather
 *     than a verdict written here.
 */

/** A command the user is meant to run somewhere else, shown as literal copyable text. */
function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="command-line">
      <code>{command}</code>
      <button className="btn-ghost btn-xs" onClick={copy} title="Copy this command">
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/** What one card is currently able to say about itself. Every non-idle state here is the
 * result of something that really ran; there is no "probably fine". */
type CardState =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "connecting" }
  /** A real `--version` probe came back. `check.detail` is the CLI's own line. */
  | { status: "tested"; check: ConnectionCheck }
  /** Connecting was refused because the probe failed. Carries what it printed. */
  | { status: "refused"; message: string; detail?: string; installCommand?: string }
  | { status: "error"; message: string };

function matches(p: ConnectableProvider, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const hay = `${p.name} ${p.blurb} ${p.signInCommand ?? ""} ${p.signInNote ?? ""} ${p.caveat ?? ""} ${p.provider}`.toLowerCase();
  return terms.every((t) => hay.includes(t));
}

export function ConnectCliPanel({
  catalog,
  connected,
  onConnectedChange,
}: {
  catalog: ConnectableProvider[];
  connected: ProviderId[];
  /**
   * Hands the new list straight back up, so the sidebar behind this modal updates the moment a
   * connection is really made rather than on the next page load.
   *
   * `verified` carries the check that authorised the connection, for exactly one reason: the
   * sidebar seeds its rows from a batch probe taken at page load, and that snapshot can be
   * several minutes old (or, when six CLIs are probed at once, can have timed out on one of
   * them). A row that appears because a check just passed must show THAT check, not an older
   * and possibly contradictory one.
   */
  onConnectedChange: (next: ProviderId[], verified?: { provider: ProviderId; check: ConnectionCheck }) => void;
}) {
  const [filter, setFilter] = useState("");
  const [states, setStates] = useState<Record<string, CardState>>({});
  const filterRef = useRef<HTMLInputElement>(null);

  const terms = useMemo(() => filter.trim().toLowerCase().split(/\s+/).filter(Boolean), [filter]);
  const shown = useMemo(() => catalog.filter((p) => matches(p, terms)), [catalog, terms]);

  // Same affordance the Settings filter has: Escape from inside the box clears it, rather than
  // closing the modal out from under a half-typed search.
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape" && filter) {
      e.stopPropagation();
      setFilter("");
    }
  };

  useEffect(() => {
    filterRef.current?.focus();
  }, []);

  const stateOf = (id: ProviderId): CardState => states[id] ?? { status: "idle" };
  const setState = (id: ProviderId, s: CardState) => setStates((prev) => ({ ...prev, [id]: s }));

  /** The same `--version` probe the sidebar's Check runs. Reports what it printed, verbatim. */
  const test = async (id: ProviderId) => {
    setState(id, { status: "testing" });
    try {
      const check = await checkCliConnection(id);
      setState(id, { status: "tested", check });
    } catch (err) {
      setState(id, { status: "error", message: (err as Error).message });
    }
  };

  /** Verify, then connect - in that order, on the server, in one request. A CliNotInstalledError
   * means the probe ran and failed, and nothing was added. */
  const add = async (id: ProviderId) => {
    setState(id, { status: "connecting" });
    try {
      const result = await connectCli(id);
      onConnectedChange(result.connected, { provider: id, check: result.check });
      setState(id, { status: "tested", check: result.check });
    } catch (err) {
      if (err instanceof CliNotInstalledError) {
        setState(id, { status: "refused", message: err.message, detail: err.detail, installCommand: err.installCommand });
      } else {
        setState(id, { status: "error", message: (err as Error).message });
      }
    }
  };

  const remove = async (id: ProviderId) => {
    setState(id, { status: "connecting" });
    try {
      onConnectedChange(await disconnectCli(id));
      setState(id, { status: "idle" });
    } catch (err) {
      setState(id, { status: "error", message: (err as Error).message });
    }
  };

  return (
    <div className="guide">
      <p className="field-note">
        These run on this machine, against your own subscription - Solace shells out to them and never holds a login for them.
        Connecting one adds it to your sidebar; it does not install anything and does not sign you in.
      </p>

      <div className="cli-search">
        <svg
          className="cli-search-icon"
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="7.2" cy="7.2" r="4.4" />
          <path d="M10.4 10.4 13.5 13.5" />
        </svg>
        <input
          ref={filterRef}
          className="cli-search-input"
          type="search"
          value={filter}
          placeholder="Search CLIs"
          aria-label="Search coding agent CLIs by name or description"
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {/* Polite, not assertive: it changes on every keystroke and would otherwise interrupt a
            screen-reader user mid-word. */}
        <span className="cli-search-count" aria-live="polite">
          {terms.length === 0 ? `${catalog.length} CLIs` : `${shown.length} of ${catalog.length}`}
        </span>
        {terms.length > 0 && (
          <button type="button" className="cli-search-clear" onClick={() => setFilter("")}>
            Clear
          </button>
        )}
      </div>

      {shown.length === 0 ? (
        /* A filter that matches nothing has to SAY nothing matched, and offer the way out. An
           empty column looks identical to a screen that failed to load. */
        <div className="cli-empty">
          <div className="cli-empty-title">Nothing matches “{filter.trim()}”</div>
          <div className="cli-empty-body">
            No CLI has that in its name or description.{" "}
            <button type="button" className="cli-inline-link" onClick={() => setFilter("")}>
              Show all {catalog.length} CLIs
            </button>
          </div>
        </div>
      ) : (
        <div className="cli-card-list">
          {shown.map((p) => {
            const state = stateOf(p.provider);
            const isConnected = connected.includes(p.provider);
            const busy = state.status === "testing" || state.status === "connecting";
            return (
              <div key={p.provider} className={`cli-card ${isConnected ? "is-connected" : ""}`}>
                <div className="cli-card-id">
                  <div className="cli-card-head">
                    <ProviderIcon provider={p.provider} size={20} />
                    <span className="cli-card-name">{p.name}</span>
                    {isConnected && <span className="cli-card-badge">Connected</span>}
                  </div>
                  <p className="cli-card-blurb">{p.blurb}</p>
                  {/* Sits with the blurb rather than down by the buttons: it is part of what
                      this provider IS, and the point is to be read before Add connection, not
                      discovered afterwards. */}
                  {p.caveat && (
                    <p className="cli-card-caveat">
                      <span className="cli-card-caveat-label">Limitation</span>
                      {p.caveat}
                    </p>
                  )}
                </div>

                <div className="cli-card-signin">
                  <span className="cli-card-label">Sign in</span>
                  {p.signInCommand ? (
                    <CommandLine command={p.signInCommand} />
                  ) : (
                    <div className="cli-card-note">{p.signInNote ?? "Check the provider's docs for how to sign in."}</div>
                  )}
                  {/* Provenance, on the card. A command you can check beats a command you have
                      to trust, and these do drift between releases. */}
                  <div className="cli-card-source">From {p.signInSource}.</div>
                </div>

                <div className="cli-card-actions">
                  <button className="btn-secondary btn-xs" onClick={() => test(p.provider)} disabled={busy}>
                    {state.status === "testing" ? "Testing…" : "Test"}
                  </button>
                  {isConnected ? (
                    <button
                      className="btn-ghost btn-xs"
                      onClick={() => remove(p.provider)}
                      disabled={busy}
                      title="Remove it from your sidebar. Nothing is uninstalled and nothing is signed out."
                    >
                      Disconnect
                    </button>
                  ) : (
                    <button
                      className="btn-primary btn-xs"
                      onClick={() => add(p.provider)}
                      disabled={busy}
                      title={`Run ${p.name}'s own --version first, and connect it only if that passes`}
                    >
                      {state.status === "connecting" ? "Checking…" : "Add connection"}
                    </button>
                  )}
                </div>

                {/* The result, in the tool's own words. Never a verdict written here. */}
                {state.status === "tested" && (
                  <div className={`cli-card-result ${state.check.ok ? "is-ok" : "is-fail"}`} role="status">
                    <span className={`connection-dot ${state.check.ok ? "ok" : "fail"}`} />
                    <span>
                      {state.check.detail}
                      <span className="cli-card-result-when"> · {new Date(state.check.checkedAt).toLocaleTimeString()}</span>
                    </span>
                  </div>
                )}
                {state.status === "refused" && (
                  <div className="cli-card-refusal" role="alert">
                    <div>{state.message}</div>
                    {state.detail && <div className="cli-card-source">{state.detail}</div>}
                    {state.installCommand && <CommandLine command={state.installCommand} />}
                  </div>
                )}
                {state.status === "error" && (
                  <div className="cli-card-refusal" role="alert">
                    {state.message}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="field-note">
        Test and Add connection both run the CLI's own <code>--version</code>. That proves the binary is there and runs - it is
        not a sign-in check, and Solace cannot see whether you are signed in without spending a real turn.
      </div>
    </div>
  );
}

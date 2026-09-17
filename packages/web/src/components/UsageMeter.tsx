import type { AccountUsage } from "@solace/shared";
import { Popover } from "./Popover";
import { ProviderIcon, providerLabel } from "./ProviderIcon";

/**
 * Rate-limit usage per ACCOUNT, shown next to the composer.
 *
 * Every number here came out of a provider's own CLI output and is rendered as reported: the
 * bar width IS the reported percentage, the reset time IS the reported reset time, and the
 * "as of" is when that report arrived. Neither CLI has a pollable quota endpoint - the numbers
 * only ever arrive mid-turn - so an account that hasn't reported yet says exactly that instead
 * of showing an empty or zeroed bar, and no figure is ever derived from token counts, message
 * counts, elapsed time, or anything else that isn't the provider's own percentage.
 *
 * One row per account, not per provider. Two agents on two different Claude subscriptions used
 * to collapse into one "Claude Code" row showing whichever account had spoken most recently,
 * against both - so the operator could read 12% used and believe a second, nearly-spent
 * subscription had plenty left. Each row is identified by its account label, with the email and
 * plan the CLI itself reported (`claude auth status`, which costs no turn) underneath - see
 * accountName below for why the label leads and not the email.
 */
function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}

function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatReset(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  const sameDay = new Date().toDateString() === date.toDateString();
  return date.toLocaleString([], {
    ...(sameDay ? {} : { month: "short", day: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
  });
}

function GaugeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M4 18a8 8 0 1 1 16 0" />
      <path d="M12 18l4.5-5" />
    </svg>
  );
}

/**
 * What to call this row, and what to say underneath it.
 *
 * The LABEL is the headline, not the email - and that is a finding, not a preference. Probed
 * live against the operator's own two Claude logins, `claude auth status` returned the SAME
 * email for both ("andr3w244@gmail.com") on two genuinely different subscriptions: one team,
 * one max. Leading with the email would have printed two identical-looking rows for two
 * different quotas, which is the very confusion this whole change exists to end. The label is
 * unique by construction (it is a directory name), and there is exactly one default login.
 *
 * The email and plan still appear, on the second line, because they are the CLI's own answer to
 * "which subscription is this" and are often the only way to tell two labels apart. Where a CLI
 * reports neither, the line falls back to the provider's name alone - never a fabricated one.
 */
function accountName(row: AccountUsage): string {
  return row.account ?? "Default login";
}

export function UsageMeter({ accounts }: { accounts: AccountUsage[] }) {
  // The trigger's headline figure is the single highest window any ACCOUNT reported, i.e. the
  // login closest to running out. It is that account's own number, shown unchanged - it is
  // picked, not computed, and it is never an average across accounts (which would be a figure
  // no provider ever reported about anything).
  const highest = accounts
    .flatMap((row) => (row.rateLimit?.windows ?? []).map((window) => ({ row, window })))
    .sort((a, b) => b.window.usedPercent - a.window.usedPercent)[0];

  return (
    <Popover
      label="Rate-limit usage"
      align="right"
      triggerClassName="usage-trigger"
      panelClassName="usage-popover"
      trigger={
        <>
          <GaugeIcon />
          {highest && <span className="usage-trigger-value">{formatPercent(highest.window.usedPercent)}</span>}
        </>
      }
    >
      <div className="usage-popover-head">
        <span>Rate limits</span>
        <span className="usage-popover-note">per account, as each CLI reported</span>
      </div>
      {accounts.length === 0 && <p className="usage-empty">No agents configured yet.</p>}
      {accounts.map((row) => (
        <section key={`${row.provider}|${row.account ?? ""}`} className="usage-account">
          <header className="usage-account-head">
            <ProviderIcon provider={row.provider} size={15} />
            <div className="usage-account-id">
              <span className="usage-account-name" title={accountName(row)}>
                {accountName(row)}
              </span>
              <span className="usage-account-sub">
                {[
                  providerLabel(row.provider),
                  // Only when the CLI actually said. An account whose CLI reports no identity
                  // is named by its label alone rather than by anything inferred.
                  row.email,
                  row.agentHandles.length > 0 ? row.agentHandles.map((h) => `@${h}`).join(" ") : undefined,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
            {row.plan && <span className="usage-plan">{row.plan}</span>}
          </header>
          {!row.rateLimit ? (
            <p className="usage-empty">
              {/* Deliberately not a 0% bar. Nothing has been observed for THIS login, and a
                  filled-in zero would be a number no provider ever reported. */}
              {row.loggedIn === false
                ? "Not signed in on this account yet."
                : "No usage reported yet — run a turn to find out."}
            </p>
          ) : (
            <>
              {row.rateLimit.windows.map((w) => (
                <div key={w.key} className="usage-window">
                  <div className="usage-window-head">
                    <span>{w.label}</span>
                    <span className="usage-window-pct">{formatPercent(w.usedPercent)} used</span>
                  </div>
                  <div
                    className="usage-bar"
                    role="img"
                    aria-label={`${accountName(row)}, ${w.label}: ${formatPercent(w.usedPercent)} used`}
                  >
                    <div className="usage-bar-fill" style={{ width: `${Math.min(w.usedPercent, 100)}%` }} />
                  </div>
                  {w.resetsAt !== undefined && <div className="usage-window-reset">resets {formatReset(w.resetsAt)}</div>}
                </div>
              ))}
              <div className="usage-observed">as of {formatClock(row.rateLimit.observedAt)}</div>
            </>
          )}
        </section>
      ))}
    </Popover>
  );
}

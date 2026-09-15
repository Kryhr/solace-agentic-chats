import type { ProviderId, ProviderRateLimit } from "@solace/shared";
import { Popover } from "./Popover";
import { providerLabel } from "./ProviderIcon";

/**
 * Rate-limit usage per provider, shown next to the composer.
 *
 * Every number here came out of a provider's own CLI output and is rendered as reported: the
 * bar width IS the reported percentage, the reset time IS the reported reset time, and the
 * "as of" is when that report arrived. Neither CLI has a pollable quota endpoint - the numbers
 * only ever arrive mid-turn - so a provider that hasn't reported yet says exactly that instead
 * of showing an empty or zeroed bar, and no figure is ever derived from token counts, message
 * counts, elapsed time, or anything else that isn't the provider's own percentage.
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

export function UsageMeter({
  rateLimits,
  providersInUse,
}: {
  rateLimits: ProviderRateLimit[];
  /** Providers that actually have an agent configured - the meter only talks about CLIs in use. */
  providersInUse: ProviderId[];
}) {
  // The trigger's headline figure is the single highest window any provider reported, i.e. the
  // one closest to running out. It is that provider's own number, shown unchanged - it is
  // picked, not computed.
  const highest = rateLimits
    .flatMap((r) => r.windows.map((w) => ({ observation: r, window: w })))
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
        <span className="usage-popover-note">as each provider reported them</span>
      </div>
      {providersInUse.length === 0 && <p className="usage-empty">No agents configured yet.</p>}
      {providersInUse.map((provider) => {
        const observation = rateLimits.find((r) => r.provider === provider);
        return (
          <section key={provider} className="usage-provider">
            <header className="usage-provider-head">
              <span className="usage-provider-name">{providerLabel(provider)}</span>
              {observation?.planType && <span className="usage-plan">{observation.planType}</span>}
            </header>
            {!observation ? (
              <p className="usage-empty">No usage reported yet — run a turn to find out.</p>
            ) : (
              <>
                {observation.windows.map((w) => (
                  <div key={w.key} className="usage-window">
                    <div className="usage-window-head">
                      <span>{w.label}</span>
                      <span className="usage-window-pct">{formatPercent(w.usedPercent)} used</span>
                    </div>
                    <div
                      className="usage-bar"
                      role="img"
                      aria-label={`${w.label}: ${formatPercent(w.usedPercent)} used`}
                    >
                      <div className="usage-bar-fill" style={{ width: `${Math.min(w.usedPercent, 100)}%` }} />
                    </div>
                    {w.resetsAt !== undefined && <div className="usage-window-reset">resets {formatReset(w.resetsAt)}</div>}
                  </div>
                ))}
                <div className="usage-observed">as of {formatClock(observation.observedAt)}</div>
              </>
            )}
          </section>
        );
      })}
    </Popover>
  );
}

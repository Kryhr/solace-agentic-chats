import type { UrlCheck } from "@solace/shared";

/**
 * The ✓/✗ on a message that names a localhost URL.
 *
 * The one rule this component enforces at the render layer, as well as at the check layer: a
 * badge is drawn only from a real `UrlCheck`. There is no "unknown" and no "pending" variant,
 * and `urlChecks` being absent renders nothing at all - not a grey tick, not a question mark.
 * A reader has to be able to take a ✓ literally, and the way to keep that true is that the
 * component has no way to draw one without an observation behind it.
 *
 * Every badge carries the status and the time, because both are what make it a fact rather than
 * a claim: "HTTP 200" is what the operator will actually get when they click, and a check from
 * four minutes ago cannot speak for now.
 */
function shortTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function UrlBadges({ checks }: { checks: UrlCheck[] | undefined }) {
  if (!checks || checks.length === 0) return null;
  return (
    <div className="url-badges">
      {checks.map((check) => (
        <span
          key={`${check.host}:${check.port}`}
          className={`url-badge ${check.reachable ? "is-ok" : "is-fail"}`}
          // The hover carries the whole observation verbatim, including the host form that was
          // actually dialled, so a badge can always be traced to what produced it.
          title={`${check.url} - ${check.detail}, checked ${shortTime(check.checkedAt)}`}
        >
          <span className="url-badge-mark" aria-hidden="true">
            {check.reachable ? "✓" : "✗"}
          </span>
          <span className="url-badge-port">:{check.port}</span>
          <span className="url-badge-detail">
            {/* The status, not a word standing in for it. "Live" would be this app inventing a
                summary of somebody else's HTTP response. */}
            {check.status !== undefined ? `HTTP ${check.status}` : check.detail}
          </span>
          <span className="url-badge-time">{shortTime(check.checkedAt)}</span>
        </span>
      ))}
    </div>
  );
}

import { useEffect, useState } from "react";
import type { ProviderId, ProviderStatus } from "@solace/shared";
import { fetchProviderStatuses, testProviderConnection } from "../api";
import { ProviderIcon, providerLabel } from "./ProviderIcon";

type TestResult = { ok: boolean; message: string } | { pending: true };

/** Mirrors the real row's shape (glyph + one line of text) rather than a spinner. */
function SkeletonRows() {
  return (
    <div className="connection-list" aria-hidden="true">
      {[52, 64, 46, 58].map((w, i) => (
        <div className="skeleton-row" key={i}>
          <span className="skeleton skeleton-glyph" />
          <span className="skeleton skeleton-line" style={{ width: `${w}%` }} />
        </div>
      ))}
    </div>
  );
}

export function ProvidersPanel() {
  const [statuses, setStatuses] = useState<ProviderStatus[] | null>(null);
  const [results, setResults] = useState<Record<string, TestResult>>({});

  useEffect(() => {
    fetchProviderStatuses()
      .then(setStatuses)
      .catch(() => setStatuses([]));
  }, []);

  const runTest = async (provider: ProviderId) => {
    setResults((r) => ({ ...r, [provider]: { pending: true } }));
    const result = await testProviderConnection(provider);
    setResults((r) => ({ ...r, [provider]: result }));
  };

  if (statuses === null) return <SkeletonRows />;

  return (
    <>
      {statuses.map((s) => {
        const result = results[s.provider];
        const pending = result !== undefined && "pending" in result;
        // The dot reflects whether we've actually proven a connection works, never just
        // "the CLI binary exists" - that distinction was confusing before this fix.
        const dotState = pending ? "pending" : !result ? "unknown" : "ok" in result && result.ok ? "ok" : "fail";
        const statusText = !s.installed
          ? "Not installed"
          : pending
            ? "Testing…"
            : result && "ok" in result
              ? result.ok
                ? "Connected"
                : "Failed"
              : "Installed";
        const tone = dotState === "ok" ? "is-ok" : dotState === "fail" ? "is-fail" : "";
        const detail = result && "ok" in result && !result.ok ? result.message : statusText;

        return (
          <div key={s.provider} className={`provider-row ${s.installed ? "is-testable" : ""}`}>
            <span className="provider-glyph">
              <ProviderIcon provider={s.provider} size={20} />
            </span>
            <span className="provider-name">{providerLabel(s.provider)}</span>

            <span className="provider-actions">
              <span className="provider-swap">
                <span className={`provider-status ${tone}`} title={detail}>
                  {statusText}
                </span>
                {s.installed && (
                  <button
                    className="btn-ghost btn-xs provider-test"
                    onClick={() => runTest(s.provider)}
                    disabled={pending}
                    title={`Run a real request against ${providerLabel(s.provider)}`}
                  >
                    {pending ? "Testing…" : "Test"}
                  </button>
                )}
              </span>
              <span className={`connection-dot ${dotState}`} title={detail} />
            </span>

            {!s.installed && <div className="provider-hint">{s.detail}</div>}
          </div>
        );
      })}
    </>
  );
}

import { useEffect, useState } from "react";
import type { ProviderId, ProviderStatus } from "@solace/shared";
import { fetchProviderStatuses, testProviderConnection } from "../api";
import { ProviderIcon, providerLabel } from "./ProviderIcon";

type TestResult = { ok: boolean; message: string } | { pending: true };

export function ProvidersPanel() {
  const [statuses, setStatuses] = useState<ProviderStatus[]>([]);
  const [results, setResults] = useState<Record<string, TestResult>>({});

  useEffect(() => {
    fetchProviderStatuses().then(setStatuses);
  }, []);

  const runTest = async (provider: ProviderId) => {
    setResults((r) => ({ ...r, [provider]: { pending: true } }));
    const result = await testProviderConnection(provider);
    setResults((r) => ({ ...r, [provider]: result }));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      {statuses.map((s) => {
        const result = results[s.provider];
        // The dot reflects whether we've actually proven a connection works, never just
        // "the CLI binary exists" - that distinction was confusing before this fix.
        const dotState = !result || "pending" in result ? "unknown" : result.ok ? "ok" : "fail";
        return (
          <div key={s.provider} className="provider-row">
            <div className="provider-row-top">
              <ProviderIcon provider={s.provider} size={20} />
              <span className="provider-name">{providerLabel(s.provider)}</span>
              <span
                className={`connection-dot ${dotState}`}
                title={
                  dotState === "unknown"
                    ? "Not tested yet"
                    : dotState === "ok"
                      ? "Last test succeeded"
                      : "Last test failed"
                }
              />
            </div>
            {!s.installed ? (
              <div className="provider-hint">{s.detail}</div>
            ) : (
              <>
                <div className="provider-hint">CLI installed</div>
                <div className="provider-row-bottom">
                  <button
                    className="btn-secondary"
                    style={{ padding: "4px 10px", fontSize: "0.75rem" }}
                    onClick={() => runTest(s.provider)}
                    disabled={result !== undefined && "pending" in result}
                  >
                    Test connection
                  </button>
                  {result && "pending" in result && <span className="provider-hint">checking…</span>}
                  {result && "ok" in result && (
                    <span className={result.ok ? "test-ok" : "test-fail"} title={result.message}>
                      {result.ok ? "connected" : result.message}
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

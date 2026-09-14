import { useEffect, useState } from "react";
import type { ProviderId, ProviderStatus } from "@solace/shared";
import { fetchProviderStatuses, testProviderConnection } from "../api";
import { ProviderIcon, providerLabel } from "./ProviderIcon";

type TestResult = { ok: boolean; message: string } | { pending: true };

export function ProvidersPanel() {
  const [statuses, setStatuses] = useState<ProviderStatus[]>([]);
  const [results, setResults] = useState<Record<string, TestResult>>({});

  const refresh = () => fetchProviderStatuses().then(setStatuses);

  useEffect(() => {
    refresh();
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
        return (
          <div key={s.provider} className="provider-row">
            <div className="provider-row-top">
              <ProviderIcon provider={s.provider} size={20} />
              <span className="provider-name">{providerLabel(s.provider)}</span>
              <span className={`install-dot ${s.installed ? "yes" : "no"}`} title={s.installed ? "CLI installed" : "CLI not found"} />
            </div>
            {!s.installed && <div className="provider-hint">{s.detail}</div>}
            {s.installed && (
              <div className="provider-row-bottom">
                <button className="btn-secondary" style={{ padding: "4px 10px", fontSize: "0.75rem" }} onClick={() => runTest(s.provider)}>
                  Test connection
                </button>
                {result && "pending" in result && <span className="provider-hint">checking…</span>}
                {result && "ok" in result && (
                  <span className={result.ok ? "test-ok" : "test-fail"}>{result.ok ? "connected" : result.message}</span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

import { useEffect, useState } from "react";

interface GithubStatus {
  authenticated: boolean;
  account?: string;
  detail?: string;
}

export function GithubPanel() {
  const [status, setStatus] = useState<GithubStatus | null>(null);

  useEffect(() => {
    fetch("/api/github/status")
      .then((r) => r.json())
      .then(setStatus);
  }, []);

  if (!status) return null;

  return (
    <div className="provider-row">
      <div className="provider-row-top">
        <span className="github-glyph">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
            <path d="M12 2a10 10 0 00-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.46-1.15-1.11-1.46-1.11-1.46-.9-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.08.63-1.33-2.22-.25-4.56-1.11-4.56-4.95 0-1.1.39-1.99 1.03-2.69-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.03a9.6 9.6 0 015 0c1.91-1.3 2.75-1.03 2.75-1.03.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.69 0 3.85-2.34 4.7-4.57 4.95.36.31.68.92.68 1.85v2.75c0 .26.18.58.69.48A10 10 0 0012 2z" />
          </svg>
        </span>
        <span className="provider-name">GitHub</span>
        <span className={`connection-dot ${status.authenticated ? "ok" : "unknown"}`} />
      </div>
      <div className="provider-hint">
        {status.authenticated ? `Connected as ${status.account}` : (status.detail ?? "Not connected")}
      </div>
    </div>
  );
}

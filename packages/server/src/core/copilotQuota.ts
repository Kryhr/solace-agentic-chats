import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { ProviderRateLimit, RateLimitWindow } from "@solace/shared";
import { copilotPlatformDir } from "../adapters/copilot-cli";

/**
 * Copilot's real quota for the signed-in account.
 *
 * Every other provider reports its limits INSIDE a turn - Claude's rate_limit_event, Codex's
 * token_count - so the usage meter learns them as a side effect of working. Copilot emits no
 * such event at all, so it was simply absent from the meter: an agent that had done real work
 * showed nothing, which reads as broken rather than as unknown.
 *
 * The SDK answers `account.getQuota` for the signed-in account, and it is a plain entitlement
 * lookup - not a model call, not billable. It returns three snapshots; `premium_interactions`
 * is the one that actually runs out (chat and completions come back
 * isUnlimitedEntitlement: true on this plan, so publishing a percentage for them would be
 * inventing a limit that does not exist).
 */
type QuotaSnapshot = {
  isUnlimitedEntitlement?: boolean;
  entitlementRequests?: number;
  usedRequests?: number;
  remainingPercentage?: number;
  resetDate?: string;
};

export function parseCopilotQuota(body: unknown, now = Date.now()): RateLimitWindow[] {
  const snaps = (body as { quotaSnapshots?: Record<string, QuotaSnapshot> } | null)?.quotaSnapshots;
  if (!snaps) return [];
  const out: RateLimitWindow[] = [];
  for (const [key, snap] of Object.entries(snaps)) {
    // An unlimited entitlement has no percentage to report. Showing 0% used against an
    // unlimited quota would be a number with no meaning behind it.
    if (!snap || snap.isUnlimitedEntitlement) continue;
    const entitlement = snap.entitlementRequests;
    const used = snap.usedRequests;
    if (typeof entitlement !== "number" || entitlement <= 0 || typeof used !== "number") continue;

    // Derived from the counts rather than trusting remainingPercentage, so the percentage and
    // the "54 of 200" it is shown beside can never disagree.
    const usedPercent = Math.min(100, Math.max(0, (used / entitlement) * 100));

    // resetDate has been observed coming back as roughly "now", which is the snapshot time
    // rather than a real monthly reset. A reset time that is not in the future is not a reset
    // time, so it is dropped instead of being rendered as "resets in 0 minutes".
    const resetMs = snap.resetDate ? Date.parse(snap.resetDate) : NaN;
    const resetsAt = Number.isFinite(resetMs) && resetMs > now + 60_000 ? Math.floor(resetMs / 1000) : undefined;

    out.push({
      key,
      label: key === "premium_interactions" ? `Premium requests (${used} of ${entitlement})` : key.replace(/_/g, " "),
      usedPercent: Math.round(usedPercent),
      resetsAt,
    });
  }
  return out;
}

/** Drives the bundled SDK directly, the same way modelCatalog.ts reads the model list, because
 * there is no CLI flag for this. No newline in the one-liner, and every interpolated path goes
 * through JSON.stringify, so an install path with a space or backslash cannot break out. */
function readQuota(timeoutMs = 25_000): Promise<unknown> {
  const platformDir = copilotPlatformDir();
  if (!platformDir) return Promise.reject(new Error("GitHub Copilot CLI is not installed"));
  const sdk = join(platformDir, "copilot-sdk", "index.js");
  const exe = join(platformDir, process.platform === "win32" ? "copilot.exe" : "copilot");
  if (!existsSync(sdk) || !existsSync(exe)) return Promise.reject(new Error("the installed Copilot package has no bundled SDK"));
  const sdkUrl = "file:///" + sdk.replace(/\\/g, "/");
  const script =
    `const s=await import(${JSON.stringify(sdkUrl)});` +
    `const c=new s.CopilotClient({connection:s.RuntimeConnection.forStdio({path:${JSON.stringify(exe)}})});` +
    `await c.start();const r=await c.connection.sendRequest("account.getQuota",{});` +
    `process.stdout.write(JSON.stringify(r));await c.stop();process.exit(0);`;
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Copilot did not answer account.getQuota within ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) resolve(JSON.parse(stdout));
      else reject(new Error((stderr || stdout).trim().slice(0, 300) || `exited ${code}`));
    });
  });
}

/** Spawning the Copilot runtime takes seconds, and a quota does not move between one page load
 * and the next. Memoised in memory only - never persisted, because a quota read off disk on a
 * later launch would be presented as current while being a stale snapshot. */
const TTL_MS = 2 * 60_000;
let cached: { at: number; value: ProviderRateLimit | undefined } | undefined;

export function clearCopilotQuotaCache(): void {
  cached = undefined;
}

export async function getCopilotQuota(): Promise<ProviderRateLimit | undefined> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  let value: ProviderRateLimit | undefined;
  try {
    const windows = parseCopilotQuota(await readQuota());
    // No windows means nothing metered that we can honestly report - not "0% used".
    value = windows.length > 0 ? { provider: "copilot-cli", windows, observedAt: new Date().toISOString() } : undefined;
  } catch {
    // Not signed in, not installed, offline: the meter shows nothing for Copilot, exactly as it
    // does for a provider that has not run a turn. Never a fabricated zero.
    value = undefined;
  }
  cached = { at: Date.now(), value };
  return value;
}

import type { ProviderId, ProviderRateLimit, RateLimitWindow } from "@solace/shared";

/**
 * Parsers for the rate-limit numbers the coding CLIs report about the user's own account.
 *
 * Both parsers are deliberately total-paranoid: neither event is part of a documented, stable
 * schema (Claude Code's rate_limit_event isn't in the headless docs at all, and Codex's
 * rate_limits block is a field on an event that exists for token counting), so every field is
 * treated as optional and anything that isn't a real number is dropped rather than defaulted.
 * A dropped field means the UI shows nothing for it - never a zero standing in for "unknown".
 *
 * Kept free of runtime imports so the unit tests can load it directly under `node --test`.
 */

/** Claude names its windows; these are the two observed in real streams. Unknown keys still
 * render, just with the provider's own key prettified rather than an invented description. */
const CLAUDE_WINDOW_LABELS: Record<string, string> = {
  five_hour: "5-hour limit",
  seven_day: "7-day limit",
};

function claudeWindowLabel(key: string): string {
  return CLAUDE_WINDOW_LABELS[key] ?? key.replace(/_/g, " ");
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Codex only tells us a window's length in minutes, so the label is derived from that number
 * and nothing else - 10080 minutes really is "7-day", it isn't a guess about the user's plan. */
export function labelForWindowMinutes(minutes: number | undefined, fallback: string): string {
  if (minutes === undefined || minutes <= 0) return fallback;
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return `${days}-day limit`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours}-hour limit`;
  }
  return `${minutes}-minute limit`;
}

/**
 * Claude Code `--output-format stream-json` line:
 *   {"type":"rate_limit_event","rate_limit_info":{"resetsAt":N,"rateLimitType":"five_hour",
 *    "unifiedWindows":{"five_hour":{"utilization":0.79,"resetsAt":N}, "seven_day":{...}}}}
 *
 * `utilization` is a 0..1 fraction (0.79 = 79% used), so it is multiplied by 100 here - the
 * single unit conversion in this file, and the only reason any arithmetic touches the number.
 * Returns null when the event carries no usable window, including when `unifiedWindows` is
 * missing entirely: rateLimitType/resetsAt alone say when a window resets but not how much of
 * it is used, and a reset time without a figure is not a usage figure.
 */
export function parseClaudeRateLimitEvent(event: unknown, observedAt: string): ProviderRateLimit | null {
  const raw = event as { type?: unknown; rate_limit_info?: { unifiedWindows?: unknown } } | null;
  if (!raw || raw.type !== "rate_limit_event") return null;

  const unified = raw.rate_limit_info?.unifiedWindows;
  if (!unified || typeof unified !== "object") return null;

  const windows: RateLimitWindow[] = [];
  for (const [key, value] of Object.entries(unified as Record<string, unknown>)) {
    const window = value as { utilization?: unknown; resetsAt?: unknown } | null;
    const utilization = finiteNumber(window?.utilization);
    if (utilization === undefined) continue;
    windows.push({
      key,
      label: claudeWindowLabel(key),
      usedPercent: utilization * 100,
      resetsAt: finiteNumber(window?.resetsAt),
    });
  }

  if (windows.length === 0) return null;
  return { provider: "claude-code", windows, observedAt };
}

/**
 * Codex CLI `exec --json` emits a `token_count` event carrying:
 *   "rate_limits":{"primary":{"used_percent":12.5,"window_minutes":10080,"resets_at":N},
 *                  "secondary":null,"plan_type":"plus"}
 *
 * `used_percent` is already 0..100 and is passed through untouched. `primary` is observed to be
 * null early in a turn (the first token_count of a turn often has no limits attached yet), and
 * `rate_limits` itself rides on different envelopes depending on how the event is wrapped, so
 * both are probed rather than assumed.
 */
export function parseCodexRateLimitEvent(event: unknown, observedAt: string): ProviderRateLimit | null {
  const raw = event as Record<string, any> | null;
  if (!raw) return null;
  const type = raw.type ?? raw.msg?.type;
  if (type !== "token_count") return null;

  const limits = raw.rate_limits ?? raw.msg?.rate_limits ?? raw.info?.rate_limits ?? raw.payload?.rate_limits;
  if (!limits || typeof limits !== "object") return null;

  const windows: RateLimitWindow[] = [];
  for (const slot of ["primary", "secondary"] as const) {
    const window = limits[slot];
    if (!window || typeof window !== "object") continue; // null primary is normal early in a turn
    const usedPercent = finiteNumber(window.used_percent);
    if (usedPercent === undefined) continue;
    windows.push({
      key: slot,
      label: labelForWindowMinutes(finiteNumber(window.window_minutes), `${slot} limit`),
      usedPercent,
      resetsAt: finiteNumber(window.resets_at),
    });
  }

  if (windows.length === 0) return null;
  const planType = typeof limits.plan_type === "string" ? limits.plan_type : undefined;
  return { provider: "codex-cli", windows, observedAt, planType };
}

/**
 * Last-known rate limit per provider, not per agent: several agents can be pointed at the same
 * CLI and therefore the same real account, in which case they all draw down one shared limit.
 * The newest observation for a provider wins regardless of which agent's turn produced it.
 */
export class RateLimitStore {
  private byProvider = new Map<ProviderId, ProviderRateLimit>();

  constructor(initial: ProviderRateLimit[] = []) {
    for (const entry of initial) this.record(entry);
  }

  /** Returns false when the incoming observation is older than the one already held, which can
   * happen because two agents on the same provider run turns concurrently. */
  record(entry: ProviderRateLimit): boolean {
    const existing = this.byProvider.get(entry.provider);
    if (existing && existing.observedAt > entry.observedAt) return false;
    this.byProvider.set(entry.provider, entry);
    return true;
  }

  get(provider: ProviderId): ProviderRateLimit | undefined {
    return this.byProvider.get(provider);
  }

  list(): ProviderRateLimit[] {
    return [...this.byProvider.values()];
  }
}

/** Drops anything that isn't a well-formed observation, so an older or hand-edited state file
 * can never inject a figure that no provider actually reported. */
export function sanitizePersistedRateLimits(value: unknown): ProviderRateLimit[] {
  if (!Array.isArray(value)) return [];
  const out: ProviderRateLimit[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { provider, windows, observedAt, planType } = entry as Record<string, unknown>;
    if (typeof provider !== "string" || typeof observedAt !== "string" || !Array.isArray(windows)) continue;
    const clean = windows
      .filter((w): w is RateLimitWindow => {
        const candidate = w as Record<string, unknown> | null;
        return (
          !!candidate &&
          typeof candidate.key === "string" &&
          typeof candidate.label === "string" &&
          finiteNumber(candidate.usedPercent) !== undefined
        );
      })
      .map((w) => ({ key: w.key, label: w.label, usedPercent: w.usedPercent, resetsAt: finiteNumber(w.resetsAt) }));
    if (clean.length === 0) continue;
    out.push({
      provider: provider as ProviderId,
      windows: clean,
      observedAt,
      planType: typeof planType === "string" ? planType : undefined,
    });
  }
  return out;
}

import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
      // Rounded to two decimals purely to kill the float artifact: 0.56 * 100 is
      // 56.00000000000001 in IEEE 754, and shipping that through the API made a real provider
      // figure look made up. This is display precision on the provider's own number, not a
      // adjustment to it - nothing is inferred, added or smoothed.
      usedPercent: Math.round(utilization * 100 * 100) / 100,
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
 * The key an observation is filed under: provider AND account.
 *
 * A pipe separator, because it cannot occur in a ProviderId (lowercase letters and hyphens) nor
 * in an account label (isValidAccountLabel restricts those to letters, numbers, space, - and _),
 * so no pair of distinct accounts can ever collide onto one key. Undefined - the CLI's own
 * default login - is its own key, distinct from every labelled account.
 *
 * Deliberately a printable character rather than the NUL this first used. NUL is the obvious
 * "cannot appear in real data" choice, but writing it means a raw control byte in a source file,
 * which this repo has been bitten by before: it survives compilation, so nothing fails, and then
 * turns up as a corrupt-looking diff. A separator that is impossible in the data AND readable in
 * the file is strictly better.
 */
export function rateLimitKey(provider: ProviderId, account: string | undefined): string {
  return `${provider}|${account ?? ""}`;
}

/**
 * Last-known rate limit per provider AND ACCOUNT, not per agent.
 *
 * Per-agent would be wrong in the other direction: several agents CAN be pointed at one CLI and
 * one login, and they really do draw down a single shared limit, so the newest observation for
 * one account correctly wins over an older one whichever agent's turn produced it.
 *
 * But an ACCOUNT is where a subscription's quota actually lives. This app runs two Claude
 * agents on two different Claude accounts (CLAUDE_CONFIG_DIR per account, core/providerAccounts
 * .ts), and while this store keyed on provider alone, the second account's turn overwrote the
 * first account's figure: the usage view showed one row for "Claude Code" carrying whichever
 * account had spoken most recently, and presented it as the quota of BOTH. A wrong number shown
 * confidently is worse than no number, so the key gained the account.
 */
export class RateLimitStore {
  private byAccount = new Map<string, ProviderRateLimit>();

  constructor(initial: ProviderRateLimit[] = []) {
    for (const entry of initial) this.record(entry);
  }

  /** Returns false when the incoming observation is older than the one already held FOR THAT
   * SAME ACCOUNT, which can happen because two agents on one account run turns concurrently.
   * An observation for a different account is never "older than" one for this account - they
   * describe different subscriptions - so it is always recorded. */
  record(entry: ProviderRateLimit): boolean {
    const key = rateLimitKey(entry.provider, entry.account);
    const existing = this.byAccount.get(key);
    if (existing && existing.observedAt > entry.observedAt) return false;
    this.byAccount.set(key, entry);
    return true;
  }

  /** The figure for one login. Undefined `account` means the CLI's own default login and does
   * NOT fall back to a labelled account's figure: those are different subscriptions, and
   * borrowing one's number for the other is the exact bug this keying exists to prevent. */
  get(provider: ProviderId, account?: string): ProviderRateLimit | undefined {
    return this.byAccount.get(rateLimitKey(provider, account));
  }

  list(): ProviderRateLimit[] {
    return [...this.byAccount.values()];
  }
}

/** Drops anything that isn't a well-formed observation, so an older or hand-edited state file
 * can never inject a figure that no provider actually reported. */
export function sanitizePersistedRateLimits(value: unknown): ProviderRateLimit[] {
  if (!Array.isArray(value)) return [];
  const out: ProviderRateLimit[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { provider, account, windows, observedAt, planType } = entry as Record<string, unknown>;
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
      // A state file written before usage was keyed by account has no `account` key at all, and
      // reads back as the default login - which is exactly what it was: every observation in
      // such a file predates the second account existing in the store's key.
      account: typeof account === "string" && account.length > 0 ? account : undefined,
      windows: clean,
      observedAt,
      planType: typeof planType === "string" ? planType : undefined,
    });
  }
  return out;
}

/**
 * Codex's rate limits, read from the CLI's own session rollout file.
 *
 * `codex exec --json` does not emit `token_count` at all on the installed build, so the
 * stream carries nothing to parse and the usage meter simply stayed empty for Codex while
 * working fine for Claude. But the CLI *writes* the same data to disk: every session has a
 * rollout JSONL under CODEX_HOME/sessions/YYYY/MM/DD/, named with the session id we already
 * capture for resume, and its `token_count` events carry a real `rate_limits` block.
 *
 * Reading it is the same "read real data off disk rather than guess" pattern this project
 * already uses for model defaults - it is the provider's own number, not an estimate.
 * Returns null for anything it cannot confidently read; the meter then shows nothing, which
 * is the honest outcome rather than a fabricated zero.
 */
export function readCodexRateLimitFromRollout(
  sessionId: string,
  now: string,
  /**
   * The CODEX_HOME this turn actually ran under. An agent on a named account runs with
   * CODEX_HOME pointed at that account's own directory, so its rollout - and therefore the only
   * rate_limits block that describes the subscription it just spent - is written there, not in
   * the server's own CODEX_HOME. Reading the wrong home showed the meter for a different
   * account's limits, which is worse than showing none. Undefined means the default login.
   */
  codexHome?: string,
): ProviderRateLimit | null {
  if (!sessionId) return null;
  const home = codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const file = findRolloutFile(join(home, "sessions"), sessionId);
  if (!file) return null;
  try {
    // Read the tail only. These grow to megabytes over a long session and the newest
    // rate_limits block is always at the end; parsing the whole file every turn would be
    // real work for no extra information.
    const size = statSync(file).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(size - start);
    try {
      readSync(fd, buf, 0, buf.length, start);
    } finally {
      closeSync(fd);
    }
    const lines = buf.toString("utf-8").split("\n");
    // Backwards: the last block written is the current one.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line || !line.includes("rate_limits")) continue;
      try {
        // A rollout line wraps the event: {timestamp, ordinal, type:"event_msg", payload:{...}}.
        // The stream parser expects the event itself, so unwrap before handing it over rather
        // than teaching the parser about a file format it never sees.
        const raw = JSON.parse(line) as { payload?: unknown };
        const parsed =
          parseCodexRateLimitEvent(raw, now) ?? (raw.payload ? parseCodexRateLimitEvent(raw.payload, now) : null);
        if (parsed) return parsed;
      } catch {
        // A truncated first line is expected when reading from an offset - skip it.
      }
    }
  } catch {
    return null;
  }
  return null;
}

const TAIL_BYTES = 256 * 1024;

/** The rollout file whose name ends with this session id. Codex files them by date, so this
 * walks the year/month/day tree rather than assuming today - a session started before
 * midnight is still the current one. */
function findRolloutFile(root: string, sessionId: string): string | undefined {
  if (!existsSync(root)) return undefined;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      if (entry.endsWith(".jsonl")) {
        if (entry.includes(sessionId)) return full;
        continue;
      }
      try {
        if (statSync(full).isDirectory()) stack.push(full);
      } catch {
        // Unreadable entry - skip rather than fail the whole lookup.
      }
    }
  }
  return undefined;
}

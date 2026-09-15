import type { ProviderId, TrustLevel, TurnUsage } from "@solace/shared";

export type AdapterEvent =
  | { type: "text"; text: string }
  | { type: "tool-use"; description: string }
  | { type: "usage"; usage: TurnUsage }
  | { type: "done" }
  | { type: "error"; message: string };

export interface RunTurnOptions {
  cwd: string;
  /** The prompt for this turn: the triggering chat message, plus any context the caller wants included. */
  prompt: string;
  trustLevel: TrustLevel;
  /** Which agent this turn belongs to - needed by claude-code.ts's "manual" mode to attribute
   * live approval requests to the right agent. */
  agentId: string;
  agentHandle: string;
  /** Model alias/id and reasoning effort to pass to the CLI's own flags - undefined means provider default. */
  model?: string;
  effort?: string;
  /** Only set for authMode "api-key" agents - the raw key, resolved server-side right before
   * the call (see core/credentials.ts). CLI adapters ignore this entirely. */
  apiKey?: string;
  onEvent: (event: AdapterEvent) => void;
  /** Aborting kills the underlying CLI process - used to enforce a max turn duration. */
  signal?: AbortSignal;
}

/**
 * One ProviderAdapter = one CLI coding agent (Claude Code, Codex CLI, Gemini CLI, ...).
 *
 * To add a new provider: implement runTurn() by spawning that CLI's non-interactive/headless
 * mode, translate its output into AdapterEvents, and register it in adapters/index.ts.
 * Auth is intentionally NOT handled here — every supported CLI already has its own
 * `<cli> login` / subscription sign-in flow; we just shell out to whatever is already
 * authenticated in the user's environment. That's what makes "sign in with your subscription,
 * not just an API key" work for free.
 */
export interface ProviderAdapter {
  id: ProviderId;
  runTurn(options: RunTurnOptions): Promise<void>;
}

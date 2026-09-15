import type { ProviderId, ProviderRateLimit, TrustLevel, TurnUsage } from "@solace/shared";

export type AdapterEvent =
  | { type: "text"; text: string }
  | { type: "tool-use"; description: string }
  | { type: "usage"; usage: TurnUsage }
  /** Account-level rate-limit numbers the CLI volunteered mid-turn. Only emitted when the
   * provider actually reported a usable figure - never synthesised at the start/end of a turn. */
  | { type: "rate-limit"; rateLimit: ProviderRateLimit }
  /** The provider's own id for this agent's ongoing conversation, so the next turn can resume
   * it instead of starting cold. Emitted as soon as it is known. */
  | { type: "session"; sessionId: string }
  /** The resolved model the provider actually used. Not always what was asked for: "sonnet" is
   * an alias that can point at more than one real model, and the honest thing to show is the id
   * the provider itself reported. */
  | { type: "model"; model: string }
  /** The abort signal fired and the child was killed. Deliberately distinct from "error": an
   * abort is something WE did and the caller knows why (timeout, Stop button, interrupt) - the
   * adapter doesn't. Reporting it as an error made the UI tell the user a turn they had
   * deliberately stopped "exceeded the maximum turn duration", and set the failure state that
   * lights up Retry and can schedule a rate-limit retry for a turn nobody wanted retried. */
  | { type: "cancelled" }
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
  /** Only set for provider "custom" - the OpenAI-compatible API root saved alongside the
   * credential (e.g. "https://api.deepseek.com/v1"). Resolved server-side from the credential,
   * not from the agent config, at the same point apiKey is. Every other adapter ignores it. */
  baseUrl?: string;
  /** Resume the agent's own prior CLI conversation instead of starting cold. Undefined means
   * this is a first turn. Without this every turn was a fresh stateless process, so an agent
   * genuinely could not remember work it had announced one message earlier. */
  sessionId?: string;
  /** A per-turn secret handed to any helper process this turn spawns (the approval bridge, the
   * solace bridge), so an internal route can tell a real in-flight turn from anything else that
   * can reach the port. */
  turnToken?: string;
  onEvent: (event: AdapterEvent) => void;
  /** Aborting kills the underlying CLI process - used for the max turn duration, the Stop
   * action, agent removal, and (see agentManager) interrupting one turn to answer another
   * agent's question. The reason lives on the caller, not here. */
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

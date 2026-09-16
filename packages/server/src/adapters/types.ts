import type { ProviderId, ProviderRateLimit, TrustLevel, TurnUsage } from "@solace/shared";

export type AdapterEvent =
  /**
   * The CLI produced SOMETHING - a line, a frame, a byte - that carries no reportable content.
   *
   * This exists purely as a liveness signal, and it is not cosmetic. The stuck-turn watchdog in
   * agentManager treats silence as the evidence a process has hung, and it only ever hears about
   * an adapter EVENT. So an adapter that reads a line and decides there is nothing worth
   * reporting was, without meaning to, telling the watchdog the process was dead.
   *
   * That really happened: OpenCode emits `step_start` and then waits on the model, sometimes for
   * minutes on a long resumed session. The adapter dropped `step_start` on the floor, so a
   * perfectly healthy turn was killed at the five-minute idle limit, restarted, and killed
   * again. Every adapter that discards a line MUST emit this instead of nothing.
   *
   * It carries no payload and must have no effect beyond resetting that timer - it is not shown,
   * not logged as progress, and must never be mistaken for the agent having said something.
   */
  | { type: "heartbeat" }
  | { type: "text"; text: string }
  /** The model's own thinking, where the provider emits it as a distinct item. Deliberately NOT
   * a "text" event: reasoning used to arrive as plain unmarked text, indistinguishable from an
   * answer, so the hub had no way to present it as anything other than another paragraph of the
   * agent talking. Nothing downstream may infer this from the shape of the words. */
  | { type: "reasoning"; text: string }
  /**
   * One tool/command invocation.
   *
   * `toolName` and `input` are the provider's OWN name and arguments, passed through unflattened
   * so core/toolLabel.ts can derive a human label from the actual argument values. `description`
   * remains the pre-flattened string for any path that just wants one - adapters that genuinely
   * have no structured input (a plain in-stream notice) send only that.
   */
  | { type: "tool-use"; description: string; toolName?: string; input?: unknown }
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
  /**
   * Who owns a path in this turn's chat, if not this agent. Only the endpoint adapters use it:
   * they run this app's own tool executor for every write, so a file claim is a real boundary
   * there. A CLI writes with its provider's own tools, which this app never sees, so nothing
   * can be enforced for those - see CoordinationBoard.conflictsFor.
   */
  ownerOfPath?: (path: string) => string | undefined;
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

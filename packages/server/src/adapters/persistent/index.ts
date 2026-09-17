import type { ProviderId } from "@solace/shared";
import type { ProviderAdapter } from "../types";
import { claudeCodeAdapter } from "../claude-code";
import { geminiCliAdapter } from "../gemini-cli";
import { qwenCodeAdapter } from "../qwen-code";
import { kimiAdapter } from "../kimi";
import { opencodeAdapter } from "../opencode";
import { createClaudeStreamJsonTransport } from "./claudeStreamJson";
import { ACP_PROVIDERS, createAcpTransport } from "./acpSession";
import { declaredTransportOf, type PersistentCapableAdapter, type PersistentTransport } from "./types";

/** The CLI adapters the ACP transports belong to, by the provider id in ACP_PROVIDERS. */
const acpAdapters: Record<string, ProviderAdapter> = {
  opencode: opencodeAdapter,
  kimi: kimiAdapter,
  "gemini-cli": geminiCliAdapter,
  "qwen-code": qwenCodeAdapter,
};
/**
 * Which providers have a persistent transport, and which of those are switched ON.
 *
 * This table is the single place the honest answer lives, and it is deliberately separate from
 * the adapters themselves: whether a transport has been driven against a real CLI is a fact
 * about this machine and this week, not a property of the code, and burying it inside an adapter
 * would make it something you discover by reading an implementation instead of something you can
 * look up.
 *
 * THE RULE FOR CHANGING A `false` TO A `true`: you drove it, against the real CLI, on an account
 * that works, and you watched a real answer come back on a second message pushed into a process
 * that was already running. Not "the code looks right", not "the flag exists in --help", and not
 * "the frames were exchanged" - Claude Code below is exactly that case and is still off. A
 * transport that is half-verified but claims to work costs the operator far more than one that
 * honestly says it is not enabled.
 */

/**
 * Claude Code's live transport: ON, and exactly what was watched before it was switched on.
 *
 * WHAT WAS OBSERVED on 2026-09-17, driving this repo's transport against the real `claude.exe`
 * on this machine, using a working account via CLAUDE_CONFIG_DIR (raw output in
 * PERSISTENT-SESSIONS.md):
 *   - ONE pid across FOUR messages and ONE session id throughout - message 2 was pushed into the
 *     process message 1 was still holding, and came back with real model text, not an auth error;
 *   - `{"type":"control_request","request":{"subtype":"interrupt"}}` answered with a real
 *     `control_response` mid-turn, after which the SAME process took message 4 and answered it;
 *   - the solace MCP bridge attached, with its tools passed through `--allowedTools`;
 *   - `--permission-mode` carrying the agent's trust level, built by `flagsForTrustLevel` - the
 *     same function the spawn-per-turn adapter uses, so a live turn and a spawned turn cannot
 *     disagree about what an agent is allowed to do.
 *
 * That last point is the whole difference between this and the ACP transports below. `opencode
 * acp`, asked to write a file, wrote it without ever requesting permission, so enabling it would
 * quietly promote `plan` and `manual` agents to unrestricted writes while the UI still showed
 * their chosen level. Claude Code's stream-json surface cannot do that: the flag that carries
 * trust is on the command line, exactly as it is for a spawned turn.
 *
 * WHAT THE EARLIER NOTE HERE GOT WRONG, since it is worth keeping: it said no model output had
 * ever come through a live session because the OAuth was expired. That was measured against the
 * DEFAULT login, which has no refresh token at all and so cannot heal itself. A second account
 * was signed in and saved days earlier and was working the whole time. "The account is broken"
 * and "this machine's default account is broken" are not the same claim, and only the second one
 * was ever true.
 */
export const CLAUDE_STREAM_JSON_ENABLED = true;

const claudeTransport = createClaudeStreamJsonTransport(CLAUDE_STREAM_JSON_ENABLED);

const transports = new Map<ProviderAdapter, PersistentTransport>([
  [claudeCodeAdapter, claudeTransport],
  // Every ACP provider, built from the same code, and every one of them OFF. OpenCode was driven
  // end to end and is off anyway, because it writes files without asking and so cannot carry an
  // agent's trust level; Kimi, Gemini and Qwen are off because nobody can sign in to them on this
  // machine, which is an account fact rather than a defect in the code above. Each carries its
  // own reason. See acpSession.ts for exactly what was and was not observed for each.
  ...ACP_PROVIDERS.map((spec) => [acpAdapters[spec.provider], createAcpTransport(spec)] as const),
]);

/**
 * Return the adapter with its persistent transport attached, if it has one.
 *
 * Attached here rather than declared on each adapter object so that adding a transport touches
 * ONE file and cannot change how an adapter's existing runTurn behaves. The eleven adapters that
 * have no transport come back exactly as they went in - same object, same identity - so nothing
 * downstream can tell this function ran.
 */
export function withPersistentTransport(adapter: ProviderAdapter): ProviderAdapter {
  const transport = transports.get(adapter);
  if (!transport) return adapter;
  const capable: PersistentCapableAdapter = Object.assign(Object.create(Object.getPrototypeOf(adapter)), adapter, {
    persistent: transport,
  });
  return capable;
}

/** Every declared transport and its state, for status reporting. Includes the disabled ones -
 * that is the point: "we have this and it is off, because X" is information, and an absence is
 * not. */
export function persistentTransportStatus(): {
  provider: ProviderId;
  enabled: boolean;
  disabledReason?: string;
}[] {
  return [...transports.entries()].map(([adapter, transport]) => ({
    provider: adapter.id,
    enabled: transport.enabled,
    disabledReason: transport.disabledReason,
  }));
}

export { declaredTransportOf };
export * from "./types";

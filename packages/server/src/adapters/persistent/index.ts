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
 * Claude Code's live transport: OFF, and exactly why.
 *
 * WHAT WAS OBSERVED on 2026-09-17, driving this repo's transport against the real `claude.exe`
 * 2.1.238 on this machine (raw output in PERSISTENT-SESSIONS.md):
 *   - `-p --input-format stream-json --output-format stream-json` was accepted and the process
 *     stayed up across FOUR messages: one pid (22892), one session id, four terminal `result`
 *     frames, and a graceful exit when stdin was closed;
 *   - `{"type":"control_request","request":{"subtype":"interrupt"}}` was answered with a real
 *     `control_response` of subtype "success" while a turn was in flight.
 *
 * WHAT WAS NOT OBSERVED, and why it is not: every one of those four turns came back
 * "Failed to authenticate: OAuth session expired and could not be refreshed". So no model output
 * has ever come through a live Claude session - no assistant text, no tool_use, no rate_limit
 * frame, no real usage. That is an account fact, not a defect: a plain `claude -p` on this
 * machine fails identically, and re-authenticating was out of scope.
 *
 * So the FRAMING is proven and the CONTENT is not, and the difference matters: the frames this
 * transport would meet on a working account (interleaved tool_use, partial messages, mid-turn
 * rate_limit_event) are precisely the ones an auth-failure turn never produces. Switching it on
 * would be claiming the half that was not seen. Flip this to true when someone has signed in and
 * watched a real answer arrive on a live session.
 */
export const CLAUDE_STREAM_JSON_ENABLED = false;

const claudeTransport = createClaudeStreamJsonTransport(
  CLAUDE_STREAM_JSON_ENABLED,
  "the stream-json transport was driven against the real claude binary and its framing works - " +
    "four messages on one process, and an acknowledged interrupt - but every turn failed with " +
    '"OAuth session expired and could not be refreshed", so no model output has ever come through ' +
    "a live Claude session. Sign in and watch one real answer arrive, then enable.",
);

/**
 * Keyed by the ADAPTER OBJECT, not by its provider id.
 *
 * A provider id is not unique: `claude-code` names both the CLI adapter and the direct-API one,
 * and `codex-cli` likewise. Keying on the id attached the CLI's `--input-format stream-json`
 * transport to the API-key adapter, which has no CLI process at all - a live transport wired to
 * something that could never run it. Caught by the seam test, which is what that test is for.
 */
const transports = new Map<ProviderAdapter, PersistentTransport>([
  [claudeCodeAdapter, claudeTransport],
  // Every ACP provider, built from the same code. OpenCode is ON because it was driven end to
  // end; Kimi, Gemini and Qwen are OFF because nobody can sign in to them on this machine, which
  // is an account fact rather than a defect in the code above. Each carries its own reason. See
  // acpSession.ts for exactly what was and was not observed for each.
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

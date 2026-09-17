import * as readline from "node:readline";
import type { ProviderId, TrustLevel, TurnUsage } from "@solace/shared";
import { accountEnv } from "../core/providerAccounts";
import { killCliTree, spawnCli } from "../core/spawnCli";
import { isEmptyUsage, num, put } from "../core/usage";
import type { ProviderAdapter, RunTurnOptions } from "./types";

/**
 * Factory's Droid CLI (`droid`, npm `droid`), headless surface `droid exec`.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT WAS AND WAS NOT VERIFIED AGAINST THE REAL BINARY (0.220.0, win32)
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * The machine this was written on has Droid INSTALLED BUT NOT LOGGED IN, and completing
 * Factory's device-auth flow was explicitly out of scope. So everything below splits into two
 * piles, and the split is stated honestly rather than blurred:
 *
 *   VERIFIED LIVE (the CLI really did this, unauthenticated):
 *     - the prompt is read from STDIN (see buildDroidArgs for why that is the whole ballgame)
 *     - the `-o json` envelope's exact field names, captured from a real run
 *     - `session_id` is present in that envelope and is a plain UUID
 *     - `-m`, `-r`, `--auto`, `--cwd`, `-s` are all parsed and validated BEFORE auth, so the
 *       accepted value sets below are the CLI's own, not the docs'
 *     - the unauthenticated failure envelope (see isNotSignedInError)
 *
 *   NOT VERIFIED - no authenticated turn was ever run:
 *     - a SUCCESSFUL turn of any kind
 *     - what the autonomy levels actually permit at call time (see droidAutonomyFlags - this
 *       is the important one, and it is why this adapter is conservative)
 *     - whether the `usage` block is populated on success the way it is on failure
 *
 * Nothing in this file invents a number or a field. Every key parsed below is one that appeared
 * in a real captured envelope; keys that only appear in Factory's prose docs are not parsed.
 */

/**
 * Droid's reasoning-effort vocabulary, taken from the CLI's own rejection message rather than
 * from the docs: `droid exec -r bogus` answers
 *   "Allowed values: none, dynamic, off, minimal, low, medium, high, xhigh, max".
 * Validation happens locally and before auth, so this list is authoritative on any machine.
 */
export const DROID_REASONING_EFFORTS = [
  "none",
  "dynamic",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/**
 * Trust level -> `droid exec` autonomy flags.
 *
 * Droid's autonomy model is NOT a per-tool allowlist. `droid exec --list-tools` reports
 * `Execute - status: allowed` at EVERY level including the read-only default, because the tool
 * is always present and the gating happens per COMMAND at call time, judged against the tier
 * descriptions in `droid exec --help` (read-only permits `cat`/`ls`/`git status`; `low` adds
 * file creation; `medium` adds installs and local git writes; `high` adds `git push` and
 * arbitrary code). That means --list-tools CANNOT be used to prove what a level really blocks,
 * and on this machine no authenticated turn could be run to prove it behaviourally.
 *
 * Everything below therefore follows Factory's own documented tier boundaries and deliberately
 * errs toward LESS authority than the docs allow:
 *
 *   plan              - no flag at all. Droid's default IS read-only; this is the one level
 *                       whose enforcement is structural rather than classifier-judged, since
 *                       ApplyPatch reports `status: blocked` here and only here (verified via
 *                       --list-tools across all five levels).
 *   acceptEdits       - `--auto low`. Factory's documented boundary for this tier is file
 *                       creation/modification while blocking system changes - which is exactly
 *                       what acceptEdits means here. NOT `medium`: medium adds package installs
 *                       and network fetches, which is more than "accept the edits".
 *   auto              - `--auto medium`. Recoverable development side effects.
 *   bypassPermissions - `--skip-permissions-unsafe`. Droid's own name for it says the rest.
 *
 * "manual" is NOT offered for this provider, and the reason is concrete rather than cautious:
 * `droid exec` has no path to a human at all. Droid's interactive/JSON-RPC surface does have
 * one (`droid.request_permission`, plus internal `waiting_for_tool_confirmation` and
 * `permission_resolved` notifications, all present in the shipped binary) - but that surface is
 * a bidirectional JSON-RPC protocol this adapter does not speak. Offering "manual" while
 * running `exec` would mean a mode this app describes as "stop and ask me" silently never
 * asking anybody. See DROID-REGISTRATION.md.
 *
 * `--auto high` is deliberately mapped to by NOTHING. It is the tier that permits `curl | bash`
 * and `git push --force`, and this app has no trust level whose description warrants it while
 * still being distinguishable from bypassPermissions.
 */
export function droidAutonomyFlags(trustLevel: TrustLevel): string[] {
  switch (trustLevel) {
    case "bypassPermissions":
      return ["--skip-permissions-unsafe"];
    case "auto":
      return ["--auto", "medium"];
    case "acceptEdits":
      return ["--auto", "low"];
    case "manual":
    case "plan":
    default:
      // Both "manual" and anything unrecognised collapse onto the READ-ONLY default rather than
      // a permissive one. "manual" is not offered by the catalog, but an agent saved before a
      // catalog change must still run - and if it does, it must run with the least authority,
      // not the most.
      return [];
  }
}

/**
 * Pure so it can be asserted on without spawning anything - see droidArgs.test.ts.
 *
 * THE PROMPT IS DELIBERATELY NOT A PARAMETER. `droid exec` accepts a prompt positionally, and
 * passing a large context block that way is exactly what produced a real `spawn ENAMETOOLONG`
 * outage for the two argv-based adapters in this repo (Windows caps a command line near 32KB).
 * Droid reads the prompt from STDIN instead, which was verified live two ways:
 *   - `droid exec -o json` with stdin closed exits 1 printing NOTHING - it never even reaches
 *     the auth check, i.e. it is waiting on a prompt it never got;
 *   - the same command with a 200,000-byte prompt on stdin runs normally through to the auth
 *     failure, with no length complaint of any kind.
 * Leaving the prompt out of this signature is what makes putting it in argv impossible to do
 * by accident.
 */
export function buildDroidArgs(opts: {
  cwd: string;
  trustLevel: TrustLevel;
  model?: string;
  effort?: string;
  /** The UUID to continue, or undefined on a first turn. */
  sessionId?: string;
}): string[] {
  return [
    "exec",
    // `-o json` and NOT `-o stream-json`. stream-json looks like the richer choice - it really
    // does emit NDJSON, and its `system/init` event carries session_id, model and
    // reasoning_effort - but Factory's own documentation marks stream-json DEPRECATED and
    // publishes no schema for it, and no authenticated turn could be run here to capture the
    // assistant/tool event shapes first-hand. Writing a stream parser against event shapes
    // nobody has ever observed is precisely the trap this repo has been burned by before, so
    // this adapter uses the one structured surface whose envelope was captured verbatim from a
    // real run and is documented by Factory as current. The cost is real and is stated plainly
    // in DROID-REGISTRATION.md: no incremental text and no tool-use events.
    "-o",
    "json",
    // Droid resolves its session/project scope from this rather than from the process cwd, so
    // it is passed explicitly even though the child is also spawned with cwd set.
    "--cwd",
    opts.cwd,
    // `-s` and never `--fork`: fork would mint a NEW session from the old one every turn, so an
    // agent would branch its own history instead of continuing it.
    ...(opts.sessionId ? ["-s", opts.sessionId] : []),
    ...(opts.model ? ["-m", opts.model] : []),
    ...(opts.effort ? ["-r", opts.effort] : []),
    ...droidAutonomyFlags(opts.trustLevel),
  ];
}

/**
 * Droid's unauthenticated failure, captured verbatim from the real binary:
 *
 *   {"type":"result","subtype":"failure","is_error":true,"duration_ms":45,"num_turns":0,
 *    "result":"Authentication failed. Please log in using /login or set a valid
 *              FACTORY_API_KEY environment variable.",
 *    "session_id":"...","usage":{...all zeros...}}
 *
 * Worth detecting specifically because it is the single most likely first-run failure and the
 * generic message ("the turn failed") would send a user hunting for a bug in their prompt
 * rather than signing in. Matched on the message text, not on exit code: the process exits 1
 * for every kind of failure.
 */
export function isNotSignedInError(message: string): boolean {
  return /authentication failed/i.test(message) || /FACTORY_API_KEY/.test(message);
}

/**
 * Maps Droid's `usage` block onto this app's TurnUsage.
 *
 * NOT LIVE-VERIFIED: `droid` on this machine is not signed in. The shape is read off the shipped
 * binary instead (@factory/cli-win32-x64 bin/droid.exe), where the block is built literally as
 *
 *   { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
 *     factory_credits: r.factoryCredits ?? 0,
 *     ...thinkingTokens ? { thinking_tokens } : {}, ...ttft !== undefined ? { ttft_ms } : {} }
 *
 * from `getInclusiveTokenUsage()`. Droid is an Anthropic-shaped reporter, so the cache buckets
 * are separate addends alongside input_tokens rather than inside it, and thinking_tokens is
 * part of the generated output.
 *
 * Two deliberate omissions. `factory_credits` is NOT mapped to totalCostUsd - a Factory credit
 * is not a dollar and inventing an exchange rate would put a fabricated price in front of the
 * user - but it IS reported in its own unit, since it is the only cost figure Droid gives. And
 * because the binary spells it `?? 0`, a credit figure of 0 is indistinguishable from "not
 * reported"; it is carried through as the 0 Droid printed rather than guessed at.
 */
export function droidUsage(raw: unknown): TurnUsage | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const u = raw as Record<string, unknown>;
  const usage: TurnUsage = {};
  put(usage, "inputTokens", num(u.input_tokens));
  put(usage, "outputTokens", num(u.output_tokens));
  put(usage, "cacheReadTokens", num(u.cache_read_input_tokens));
  put(usage, "cacheWriteTokens", num(u.cache_creation_input_tokens));
  put(usage, "reasoningTokens", num(u.thinking_tokens));
  if (usage.cacheReadTokens !== undefined || usage.cacheWriteTokens !== undefined) usage.cacheCountedInInput = false;
  if (usage.reasoningTokens !== undefined) usage.reasoningCountedInOutput = true;
  const credits = num(u.factory_credits);
  if (credits !== undefined) usage.otherCosts = [{ amount: credits, unit: "Factory credit" }];
  return isEmptyUsage(usage) ? undefined : usage;
}

export const droidAdapter: ProviderAdapter = {
  // The cast is load-bearing ONLY until packages/shared/src/index.ts gains "droid" in its
  // ProviderId union. That file is owned by the orchestrator (parallel agents are adding their
  // own providers to the same union), so the exact edit is specified in DROID-REGISTRATION.md
  // instead of being made here. Once it lands, this cast should be deleted.
  id: "droid",
  async runTurn({ cwd, prompt, trustLevel, model, effort, account, sessionId, onEvent, signal }: RunTurnOptions): Promise<void> {
    const args = buildDroidArgs({ cwd, trustLevel, model, effort, sessionId });

    await new Promise<void>((resolve) => {
      const child = spawnCli("droid", args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          // Empty unless this agent names an account, in which case it is FACTORY_HOME_OVERRIDE
          // pointing at that account's own directory - droid puts its .factory, and with it the
          // encrypted credential file it logs into, inside whatever that names. Spread LAST so an
          // account the user chose in the UI beats a FACTORY_HOME_OVERRIDE that happens to be in
          // the server's own environment, which would otherwise make the setting silently do
          // nothing on such a machine.
          //
          // One thing this canNOT beat: FACTORY_API_KEY. droid's own doctor says it "overrides
          // any stored login session", so a key in the server's environment puts every account on
          // that one subscription regardless of directory. listAccounts surfaces that case with
          // the CLI's own words instead of showing the accounts as separate.
          ...accountEnv("droid", account),
        },
      });

      // droid only starts the turn once stdin reaches EOF, so this must always end(). An EPIPE
      // here (child died before reading) is not worth crashing the server over - the close and
      // error handlers below already report the real failure.
      child.stdin!.on("error", () => {});
      child.stdin!.end(prompt);

      const rl = readline.createInterface({ input: child.stdout! });

      let aborted = false;
      const onAbort = () => {
        aborted = true;
        // Not child.kill(): on Windows that leaves the real CLI running against a turn we have
        // already given up on. See killCliTree.
        killCliTree(child);
      };
      signal?.addEventListener("abort", onAbort);

      let reportedSession: string | undefined = sessionId;
      let turnUsage: TurnUsage | undefined;
      let sawResult = false;
      let failureMessage: string | undefined;

      rl.on("line", (rawLine) => {
        const line = rawLine.replace(/^﻿/, "").trim();
        if (!line) return;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line);
        } catch {
          // `-o json` should emit nothing but JSON. Anything else is surfaced as text rather
          // than dropped silently, so an unexpected notice still reaches the user.
          onEvent({ type: "text", text: line });
          return;
        }

        const streamSession = event.session_id;
        if (typeof streamSession === "string" && streamSession && streamSession !== reportedSession) {
          // Droid mints its own UUID; there is no flag to propose one, so the id is learned
          // here and replayed via `-s` on the next turn. Emitted even on a failed turn, because
          // the session exists on Factory's side either way and continuing it is still valid.
          reportedSession = streamSession;
          onEvent({ type: "session", sessionId: streamSession });
        }

        if (event.type !== "result") return;
        sawResult = true;

        const usage = droidUsage(event.usage);
        if (usage) turnUsage = usage;

        const text = typeof event.result === "string" ? event.result : "";
        if (event.is_error === true || event.subtype === "failure") {
          failureMessage = text || "droid reported a failed turn with no message";
        } else if (text) {
          // The whole assistant answer arrives as one blob at the end - `-o json` has no
          // incremental surface. See buildDroidArgs for why that format was chosen anyway.
          onEvent({ type: "text", text });
        }
      });

      let stderrBuffer = "";
      child.stderr!.on("data", (chunk) => {
        stderrBuffer += chunk.toString();
      });

      child.on("close", (code) => {
        signal?.removeEventListener("abort", onAbort);
        if (turnUsage) onEvent({ type: "usage", usage: turnUsage });

        if (aborted) {
          // Why it was aborted is the caller's knowledge, not ours - see AdapterEvent.cancelled.
          onEvent({ type: "cancelled" });
          onEvent({ type: "done" });
          resolve();
          return;
        }

        const message = failureMessage ?? (code !== 0 ? stderrBuffer.trim() : "");
        if (message) {
          onEvent({
            type: "error",
            message: isNotSignedInError(message)
              ? `droid is not signed in. Run \`droid\` and complete its login, or set FACTORY_API_KEY. (${message})`
              : message,
          });
        } else if (code !== 0 && !sawResult) {
          // Exits 1 printing nothing at all when it got no prompt - worth naming rather than
          // reporting an empty error.
          onEvent({ type: "error", message: `droid exited with code ${code} without producing a result` });
        }
        onEvent({ type: "done" });
        resolve();
      });

      child.on("error", (err) => {
        signal?.removeEventListener("abort", onAbort);
        onEvent({ type: "error", message: `failed to start droid CLI: ${err.message}` });
        onEvent({ type: "done" });
        resolve();
      });
    });
  },
};

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as readline from "node:readline";
import { join } from "node:path";
import type { ProviderId, TrustLevel, TurnUsage } from "@solace/shared";
import { killCliTree, spawnCli } from "../core/spawnCli";
import { addStepFinishUsage } from "../core/usage";
import { mcpServersForAgent, type ResolvedMcpServer } from "../core/mcpServers";
import type { ProviderAdapter, RunTurnOptions } from "./types";

/** The group-chat MCP bridge, re-anchored to the *source* copy from the package root exactly as
 * claude-code.ts, gemini-cli.ts and opencode.ts do - it's plain JS with no compile step, so the
 * same path works under `tsx watch` and in `dist/`. */
const SOLACE_BRIDGE_SCRIPT = join(__dirname, "..", "..", "src", "mcp", "solaceBridge.mjs");

/**
 * Kilo (`kilo`, npm `@kilocode/cli`).
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * KILO IS AN OPENCODE FORK. THAT IS THE SINGLE MOST IMPORTANT FACT ABOUT THIS FILE.
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * Not an inference from family resemblance - established three ways:
 *   - `kilo --help` prints a log line that literally ends in `opencode`;
 *   - its config `$schema` is `https://app.kilo.ai/config.json`, the OpenCode config shape
 *     rebranded, and its session ids are OpenCode's own `ses_...` form (captured from a real
 *     event);
 *   - Kilo's own documentation states the CLI "is a fork of OpenCode and supports the same
 *     configuration options".
 *
 * So this adapter is deliberately opencode.ts's shape with the three things that actually
 * differ swapped out (binary name, `KILO_CONFIG`, and the extra `error` event). Where a claim
 * below was re-verified against the real `kilo` 7.7.2 binary it says so; where it is inherited
 * from opencode.ts's behavioural findings it says THAT, rather than passing one CLI's evidence
 * off as another's.
 *
 * WHAT COULD NOT BE VERIFIED: the machine this was written on has Kilo installed but with
 * **zero credentials** (`kilo auth list` -> "0 credentials"), and completing a sign-in flow was
 * out of scope. No authenticated turn was ever run. See KILO-REGISTRATION.md for the full
 * verified/unverified split and the smoke test required before shipping.
 */

/** Kilo's permission values. Verified as a real enforced enum against the 7.7.2 binary - see
 * kiloPermissions for why the enforcement detail matters more than the list. */
export type KiloPermission = "allow" | "ask" | "deny";

/** Every value Kilo's config validator actually accepts. Exported so a test can assert the
 * adapter never emits anything outside it. */
export const KILO_PERMISSION_VALUES: readonly KiloPermission[] = ["allow", "ask", "deny"];

/**
 * Trust level -> Kilo's `permission` config block.
 *
 * Like OpenCode, Kilo has no `--permission-mode` flag: permissions are config-driven and keyed
 * by TOOL CATEGORY ("edit", "bash", "webfetch") plus a "*" wildcard.
 *
 * VERIFIED AGAINST THE REAL KILO BINARY:
 *
 * 1. The config block really does govern the agent. `kilo debug agent code` resolves an agent's
 *    permissions into a flat rule array; with no config there is NO `edit` rule at all (edit
 *    falls under a `"*": allow` wildcard), and with `{"permission":{"edit":"deny","bash":"deny"}}`
 *    an `{permission:"edit", pattern:"*", action:"deny"}` rule and a matching `bash` one are
 *    injected. They are APPENDED LAST, after Kilo's own defaults (which include
 *    `bash "*" -> ask` plus an allowlist of ~78 read-only commands like `cat *` / `ls *`).
 *
 * 2. An INVALID value is SILENTLY DROPPED, not rejected. `{"permission":{"edit":"bogus"}}`
 *    makes the entire `permission` block vanish from the resolved config - no error, no
 *    warning, exit 0. That is a genuinely dangerous failure mode: one typo downgrades an agent
 *    to Kilo's permissive defaults while this app still believes it is restricted. It is why
 *    KILO_PERMISSION_VALUES exists and why kiloArgs.test.ts asserts every emitted value against
 *    it rather than trusting this function to be written correctly.
 *
 * INHERITED FROM opencode.ts, NOT RE-VERIFIED HERE (no authenticated turn was possible):
 *   - that "deny" REMOVES a tool from the model's tool list rather than rejecting the call at
 *     use time, which is what makes "plan" read-only by construction;
 *   - that "ask" is AUTO-REJECTED in headless `run` and never reaches a human;
 *   - that a "*" of "deny" would strip even the read-only tools, which is why "*" is only ever
 *     set to "allow" here.
 * Kilo is the same engine and its docs claim the same configuration options, so these are
 * likely to hold - but "likely" is why KILO-REGISTRATION.md marks them as the thing to confirm.
 *
 * Only three of this app's five trust levels are offered, matching OpenCode's catalog entry:
 *
 *   plan              - read-only. edit and bash denied; the agent can read, search and report.
 *   acceptEdits       - file edits go through unattended, shell access denied.
 *   bypassPermissions - everything allowed, including shell.
 *
 * "manual" and "auto" are absent on purpose - see KILO-REGISTRATION.md.
 */
export function kiloPermissions(trustLevel: TrustLevel): Record<string, KiloPermission> {
  switch (trustLevel) {
    case "bypassPermissions":
    case "auto":
      // "auto" is not offered for this provider, but an agent saved before a catalog change
      // must still run rather than crash. It lands where bypassPermissions does because Kilo
      // has no classifier-judged middle ground - which is precisely why the catalog refuses to
      // offer it as a separate, safer-sounding choice.
      return { "*": "allow", edit: "allow", bash: "allow", webfetch: "allow" };
    case "acceptEdits":
      return { edit: "allow", bash: "deny", webfetch: "allow" };
    case "manual":
    case "plan":
    default:
      // "manual" collapses onto the SAFE end rather than the permissive one: if it is ever
      // reached, the agent can look but not touch. The opposite default would mean a mode this
      // app describes as "stop and ask me" silently granting unattended write access.
      return { edit: "deny", bash: "deny", webfetch: "allow" };
  }
}

/**
 * The full per-turn config object, split out from the write so it can be asserted on without
 * touching the filesystem - see kiloArgs.test.ts.
 *
 * The MCP block shape was CONFIRMED against the real binary, not copied on faith: with exactly
 * this structure, `kilo mcp list` listed the `solace` server and actually tried to spawn it
 * (reporting "MCP error -32000: Connection closed" against a deliberately non-existent probe
 * script, which is the CLI having launched it). Keys are OpenCode's own: `type: "local"`,
 * `command` as a SINGLE ARRAY of argv (not a command string plus args), and `environment`
 * (not `env`).
 */
export function kiloConfig(opts: {
  trustLevel: TrustLevel;
  agentId: string;
  serverPort: number;
  turnToken?: string;
  userServers?: ResolvedMcpServer[];
}): { permission: Record<string, KiloPermission>; mcp: Record<string, unknown> } {
  const mcp: Record<string, unknown> = {
    solace: {
      type: "local",
      command: [process.execPath, SOLACE_BRIDGE_SCRIPT],
      enabled: true,
      environment: {
        SOLACE_AGENT_ID: opts.agentId,
        SOLACE_SERVER_PORT: String(opts.serverPort),
        ...(opts.turnToken ? { SOLACE_TURN_TOKEN: opts.turnToken } : {}),
      },
    },
  };
  // User servers are MERGED into the object rather than appended anywhere, and are written
  // AFTER the bridge so a name collision cannot displace it (validateMcpServer already rejects
  // the reserved name at the write boundary, which is where a human should be told about it).
  //
  // Note what is NOT done: no per-server trust/allow flag is set on a user server, so whatever
  // the trust level's permission block says still governs its tools. Pre-allowing them would
  // mean registering a server silently widened what an agent may do.
  for (const server of opts.userServers ?? []) {
    if (server.name === "solace") continue;
    mcp[server.name] = {
      type: "local",
      command: [server.command, ...server.args],
      enabled: true,
      environment: server.env,
    };
  }
  return { permission: kiloPermissions(opts.trustLevel), mcp };
}

/**
 * Writes the per-turn config to a FRESH temp directory.
 *
 * `KILO_CONFIG` was verified live to be honoured exactly as OpenCode's `OPENCODE_CONFIG` is: a
 * probe file containing `{"username":"PROBE_MARKER","permission":{...}}` came back through
 * `kilo debug config` with the marker in place and `permission_origins` attributing the values
 * to "local".
 *
 * A fresh per-turn file is not merely tidiness. OpenCode WRITES BACK to whatever file its
 * config env var points at (observed directly for that CLI - a probe config gained a `$schema`
 * key nobody wrote). Kilo is the same engine and its resolved config carries the same
 * `$schema` key, so pointing `KILO_CONFIG` at the user's own ~/.config/kilo/ would risk this
 * app mutating a config that governs every other kilo run on the machine. Per-turn and deleted
 * when the turn ends is the only safe shape.
 */
function writeTurnConfig(config: unknown): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "solace-kilo-"));
  const path = join(dir, "kilo.json");
  writeFileSync(path, JSON.stringify(config), "utf-8");
  return { dir, path };
}

/**
 * OpenCode binds an agent's TOOL SET to the session when the session is created rather than to
 * the turn, so a per-turn permission config does NOT apply to a resumed session. That was
 * verified directly for OpenCode. It could NOT be re-verified for Kilo here (no authenticated
 * turn), and the same-engine assumption is load-bearing in the DANGEROUS direction: if Kilo
 * behaves the same way, an agent created at "bypassPermissions" and then lowered to "plan"
 * would keep full write and shell access while the UI said it was read-only.
 *
 * Inheriting the precaution is therefore the only defensible default. The trust level a session
 * was minted under is recorded alongside the id, and a turn whose trust level no longer matches
 * starts a FRESH session instead of resuming. That costs the agent its conversation memory at
 * the moment the user changes its trust level - the honest trade against an agent running with
 * authority the user has revoked.
 *
 * If a signed-in test later shows Kilo re-evaluates permissions per turn, this can be relaxed
 * deliberately. It must not be relaxed on the assumption that it does.
 *
 * The pairing is carried inside the session string itself rather than in a new field on
 * AgentConfig, so it persists across restarts through the storage every provider already has.
 * "#" is safe as the separator because a Kilo session id is `ses_` followed by alphanumerics
 * only (verified: `ses_f54e81818ffeG52RGsQtmif4uj` from a real event).
 */
export function encodeSessionToken(sessionId: string, trustLevel: TrustLevel): string {
  return `${sessionId}#${trustLevel}`;
}

/**
 * Returns the id to actually resume, or undefined to start fresh. Undefined is returned both
 * when the trust level has changed and when the stored token predates this pairing (no "#"),
 * because in that case what the session was minted under is genuinely unknown - and an unknown
 * authority must not be assumed to be the current one.
 */
export function resumableSessionId(token: string | undefined, trustLevel: TrustLevel): string | undefined {
  if (!token) return undefined;
  const at = token.lastIndexOf("#");
  if (at === -1) return undefined;
  const id = token.slice(0, at);
  const mintedUnder = token.slice(at + 1);
  if (!id || mintedUnder !== trustLevel) return undefined;
  return id;
}

/**
 * Kilo's unauthenticated failure, captured verbatim from the real binary. The turn reaches the
 * model call and comes back as an `error` event whose payload is an APIError:
 *
 *   {"type":"error","sessionID":"ses_...","error":{"name":"APIError",
 *    "data":{"message":"You need to sign in to use this model.","statusCode":401,...}}}
 *
 * stderr carries the same sentence on its own. Worth detecting specifically because it is the
 * most likely first-run failure and the raw event is enormous - the captured `data` block
 * included the full HTTP response headers, Content-Security-Policy and all, which is not
 * something to put in a chat bubble.
 */
export function isNotSignedInError(message: string): boolean {
  return /need to sign in/i.test(message) || /\bsign in to use this model\b/i.test(message);
}

/**
 * Pure so it can be asserted on without spawning anything - see kiloArgs.test.ts.
 *
 * THE PROMPT IS DELIBERATELY NOT A PARAMETER. `kilo run` takes `[message..]` positionally, but
 * it also reads the message from STDIN, and stdin is the only form with no length limit. A
 * large context block passed as argv is what produced a real `spawn ENAMETOOLONG` outage for
 * the two argv-based adapters in this repo, so leaving the prompt out of this signature is what
 * makes putting it in argv impossible to do by accident.
 *
 * Verified live: `echo "..." | kilo run --format json` read the piped prompt, minted a session
 * and got all the way to the model call (failing only on auth), with no prompt in argv at all.
 */
export function buildKiloArgs(opts: {
  cwd: string;
  model?: string;
  effort?: string;
  /** The `ses_...` id to continue, or undefined on a first turn. */
  sessionId?: string;
}): string[] {
  return [
    "run",
    "--format",
    "json",
    // Kilo resolves its project/session scope from this rather than from the process cwd, so it
    // is passed explicitly even though the child is also spawned with cwd set.
    "--dir",
    opts.cwd,
    // Deliberately -s <id> and never -c/--continue: --continue means "the last session" for the
    // directory, so two kilo agents sharing a workspace would resume each other's conversation.
    // Also never --fork, which would branch a new session off the old one every turn.
    ...(opts.sessionId ? ["-s", opts.sessionId] : []),
    ...(opts.model ? ["-m", opts.model] : []),
    // --variant is Kilo's own name for reasoning effort ("model variant (provider-specific
    // reasoning effort, e.g., high, max, minimal)" per `kilo run --help`). There is no separate
    // --effort flag.
    ...(opts.effort ? ["--variant", opts.effort] : []),
  ];
}

/** Pulls the human-readable sentence out of Kilo's `error` event without dragging along the
 * HTTP response headers its `data` block carries. Exported for the test. */
export function kiloErrorMessage(error: unknown): string {
  const e = (error ?? {}) as { name?: unknown; data?: { message?: unknown } };
  const message = e.data?.message;
  if (typeof message === "string" && message) return message;
  if (typeof e.name === "string" && e.name) return e.name;
  return "kilo reported an error with no message";
}

export const kiloAdapter: ProviderAdapter = {
  // The cast is load-bearing ONLY until packages/shared/src/index.ts gains "kilo" in its
  // ProviderId union. That file is owned by the orchestrator (parallel agents are adding their
  // own providers to the same union), so the exact edit is specified in KILO-REGISTRATION.md
  // instead of being made here. Once it lands, this cast should be deleted.
  id: "kilo",
  async runTurn({ cwd, prompt, trustLevel, model, effort, agentId, turnToken, sessionId, onEvent, signal }: RunTurnOptions): Promise<void> {
    const serverPort = Number(process.env.PORT ?? 4310);
    // Not `sessionId` directly: a session minted under a different trust level must not be
    // resumed, or the agent keeps authority the user has since changed. See resumableSessionId.
    const resumeId = resumableSessionId(sessionId, trustLevel);
    const args = buildKiloArgs({ cwd, model, effort, sessionId: resumeId });
    const turnConfig = writeTurnConfig(
      kiloConfig({ trustLevel, agentId, serverPort, turnToken, userServers: mcpServersForAgent(agentId) }),
    );

    await new Promise<void>((resolve) => {
      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        try {
          rmSync(turnConfig.dir, { recursive: true, force: true });
        } catch {
          // A leftover file in the OS temp dir is not worth failing a completed turn over.
        }
      };

      const child = spawnCli("kilo", args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          // Points at OUR per-turn file, never the user's own ~/.config/kilo. See writeTurnConfig.
          KILO_CONFIG: turnConfig.path,
          SOLACE_AGENT_ID: agentId,
          SOLACE_SERVER_PORT: String(serverPort),
          ...(turnToken ? { SOLACE_TURN_TOKEN: turnToken } : {}),
        },
      });

      // kilo reads the message from stdin and only starts the turn once it reaches EOF, so this
      // must always end(). An EPIPE here (child died before reading) is not worth crashing the
      // server over - the close/error handlers below already report the real failure.
      child.stdin!.on("error", () => {});
      child.stdin!.end(prompt);
      const rl = readline.createInterface({ input: child.stdout! });

      let aborted = false;
      const onAbort = () => {
        aborted = true;
        // Not child.kill(): on Windows that leaves the real CLI (and the per-turn MCP bridge it
        // spawned) running against a turn we already gave up on. See killCliTree.
        killCliTree(child);
      };
      signal?.addEventListener("abort", onAbort);

      let reportedSession: string | undefined = resumeId;
      let turnUsage: TurnUsage | undefined;
      let streamError: string | undefined;

      rl.on("line", (rawLine) => {
        // The first stdout line can carry a UTF-8 BOM; JSON.parse rejects it.
        const line = rawLine.replace(/^﻿/, "").trim();
        if (!line) return;
        try {
          const event = JSON.parse(line);
          // Kilo's newline-delimited event schema is OpenCode's: every event carries a
          // top-level sessionID and the payload lives under `part`. The sessionID field and its
          // `ses_...` form were confirmed on a real Kilo event; the `part` payload shapes are
          // inherited from opencode.ts's verified stream, since no authenticated Kilo turn
          // could be run here.
          const streamSession = event?.sessionID;
          if (typeof streamSession === "string" && streamSession && streamSession !== reportedSession) {
            // The stream is the only source of the session id for this provider - there is no
            // flag to propose one - so this is how continuity is established at all. Stored
            // paired with the trust level it was minted under; see encodeSessionToken.
            reportedSession = streamSession;
            onEvent({ type: "session", sessionId: encodeSessionToken(streamSession, trustLevel) });
          }
          const part = event?.part ?? {};
          switch (event?.type) {
            case "text": {
              if (typeof part.text === "string" && part.text) onEvent({ type: "text", text: part.text });
              break;
            }
            case "tool_use": {
              const input = part?.state?.input;
              onEvent({
                type: "tool-use",
                description: `${part.tool ?? "tool"}(${JSON.stringify(input ?? {})})`,
                toolName: typeof part.tool === "string" ? part.tool : undefined,
                input: input ?? {},
              });
              break;
            }
            case "step_finish": {
              // Accumulated rather than emitted per step: agentManager treats each "usage"
              // event as THE usage for the turn, so emitting per step would make a six-step
              // turn report only its last step's tokens. Every number here is one the CLI
              // itself printed; nothing is derived.
              turnUsage = addStepFinishUsage(turnUsage, part.tokens, part.cost);
              break;
            }
            case "error": {
              // Kilo emits a structured `error` event that OpenCode's stream does not surface
              // the same way - captured live from the real binary. Held rather than emitted
              // immediately so the close handler reports exactly one failure, and unwrapped so
              // the chat gets the sentence rather than the full HTTP response headers its
              // `data` block carries.
              streamError = kiloErrorMessage(event.error);
              break;
            }
            default:
              // step_start and anything else Kilo adds later: nothing to report. No "model"
              // event is emitted because no event in the stream was observed carrying a
              // resolved model id, and inventing one from the --model argument would just echo
              // our own request back as if the provider had confirmed it.
              break;
          }
        } catch {
          // Non-JSON line (shouldn't normally happen with --format json) - surface it as plain
          // text rather than dropping it silently.
          onEvent({ type: "text", text: line });
        }
      });

      // kilo writes informational notices and a banner to stderr even on success, so stderr
      // output is never itself treated as failure; it is only reported if the process also
      // exits non-zero AND the stream carried no structured error.
      let stderrBuffer = "";
      child.stderr!.on("data", (chunk) => {
        stderrBuffer += chunk.toString();
      });

      child.on("close", (code) => {
        signal?.removeEventListener("abort", onAbort);
        cleanup();
        if (turnUsage) onEvent({ type: "usage", usage: turnUsage });

        if (aborted) {
          // Why it was aborted is the caller's knowledge, not ours - see AdapterEvent.cancelled.
          onEvent({ type: "cancelled" });
          onEvent({ type: "done" });
          resolve();
          return;
        }

        const message = streamError ?? (code !== 0 ? stderrBuffer.trim() : "");
        if (message) {
          onEvent({
            type: "error",
            message: isNotSignedInError(message)
              ? `kilo is not signed in. Run \`kilo auth login\` and pick a provider. (${message})`
              : message,
          });
        }
        onEvent({ type: "done" });
        resolve();
      });

      child.on("error", (err) => {
        signal?.removeEventListener("abort", onAbort);
        cleanup();
        onEvent({ type: "error", message: `failed to start kilo CLI: ${err.message}` });
        onEvent({ type: "done" });
        resolve();
      });
    });
  },
};

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as readline from "node:readline";
import { join } from "node:path";
import type { TrustLevel, TurnUsage } from "@solace/shared";
import { killCliTree, spawnCli } from "../core/spawnCli";
import { SERVER_PORT } from "../core/serverPort";
import { addStepFinishUsage } from "../core/usage";
import { mcpServersForAgent, type ResolvedMcpServer } from "../core/mcpServers";
import { accountEnv } from "../core/providerAccounts";
import type { ProviderAdapter, RunTurnOptions } from "./types";

/** The group-chat MCP bridge, re-anchored to the *source* copy from the package root exactly as
 * claude-code.ts and gemini-cli.ts do - it's plain JS with no compile step, so the same path
 * works under `tsx watch` and in `dist/`. */
const SOLACE_BRIDGE_SCRIPT = join(__dirname, "..", "..", "src", "mcp", "solaceBridge.mjs");

/**
 * OpenCode's permission values, as its own config schema defines them.
 * Verified against the installed 1.18.31 binary rather than taken from the docs alone.
 */
export type OpencodePermission = "allow" | "ask" | "deny";

/**
 * Trust level -> OpenCode's `permission` config block.
 *
 * OpenCode has no --permission-mode flag at all: permissions are config-driven
 * (https://opencode.ai/docs/permissions/), keyed by TOOL CATEGORY ("edit", "bash", "webfetch")
 * rather than by individual tool name, plus a "*" wildcard. Three findings from the real
 * binary shape everything below, and each one was established by a real headless turn:
 *
 * 1. "deny" REMOVES the tool from the model's tool list entirely - it is not an auto-rejection
 *    at call time. With {edit:"deny", bash:"deny"} the CLI itself reported: "Model tried to
 *    call unavailable tool 'write'. Available tools: glob, grep, invalid, read, skill, task,
 *    todowrite, webfetch, websearch." That makes "deny" a genuine capability removal rather
 *    than a prompt the model can retry its way past, which is what lets "plan" below be an
 *    honest read-only mode.
 *
 * 2. "ask" is AUTO-REJECTED in headless `run` - it is never queued for a human. The run
 *    printed `permission requested: edit (...); auto-rejecting` to stderr and the tool call
 *    came back as "The user rejected permission to use this specific tool call.". There is no
 *    hang, but there is also no path from "ask" to a human being. This is why "manual" is NOT
 *    offered for this provider - see permissionCatalog.ts.
 *
 * 3. The "*" wildcard covers the READ-ONLY tools too. A turn run with {"*":"deny"} had no
 *    tools at all and could not even read a file. So "*" is only ever set here to "allow"
 *    (for bypassPermissions); the restrictive levels name the categories they restrict and
 *    deliberately leave everything else at OpenCode's own default, which keeps read/glob/grep
 *    and the solace MCP bridge reachable.
 *
 * Only three of this app's five trust levels are expressible, and permissionCatalog.ts offers
 * exactly those three:
 *
 *   plan              - read-only. edit and bash are removed outright; the agent can read,
 *                       search and report, and has no tool that writes to the machine.
 *   acceptEdits       - file edits go through unattended, shell access is removed. A real
 *                       middle ground, not a renamed bypassPermissions.
 *   bypassPermissions - everything allowed, including shell.
 *
 * "manual" and "auto" are absent on purpose; see permissionCatalog.ts for both reasons.
 *
 * webfetch is "allow" at every offered level: fetching a URL reads the network, it does not
 * write to the user's machine, and the alternative ("ask") would silently auto-reject it.
 */
export function opencodePermissions(trustLevel: TrustLevel): Record<string, OpencodePermission> {
  switch (trustLevel) {
    case "bypassPermissions":
    case "auto":
      // "auto" is not offered for this provider (permissionCatalog.ts), but an agent saved
      // before a catalog change must still run rather than crash. It lands on the same place
      // bypassPermissions does because OpenCode has no classifier-judged middle ground - which
      // is precisely why the catalog refuses to offer it as a separate, safer-sounding choice.
      return { "*": "allow", edit: "allow", bash: "allow", webfetch: "allow" };
    case "acceptEdits":
      return { edit: "allow", bash: "deny", webfetch: "allow" };
    case "manual":
    case "plan":
    default:
      // "manual" is not offered either, and it deliberately collapses onto the SAFE end rather
      // than the permissive one: if it is ever reached, the agent can look but not touch. The
      // opposite default would mean a mode this app describes as "stop and ask me" silently
      // granting unattended write access.
      return { edit: "deny", bash: "deny", webfetch: "allow" };
  }
}

/**
 * The full per-turn config object, split out from the write so it can be asserted on without
 * touching the filesystem - see opencodeConfig.test.ts.
 *
 * OpenCode's MCP block shape was confirmed against the real binary, not guessed: with this
 * exact structure `opencode mcp list` listed the `solace` server and actually tried to spawn
 * the command (it reported "MCP error -32000: Connection closed" against a deliberately
 * non-existent probe script, which is the CLI having launched it). Keys are OpenCode's own:
 * `type: "local"`, `command` as a SINGLE ARRAY of argv (not a command string plus args), and
 * `environment` (not `env`).
 */
export function opencodeConfig(opts: {
  trustLevel: TrustLevel;
  agentId: string;
  serverPort: number;
  turnToken?: string;
  userServers?: ResolvedMcpServer[];
}): { permission: Record<string, OpencodePermission>; mcp: Record<string, unknown> } {
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
  // The user's own servers are MERGED into the object we build rather than appended anywhere,
  // and are written AFTER the bridge so a name collision cannot displace it (validateMcpServer
  // already rejects the reserved name at the write boundary, which is where a human should be
  // told about it).
  //
  // Note what is NOT done here: no per-server trust/allow flag is set on a user server, so
  // whatever the trust level's permission block says still governs its tools. Pre-allowing
  // them would mean registering a server silently widened what an agent may do.
  for (const server of opts.userServers ?? []) {
    if (server.name === "solace") continue;
    mcp[server.name] = {
      type: "local",
      command: [server.command, ...server.args],
      enabled: true,
      environment: server.env,
    };
  }
  return { permission: opencodePermissions(opts.trustLevel), mcp };
}

/**
 * Writes the per-turn config to a FRESH temp directory.
 *
 * This is not merely tidiness. OpenCode WRITES BACK to whatever file OPENCODE_CONFIG points
 * at - observed directly: after one `opencode debug config` and again after a real `run`, the
 * probe config on disk had gained a `"$schema": "https://opencode.ai/config.json"` key that
 * this app never wrote. Pointing that env var at the user's own ~/.config/opencode/opencode.json
 * would therefore mean this app mutating a config file that governs every other opencode run
 * on the machine. A fresh per-turn file, deleted when the turn ends, is the only safe shape.
 */
function writeTurnConfig(config: unknown): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "solace-opencode-"));
  const path = join(dir, "opencode.json");
  writeFileSync(path, JSON.stringify(config), "utf-8");
  return { dir, path };
}

/**
 * OpenCode binds an agent's TOOL SET to the session when the session is created, not to the
 * turn - so the per-turn permission config does NOT apply to a resumed session. Verified
 * directly: a session first created under "plan" was resumed with an {edit:"allow"} config and
 * still reported `write` unavailable, while the identical config on a FRESH session wrote the
 * file happily.
 *
 * That is a real mismatch with this app, where trust level is a per-turn property the user can
 * change between messages, and it fails dangerously in one direction: an agent created at
 * "bypassPermissions" and then lowered to "plan" would keep full write and shell access for
 * the rest of the session while the UI said it was read-only. Resuming regardless was
 * therefore not an option.
 *
 * So the trust level the session was minted under is recorded alongside the id, and a turn
 * whose trust level no longer matches starts a FRESH session instead of resuming. That costs
 * the agent its conversation memory at the moment the user changes its trust level, which is
 * the honest trade: the alternative is an agent running with authority the user has revoked.
 *
 * The pairing is carried inside the session string itself rather than in a new field on
 * AgentConfig, so it persists across restarts through the storage every provider already has,
 * and no other provider's shape has to change for one CLI's quirk. "#" is safe as the
 * separator because an OpenCode session id is `ses_` followed by alphanumerics only.
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
 * Pure so it can be asserted on without spawning anything - see opencodeConfig.test.ts. The
 * prompt is deliberately NOT a parameter: `opencode run` takes `[message..]` positionally, but
 * it also reads the message from STDIN, and stdin is the only form with no length limit. A
 * large context block passed as argv is what produced a real `spawn ENAMETOOLONG` outage for
 * the two adapters here that do use argv, so leaving the prompt out of this signature is what
 * makes putting it in argv impossible to do by accident.
 */
export function buildOpencodeArgs(opts: {
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
    // OpenCode resolves its project/session scope from this rather than from the process cwd,
    // so it is passed explicitly even though the child is also spawned with cwd set.
    "--dir",
    opts.cwd,
    // Unlike claude-code and gemini-cli there is no --session-id: OpenCode mints its own
    // `ses_...` id and there is no flag to propose one. So a first turn simply has no session
    // argument and the id is learned from the stream (every event carries sessionID), then
    // replayed here on the next turn. Deliberately -s <id> and never -c/--continue: --continue
    // means "the last session" for the directory, so two opencode agents sharing a workspace
    // would resume each other's conversation.
    ...(opts.sessionId ? ["-s", opts.sessionId] : []),
    ...(opts.model ? ["-m", opts.model] : []),
    // --variant is OpenCode's own name for reasoning effort ("provider-specific reasoning
    // effort, e.g., high, max, minimal" per `opencode run --help`). There is no separate
    // --effort flag.
    ...(opts.effort ? ["--variant", opts.effort] : []),
  ];
}

export const opencodeAdapter: ProviderAdapter = {
  id: "opencode",
  async runTurn({ cwd, prompt, trustLevel, model, effort, agentId, account, turnToken, sessionId, onEvent, signal }: RunTurnOptions): Promise<void> {
    const serverPort = SERVER_PORT;
    // Not `sessionId` directly: a session minted under a different trust level must not be
    // resumed, or the agent keeps authority the user has since changed. See resumableSessionId.
    const resumeId = resumableSessionId(sessionId, trustLevel);
    const args = buildOpencodeArgs({ cwd, model, effort, sessionId: resumeId });
    const turnConfig = writeTurnConfig(
      opencodeConfig({ trustLevel, agentId, serverPort, turnToken, userServers: mcpServersForAgent(agentId) }),
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

      const child = spawnCli("opencode", args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          // Points at OUR per-turn file, never the user's own config. See writeTurnConfig.
          OPENCODE_CONFIG: turnConfig.path,
          SOLACE_AGENT_ID: agentId,
          SOLACE_SERVER_PORT: String(serverPort),
          ...(turnToken ? { SOLACE_TURN_TOKEN: turnToken } : {}),
          // Empty unless this agent names an account, in which case it is XDG_DATA_HOME
          // pointing at that account's own data directory - which is where OpenCode keeps
          // auth.json (see core/providerAccounts.ts; OPENCODE_CONFIG above moves the SETTINGS
          // and verifiably does NOT move the credentials, so the two do different jobs and
          // both are needed). Spread LAST so an account the user chose in the UI beats an
          // XDG_DATA_HOME that happens to be in the server's own environment - otherwise the
          // setting would silently do nothing on such a machine.
          ...accountEnv("opencode", account),
        },
      });
      // opencode reads the message from stdin and only starts the turn once it reaches EOF, so
      // this must always end(). An EPIPE here (child died before reading) is not worth crashing
      // the server over - the close/error handlers below already report the real failure.
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
      rl.on("line", (rawLine) => {
        // OpenCode's first stdout line can carry a UTF-8 BOM; JSON.parse rejects it.
        const line = rawLine.replace(/^﻿/, "").trim();
        if (!line) return;
        try {
          const event = JSON.parse(line);
          // OpenCode's newline-delimited event schema, read off the real 1.18.31 stream rather
          // than guessed. Every event carries a top-level sessionID, and the payload lives
          // under `part`:
          //   {"type":"step_start","sessionID":...,"part":{"type":"step-start",...}}
          //   {"type":"text","part":{"type":"text","text":...}}
          //   {"type":"tool_use","part":{"tool":...,"state":{"status":...,"input":...}}}
          //   {"type":"step_finish","part":{"tokens":{total,input,output,reasoning,cache},"cost":N}}
          const streamSession = event?.sessionID;
          if (typeof streamSession === "string" && streamSession && streamSession !== reportedSession) {
            // The stream is the only source of the session id for this provider - there is no
            // flag to propose one - so this is how continuity is established at all. It is
            // stored paired with the trust level it was minted under; see encodeSessionToken.
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
              // Accumulated rather than emitted per step: OpenCode reports one of these per
              // step of a multi-step turn, and agentManager treats each "usage" event as THE
              // usage for the turn (runtime.lastUsage = event.usage). Emitting per step would
              // make a six-step turn report only its last step's tokens. Every number here is
              // one the CLI itself printed; nothing is derived.
              turnUsage = addStepFinishUsage(turnUsage, part.tokens, part.cost);
              break;
            }
            case "error": {
              // The provider's OWN refusal, reported as the provider worded it.
              //
              // This fell through to `default` and was emitted as a heartbeat, so a turn that the
              // provider had flatly refused looked identical to a turn quietly working: no error
              // in the chat, nothing on the agent, nothing in the log. It cost real time to find,
              // because every layer above was behaving correctly on the information it had.
              //
              // What surfaced it: OpenCode began refusing its free tier whenever an MCP server is
              // attached - `{"type":"error","error":{"data":{"message":"Error from provider
              // (Console): OpenCode's free tier can only be used from within OpenCode",
              // "statusCode":403}}}` - and four agents produced a completely silent room.
              const err = (event as { error?: { name?: string; data?: { message?: string; statusCode?: number } } })?.error;
              const stated = err?.data?.message ?? err?.name ?? "the provider reported an error with no message";
              const status = typeof err?.data?.statusCode === "number" ? ` (HTTP ${err.data.statusCode})` : "";
              onEvent({ type: "error", message: `${stated}${status}` });
              break;
            }
            default:
              // step_start and anything else OpenCode adds later carry nothing to SHOW - but they
              // are proof the CLI is alive, and that has to be said out loud. OpenCode emits
              // step_start and then waits on the model, which on a long resumed session can be
              // minutes; dropping the line silently let the idle watchdog conclude the process
              // had hung and kill a turn that was working. No "model" event is emitted for this
              // provider because no event in the stream carries the resolved model id - checked
              // across real turns - and inventing one from the --model argument would just be
              // echoing our own request back as if the provider had confirmed it.
              onEvent({ type: "heartbeat" });
              break;
          }
        } catch {
          // Non-JSON line (shouldn't normally happen with --format json) - surface it as plain
          // text rather than dropping it silently.
          onEvent({ type: "text", text: line });
        }
      });

      // opencode writes informational notices to stderr even on success - the auto-rejection
      // notice for an "ask" permission is one - so stderr output is never itself treated as
      // failure; it is only reported if the process also exits non-zero.
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
        } else if (code !== 0 && stderrBuffer.trim()) {
          onEvent({ type: "error", message: stderrBuffer.trim() });
        }
        onEvent({ type: "done" });
        resolve();
      });

      child.on("error", (err) => {
        signal?.removeEventListener("abort", onAbort);
        cleanup();
        onEvent({ type: "error", message: `failed to start opencode CLI: ${err.message}` });
        onEvent({ type: "done" });
        resolve();
      });
    });
  },
};

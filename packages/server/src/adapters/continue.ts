import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { TrustLevel, TurnUsage } from "@solace/shared";
import { killCliTree, spawnCli } from "../core/spawnCli";
import { mcpServersForAgent, type ResolvedMcpServer } from "../core/mcpServers";
import type { AdapterEvent, ProviderAdapter, RunTurnOptions } from "./types";

/** The group-chat MCP bridge, re-anchored to the *source* copy from the package root exactly as
 * claude-code.ts and gemini-cli.ts do - it's plain JS with no compile step, so the same path
 * works under `tsx watch` and in `dist/`. */
const SOLACE_BRIDGE_SCRIPT = join(__dirname, "..", "..", "src", "mcp", "solaceBridge.mjs");

/**
 * Continue CLI's own built-in tool names, read back from the CLI itself rather than guessed:
 * a `--verbose` run logs `Tools prepared {"toolNames":[...]}`, which on the installed 1.5.47
 * build is exactly
 *   Read, Write, List, Bash, Fetch, Checklist, CheckBackgroundJob, AskQuestion, Edit, Exit, Skills
 * (captured 2026-09-16). Only the three this file actually names are pinned here; the rest are
 * listed so a future reader can see what the vocabulary is without re-running the CLI.
 *
 * These are the exact spellings `--allow` / `--exclude` expect. A typo is silently meaningless
 * rather than an error - `--exclude Bsh` would leave shell access wide open and nothing would
 * say so - which is what continueArgs.test.ts pins.
 */
export const CONTINUE_WRITE_TOOLS = ["Write", "Edit"] as const;
export const CONTINUE_SHELL_TOOL = "Bash";

/**
 * Trust level -> Continue CLI's own flags. Every mapping below was verified behaviourally
 * against the real 1.5.47 binary on 2026-09-16 by driving it against a local stub model that
 * unconditionally requests a `Write` tool call, then checking whether the file actually appeared
 * on disk and what the session transcript recorded.
 *
 *   plan              -> --readonly   ("Start in plan mode (read-only tools)"). The Write call
 *                        came back status "canceled" / "Command blocked by security policy" and
 *                        no file was created.
 *   bypassPermissions -> --auto       ("Start in auto mode (all tools allowed)"). The file was
 *                        created and the turn completed normally.
 *   acceptEdits       -> --allow Write --allow Edit --exclude Bash. Verified in the same way:
 *                        the write succeeded with no approval, AND `Bash` disappeared from the
 *                        `Tools prepared` list entirely, so the model cannot even see the shell.
 *                        This is a real boundary rather than an approximation, which is what
 *                        makes the level honest to offer.
 *
 * Two of our five levels are deliberately NOT offered, and permissionCatalog.ts must omit them:
 *
 *   manual  - Continue has no external approval hook (no --permission-prompt-tool equivalent;
 *             its only interactive gate is the TUI). Run headless with no mode flag, a tool that
 *             would need approval is AUTO-CANCELLED: the transcript records
 *             status "canceled" with output "Command blocked by security policy", and - worse -
 *             the process then exits 0 having printed NOTHING at all. That is the same
 *             auto-reject trap OpenCode has, so offering "manual" would promise a human gate
 *             that does not exist and would in practice produce silent empty turns.
 *   auto    - there is no classifier-judged middle ground between --readonly and --auto, so
 *             "auto" would just be a second, more cautious-sounding name for
 *             "bypassPermissions" - the same reason gemini-cli.ts and copilot-cli.ts omit it.
 */
export function continuePermissionFlags(trustLevel: TrustLevel): string[] {
  switch (trustLevel) {
    case "bypassPermissions":
      return ["--auto"];
    case "acceptEdits":
      return [
        ...CONTINUE_WRITE_TOOLS.flatMap((tool) => ["--allow", tool]),
        "--exclude",
        CONTINUE_SHELL_TOOL,
      ];
    case "plan":
      return ["--readonly"];
    default:
      // "manual" and "auto" are not in the catalog (see the block comment above). If one ever
      // reaches here anyway - a hand-edited .solace-state.json, say - fall back to the most
      // restrictive real mode rather than silently granting more than was asked for.
      return ["--readonly"];
  }
}

/**
 * Where Continue keeps config, sessions and logs. CONTINUE_GLOBAL_DIR relocates all three
 * (verified: with it set, a fresh index/ and logs/ appeared in the target and ~/.continue was
 * left untouched). We READ this to find the session transcript; we never relocate it ourselves,
 * because the user's models and any hub sign-in live there too and pointing Continue at an empty
 * directory would strip an agent of the very config that lets it reach a model.
 */
export function continueGlobalDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CONTINUE_GLOBAL_DIR ?? join(homedir(), ".continue");
}

/**
 * The solace bridge as a Continue `mcpServers:` entry.
 *
 * The shape is confirmed live, not inferred: with this block in the active config.yaml a
 * `--verbose` run logged `solace_ping` inside its own `Tools prepared` toolNames array, and the
 * `env:` map reached the server process (the stub server echoed SOLACE_TOKEN back in its tool
 * description, and the value we set came through verbatim). Split out from the file write so it
 * can be asserted on without touching the filesystem, exactly as geminiSettings() is.
 *
 * Emitted as YAML whose scalars are JSON.stringify'd. JSON is a subset of YAML, so that is a
 * correct and - more to the point - injection-proof way to write Windows paths full of
 * backslashes and any user-supplied server name or env value into a YAML document without a
 * YAML serialiser on hand (see the dependency note on buildContinueConfig).
 */
export function continueMcpServersYaml(
  agentId: string,
  serverPort: number,
  turnToken?: string,
  userServers: ResolvedMcpServer[] = [],
  /** Omit the user's own MCP servers. See the trustLevel note on stageUserServers. */
  includeUserServers = true,
): string {
  const entries: { name: string; command: string; args: string[]; env: Record<string, string> }[] = [
    {
      name: "solace",
      command: process.execPath,
      args: [SOLACE_BRIDGE_SCRIPT],
      env: {
        SOLACE_AGENT_ID: agentId,
        SOLACE_SERVER_PORT: String(serverPort),
        ...(turnToken ? { SOLACE_TURN_TOKEN: turnToken } : {}),
      },
    },
  ];
  // The user's own servers join the same list. Written after the bridge so a name collision
  // cannot displace it - though validateMcpServer already rejects the reserved name at the write
  // boundary, which is where a human should hear about it.
  for (const server of includeUserServers ? userServers : []) {
    if (server.name === "solace") continue;
    entries.push({ name: server.name, command: server.command, args: server.args, env: server.env });
  }

  const lines = ["mcpServers:"];
  for (const entry of entries) {
    lines.push(`  - name: ${JSON.stringify(entry.name)}`);
    lines.push(`    command: ${JSON.stringify(entry.command)}`);
    lines.push(`    args: ${JSON.stringify(entry.args)}`);
    if (Object.keys(entry.env).length > 0) {
      lines.push("    env:");
      for (const [key, value] of Object.entries(entry.env)) {
        lines.push(`      ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
      }
    }
  }
  return lines.join("\n");
}

/**
 * Whether the user's own MCP servers may be registered for a turn at this trust level.
 *
 * Continue's permission modes DO NOT GATE MCP TOOLS. Verified directly on 2026-09-16: under
 * `--readonly`, a `Write` call came back status "canceled" / "Command blocked by security policy"
 * with no file created, while in the very same mode an MCP tool call was EXECUTED - its result
 * came back and the turn ran a second model round-trip on it. So `--readonly` constrains the
 * CLI's own built-in tools and nothing else.
 *
 * That makes "plan" the one level where registering a user's server would actively mislead: an
 * agent the user set to read-only would be able to call a third-party tool whose blast radius
 * this app cannot inspect - a tool that talks to a network API, say - with no gate at all and
 * nothing in the UI saying so. So at "plan" they are simply not registered. That costs the
 * feature at one trust level; the alternative silently sells an ungated capability as read-only.
 *
 * The solace bridge itself IS registered at every level, for the reason claude-code.ts gives:
 * talking to your teammates is bookkeeping inside this app with no effect on the user's machine.
 * Its one privileged tool, get_secret, is gated in the server's own /internal/solace/secret route
 * rather than by which tools a flag list happens to expose - which is exactly why that design
 * holds up here, where the tool list turns out to gate nothing.
 */
export function stageUserServers(trustLevel: TrustLevel): boolean {
  return trustLevel !== "plan";
}

/** A top-level `mcpServers:` key - column 0, block style. Used only to decide whether appending
 * ours would create a DUPLICATE top-level key, which YAML either rejects or silently resolves in
 * an order we do not control. */
const TOP_LEVEL_MCP_SERVERS = /^mcpServers\s*:/m;

/**
 * Build the per-turn config: the user's own config.yaml, byte-for-byte, with our `mcpServers:`
 * block appended. Returns undefined when we must not touch it.
 *
 * Why an append and not a parse-merge: @solace/server has no YAML dependency, and adding one is
 * out of scope for this adapter. An append onto an unmodified copy needs no parser, so it cannot
 * corrupt, reorder or drop anything the user wrote - the original text is still the whole
 * document, with one well-formed block after it.
 *
 * It bails, rather than guessing, in the two cases where an append is not provably safe:
 *   - the config already declares a top-level `mcpServers:`, where appending would produce a
 *     duplicate key; and
 *   - there is no readable config at all, where there is nothing to append to and inventing a
 *     models: section would mean inventing a provider and an API key.
 * In both cases the turn simply runs on the user's own config with no solace bridge. That costs
 * a feature; the alternative risks breaking the config an agent needs to reach a model at all.
 *
 * NOTHING here writes to the user's config. The caller puts the result in a fresh temp file and
 * passes it with --config, which Continue accepts as an absolute path (verified: --config
 * pointed at another file selected that file's model while sessions still went to the global
 * dir).
 */
export function buildContinueConfig(userConfigText: string | undefined, mcpServersYaml: string): string | undefined {
  if (!userConfigText || !userConfigText.trim()) return undefined;
  if (TOP_LEVEL_MCP_SERVERS.test(userConfigText)) return undefined;
  const separator = userConfigText.endsWith("\n") ? "" : "\n";
  return `${userConfigText}${separator}${mcpServersYaml}\n`;
}

/**
 * Pure so it can be asserted on without spawning anything - see continueArgs.test.ts. The prompt
 * is deliberately NOT a parameter: it never belongs in argv, and leaving it out of this signature
 * is what makes that impossible to get wrong.
 */
export function buildContinueArgs(opts: {
  trustLevel: TrustLevel;
  /** The prior Continue session to continue from, or undefined on a first turn. */
  sessionId?: string;
  /** An absolute path to the per-turn config, when one could be built. */
  configPath?: string;
}): string[] {
  return [
    ...(opts.configPath ? ["--config", opts.configPath] : []),
    // Continue only ever APPENDS to an existing session; --fork starts a new session seeded with
    // the forked one's full history. Verified live: the turn after `--fork <id>` sent the
    // complete prior exchange (user message, assistant tool call, tool result, assistant reply)
    // up to the model ahead of the new prompt, so an agent genuinely remembers its own last turn.
    ...(opts.sessionId ? ["--fork", opts.sessionId] : []),
    ...continuePermissionFlags(opts.trustLevel),
    // -p goes LAST, and this is not cosmetic. `cn -p --format json` fails outright with "A prompt
    // is required when using the -p/--print flag" while `cn --format json -p` reads stdin fine:
    // putting -p before another option breaks Continue's own stdin detection. Reproduced on the
    // installed 1.5.47 build 2026-09-16. Keeping -p last is the position every real invocation
    // here was verified in.
    //
    // No --format json. It looks like the machine-readable mode every other adapter uses and is
    // not one: it appends a system instruction telling the MODEL to emit JSON ("You are
    // operating in JSON output mode... the entire response must be parseable JSON" - read
    // straight off the wire from the request body), then wraps whatever comes back, stamping
    // {"note":"Response was not valid JSON, so it was wrapped in a JSON object"} when it doesn't
    // comply. It carries no tool calls, no usage and no session id, and it corrupts the answer
    // text by forcing the model into JSON. Plain -p returns the answer verbatim; the structured
    // data comes from the session transcript instead (see readSessionTranscript).
    "-p",
  ];
}

/* -------------------------------------------------------------------------- */
/* Session transcript                                                          */
/* -------------------------------------------------------------------------- */

/**
 * What a Continue session file carries that we can honestly report. Shape captured from a real
 * transcript on 2026-09-16, not guessed:
 *
 *   {"sessionId":"...","workspaceDirectory":"C:\\...","history":[
 *      {"message":{"role":"user","content":"..."}},
 *      {"message":{"role":"assistant","content":"","toolCalls":[{"id":"call_1","type":"function",
 *        "function":{"name":"Read","arguments":"{\"filepath\":\"note.txt\"}"}}],
 *        "usage":{"prompt_tokens":50,"completion_tokens":12,"total_tokens":62,"model":"mock-model",
 *        "cost_cents":0}},
 *       "toolCallStates":[{"toolCallId":"call_1","status":"done","parsedArgs":{...},"output":[...]}]},
 *      {"message":{"role":"assistant","content":"The file says hello.","usage":{...}}}],
 *    "usage":{"totalCost":0.000292,"promptTokens":250,"completionTokens":21,...}}
 *
 * This file - not stdout - is the only place Continue exposes tool calls, token counts, cost and
 * the resolved model, which is why the adapter reads it after the turn instead of parsing a
 * stream that does not exist.
 */
export interface ContinueTranscript {
  events: AdapterEvent[];
  usage?: TurnUsage;
  model?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Turn a parsed session file into the tool-use / usage / model events for ONE turn.
 *
 * `fromIndex` is how many history entries existed before this turn started, so a resumed session
 * does not re-report every tool call the agent made in earlier turns. On a forked session the
 * history is seeded with the parent's entries, so without this an agent's tenth turn would
 * replay its first nine.
 *
 * Everything is shape-guarded rather than trusted: this is a file on disk that another program
 * writes, and a partially-flushed or newer-format transcript should cost us a tool-call line,
 * not throw inside a turn that otherwise succeeded.
 */
export function parseContinueTranscript(session: unknown, fromIndex = 0): ContinueTranscript {
  const events: AdapterEvent[] = [];
  let model: string | undefined;
  let usage: TurnUsage | undefined;

  if (!isRecord(session)) return { events };
  const history = Array.isArray(session.history) ? session.history.slice(fromIndex) : [];

  let inputTokens = 0;
  let outputTokens = 0;
  let sawTokens = false;

  for (const entry of history) {
    if (!isRecord(entry)) continue;
    const message = isRecord(entry.message) ? entry.message : undefined;
    if (!message || message.role !== "assistant") continue;

    // Per-message usage. Summed across the turn's assistant messages because a turn that calls a
    // tool produces one assistant message per model round-trip, each with its own counts - the
    // top-level session.usage is cumulative over the WHOLE session (and over the forked parent's
    // history too), so it would over-report every turn after the first.
    const messageUsage = isRecord(message.usage) ? message.usage : undefined;
    if (messageUsage) {
      if (typeof messageUsage.prompt_tokens === "number") {
        inputTokens += messageUsage.prompt_tokens;
        sawTokens = true;
      }
      if (typeof messageUsage.completion_tokens === "number") {
        outputTokens += messageUsage.completion_tokens;
        sawTokens = true;
      }
      // The model the provider actually resolved the request to, as the provider itself named it.
      if (typeof messageUsage.model === "string" && messageUsage.model) model = messageUsage.model;
    }

    // Tool calls. `toolCallStates` carries the executed status and output; `toolCalls` carries
    // the raw request. Prefer the state, since it is the one that knows whether the call actually
    // ran - a call the permission mode cancelled is recorded there as status "canceled".
    const states = Array.isArray(entry.toolCallStates) ? entry.toolCallStates : [];
    for (const state of states) {
      if (!isRecord(state)) continue;
      const call = isRecord(state.toolCall) ? state.toolCall : undefined;
      const fn = call && isRecord(call.function) ? call.function : undefined;
      const name = typeof fn?.name === "string" ? fn.name : undefined;
      if (!name) continue;
      // parsedArgs is Continue's own already-decoded argument object; `function.arguments` is the
      // raw JSON string the model emitted. Pass the structured one through unflattened so
      // core/toolLabel.ts can derive a human label from the real values.
      const input = isRecord(state.parsedArgs) ? state.parsedArgs : undefined;
      const cancelled = state.status === "canceled";
      events.push({
        type: "tool-use",
        // A cancelled call is called out in the description because in every mode except
        // bypassPermissions this is how a blocked write surfaces - and Continue prints nothing
        // at all about it on stdout.
        description: `${name}(${JSON.stringify(input ?? {})})${cancelled ? " - blocked by permission mode" : ""}`,
        toolName: name,
        input: input ?? {},
      });
    }
  }

  if (sawTokens) {
    usage = { inputTokens, outputTokens };
    // No totalCostUsd. Continue reports `cost_cents` per message and `totalCost` per session, but
    // both were 0 for a locally-configured model on the build verified here, and a figure that is
    // only meaningful for hub-billed models would read as "this turn was free" for everyone else.
    // Reporting nothing is honest; reporting 0 is not.
  }

  return { events, usage, model };
}

/** How many history entries a session already has, so parseContinueTranscript can skip them. */
export function transcriptLength(session: unknown): number {
  if (!isRecord(session)) return 0;
  return Array.isArray(session.history) ? session.history.length : 0;
}

function readSessionFile(sessionsDir: string, id: string): unknown | undefined {
  const path = join(sessionsDir, `${id}.json`);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    // A transcript still being written, or in a format this build does not produce. A turn that
    // otherwise worked should not fail because its bookkeeping file was unreadable.
    return undefined;
  }
}

function listSessionIds(sessionsDir: string): string[] {
  try {
    return readdirSync(sessionsDir)
      .filter((name) => name.endsWith(".json") && name !== "sessions.json")
      .map((name) => name.slice(0, -".json".length));
  } catch {
    return [];
  }
}

/**
 * Find the session a --fork run just created.
 *
 * --fork does NOT append to the session it forks, and it does NOT honour
 * CONTINUE_CLI_TEST_SESSION_ID either - both verified: forking produced a fresh random id and the
 * id we tried to force never appeared on disk. So the only way to learn the new id is to see
 * which file appeared while we were running. `before` is the snapshot taken immediately before
 * spawning; the match is further narrowed to a transcript whose own workspaceDirectory is this
 * turn's cwd, so an unrelated `cn` the user ran by hand in another project cannot be mistaken for
 * ours.
 */
export function findForkedSessionId(
  before: string[],
  after: string[],
  sessionsDir: string,
  cwd: string,
): string | undefined {
  const known = new Set(before);
  const candidates = after.filter((id) => !known.has(id));
  if (candidates.length === 0) return undefined;
  const matching = candidates.filter((id) => {
    const session = readSessionFile(sessionsDir, id);
    return isRecord(session) && session.workspaceDirectory === cwd;
  });
  const pool = matching.length > 0 ? matching : candidates;
  // More than one is only reachable if something else wrote a session in this same workspace
  // while our turn ran. Picking none would silently lose continuity for good, so take the last
  // one and let the next turn's own transcript correct the record if it was the wrong guess.
  return pool[pool.length - 1];
}

export const continueAdapter: ProviderAdapter = {
  // The double assertion is load-bearing and TEMPORARY: "continue" is not in shared's ProviderId
  // union yet, because seven adapters are being built in parallel and every one of them needs a
  // line in the same shared file. CONTINUE-REGISTRATION.md states the exact line to add; once the
  // orchestrator applies it this becomes a plain `id: "continue"` and the cast must be deleted.
  id: "continue" as unknown as ProviderAdapter["id"],
  async runTurn({ cwd, prompt, trustLevel, agentId, turnToken, sessionId, onEvent, signal }: RunTurnOptions): Promise<void> {
    const serverPort = Number(process.env.PORT ?? 4310);
    const globalDir = continueGlobalDir();
    const sessionsDir = join(globalDir, "sessions");

    // Continue picks a random session id per run unless CONTINUE_CLI_TEST_SESSION_ID says
    // otherwise, so on a FIRST turn we choose the id ourselves and know the transcript path even
    // if the turn dies before producing a line. On a resumed turn --fork ignores that env var and
    // mints its own id, which findForkedSessionId recovers afterwards.
    const firstTurnSessionId = sessionId ? undefined : randomUUID();
    if (firstTurnSessionId) onEvent({ type: "session", sessionId: firstTurnSessionId });

    // How much of the forked history is the PARENT's, so this turn doesn't replay it.
    const priorLength = sessionId ? transcriptLength(readSessionFile(sessionsDir, sessionId)) : 0;

    // Per-turn config: the user's own file plus our mcpServers block, in a fresh temp directory.
    // The user's config.yaml is only ever READ.
    let userConfigText: string | undefined;
    try {
      const path = join(globalDir, "config.yaml");
      if (existsSync(path)) userConfigText = readFileSync(path, "utf-8");
    } catch {
      userConfigText = undefined;
    }
    const configText = buildContinueConfig(
      userConfigText,
      continueMcpServersYaml(
        agentId,
        serverPort,
        turnToken,
        mcpServersForAgent(agentId),
        stageUserServers(trustLevel),
      ),
    );
    let tempDir: string | undefined;
    let configPath: string | undefined;
    if (configText) {
      try {
        tempDir = mkdtempSync(join(tmpdir(), "solace-continue-"));
        configPath = join(tempDir, "config.yaml");
        writeFileSync(configPath, configText, "utf-8");
      } catch {
        // Could not stage a config - run on the user's own instead of failing the turn.
        tempDir = undefined;
        configPath = undefined;
      }
    }

    const args = buildContinueArgs({ trustLevel, sessionId, configPath });
    const before = listSessionIds(sessionsDir);

    await new Promise<void>((resolve) => {
      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp || !tempDir) return;
        cleanedUp = true;
        try {
          rmSync(tempDir, { recursive: true, force: true });
        } catch {
          // A leftover file in the OS temp dir is not worth failing a completed turn over.
        }
      };

      const child = spawnCli("cn", args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          // Continue has no --cwd flag (checked every option in `cn --help`); a session's
          // workspaceDirectory is literally process.cwd(), so the spawn cwd above is the only
          // thing that sets it.
          ...(firstTurnSessionId ? { CONTINUE_CLI_TEST_SESSION_ID: firstTurnSessionId } : {}),
          SOLACE_AGENT_ID: agentId,
          SOLACE_SERVER_PORT: String(serverPort),
          ...(turnToken ? { SOLACE_TURN_TOKEN: turnToken } : {}),
        },
      });
      // The prompt goes in on STDIN, never as an argv element - the same rule claude-code.ts
      // spells out. `cn -p` with no positional prompt reads stdin ("echo "hello" | cn -p" is
      // Continue's own documented example, and its own error message names stdin as the
      // alternative to a positional prompt), which has no length or newline limits, so a long
      // multi-line group prompt can neither blow the command-line limit nor be truncated at the
      // first newline by the cmd.exe shim `cn` resolves to on Windows.
      child.stdin!.on("error", () => {});
      child.stdin!.end(prompt);

      let aborted = false;
      const onAbort = () => {
        aborted = true;
        // Not child.kill(): on Windows that leaves the real CLI (and the per-turn MCP bridge it
        // spawned) running against a turn we already gave up on. See killCliTree.
        killCliTree(child);
      };
      signal?.addEventListener("abort", onAbort);

      // Buffered, not streamed line-by-line, because the tool calls have to be emitted BEFORE the
      // answer they produced and they are only knowable once the process exits and the transcript
      // is on disk. Continue prints the final answer in one go anyway, so nothing that would have
      // been progressive is being held back. This is the one real cost of the CLI having no
      // structured stream, and it is a cost in liveness, not in fidelity.
      let stdoutBuffer = "";
      child.stdout!.on("data", (chunk) => {
        stdoutBuffer += chunk.toString();
      });
      let stderrBuffer = "";
      child.stderr!.on("data", (chunk) => {
        stderrBuffer += chunk.toString();
      });

      child.on("close", (code) => {
        signal?.removeEventListener("abort", onAbort);
        cleanup();
        if (aborted) {
          // Why it was aborted is the caller's knowledge, not ours - see AdapterEvent.cancelled.
          onEvent({ type: "cancelled" });
          onEvent({ type: "done" });
          resolve();
          return;
        }

        const resolvedSessionId =
          firstTurnSessionId ?? findForkedSessionId(before, listSessionIds(sessionsDir), sessionsDir, cwd);
        if (sessionId && resolvedSessionId && resolvedSessionId !== sessionId) {
          // The fork's own new id is what the NEXT turn must fork from; continuing to fork the
          // original would re-run the same conversation prefix forever and lose every turn since.
          onEvent({ type: "session", sessionId: resolvedSessionId });
        }

        const transcript = resolvedSessionId
          ? parseContinueTranscript(readSessionFile(sessionsDir, resolvedSessionId), priorLength)
          : { events: [] as AdapterEvent[], usage: undefined, model: undefined };
        if (transcript.model) onEvent({ type: "model", model: transcript.model });
        for (const event of transcript.events) onEvent(event);

        const text = stdoutBuffer.trim();
        if (text) onEvent({ type: "text", text });
        if (transcript.usage) onEvent({ type: "usage", usage: transcript.usage });

        // Continue exits 0 even when the run failed - a bad model config printed
        // {"status":"error","message":"404 model 'AUTODETECT' not found"} on STDOUT and still
        // exited 0 - so a non-zero code is not the only failure signal, and an empty stdout is
        // not automatically a failure either (a fully-cancelled turn also prints nothing). Report
        // an error when the process actually failed, or when it produced literally nothing and
        // did not even manage a tool call.
        if (code !== 0 && stderrBuffer.trim()) {
          onEvent({ type: "error", message: stderrBuffer.trim() });
        } else if (!text && transcript.events.length === 0) {
          onEvent({
            type: "error",
            message:
              stderrBuffer.trim() ||
              "Continue CLI produced no output. If this agent is not signed in or has no model configured, run `cn` once interactively to set up ~/.continue/config.yaml.",
          });
        }
        onEvent({ type: "done" });
        resolve();
      });

      child.on("error", (err) => {
        signal?.removeEventListener("abort", onAbort);
        cleanup();
        onEvent({ type: "error", message: `failed to start cn CLI: ${err.message}` });
        onEvent({ type: "done" });
        resolve();
      });
    });
  },
};

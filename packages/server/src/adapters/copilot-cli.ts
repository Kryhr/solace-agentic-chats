import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import * as readline from "node:readline";
import { join } from "node:path";
import type { TrustLevel, TurnUsage } from "@solace/shared";
import { killCliTree, spawnCli } from "../core/spawnCli";
import { SERVER_PORT } from "../core/serverPort";
import { addUsage, isEmptyUsage, num, put } from "../core/usage";
import { mcpServersForAgent, type ResolvedMcpServer } from "../core/mcpServers";
import type { ProviderAdapter, RunTurnOptions } from "./types";

/** The group-chat MCP bridge, re-anchored to the *source* copy from the package root exactly as
 * claude-code.ts does - it's plain JS with no compile step, so the same path works under
 * `tsx watch` and in `dist/`. */
const SOLACE_BRIDGE_SCRIPT = join(__dirname, "..", "..", "src", "mcp", "solaceBridge.mjs");

/**
 * Copilot addresses an MCP tool as `<server>-<tool>` - a single HYPHEN, not Claude Code's
 * `mcp__server__tool` and not Gemini's single underscore. Confirmed from a real turn: with the
 * bridge registered as "solace", the tool table in Copilot's own session.usage_checkpoint event
 * listed `solace-post_to_group`, `solace-list_agents` and `solace-get_secret` verbatim.
 *
 * The permission PATTERN language is a different spelling again: `--allow-tool`/`--deny-tool`
 * take `<mcp-server-name>(tool-name?)`, e.g. `solace(post_to_group)`, or bare `solace` for every
 * tool on that server (documented in `copilot help permissions`). So the two forms below are not
 * redundant - one is how the model names the tool, the other is how permissions match it.
 */
const SOLACE_SERVER = "solace";

/**
 * Where the npm package actually keeps its executable code.
 *
 * `copilot` on PATH is a .cmd shim whose entire body is `node npm-loader.js %*`, and that shim
 * is the problem this adapter has to route around: a cmd.exe command line is TERMINATED by a
 * literal newline, silently, with exit code 0 (see the long note in core/spawnCli.ts). Unlike
 * every other CLI here, Copilot has NO stdin channel for the prompt - verified: `-p -` is taken
 * as the literal one-character prompt "-" (the turn came back with
 * {"type":"user.message","data":{"content":"-"}}), and `-p` is a required string option so it
 * cannot be left to fall through to stdin either.
 *
 * So the prompt has to go in argv, and the only honest way to do that safely is to stop going
 * through cmd.exe at all: spawn `node` (a native .exe) on the loader the shim itself invokes.
 * CreateProcess passes argv straight through and handles newlines fine - which is exactly why
 * codex, a native codex.exe, was never affected by the original bug. Verified end to end: a
 * three-line prompt sent this way arrived with all three lines intact in Copilot's own
 * user.message event, where the same prompt through copilot.cmd would have lost everything
 * after line one.
 *
 * spawnCli's newline guard stays satisfied for the right reason rather than by accident: it
 * checks what the command actually RESOLVES to, and `node` resolves to node.exe, not a shim.
 */
function findLoader(): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) {
    if (!dir) continue;
    const loader = join(dir, "node_modules", "@github", "copilot", "npm-loader.js");
    if (existsSync(loader)) return loader;
  }
  return undefined;
}

/**
 * The installed Copilot package root, if it can be found. Exported because modelCatalog needs
 * the same tree to read the built-in model catalog out of the shipped SDK.
 */
export function copilotPackageDir(): string | undefined {
  const loader = findLoader();
  return loader ? join(loader, "..") : undefined;
}

/**
 * The platform-specific sub-package that carries the real binary and the bundled SDK
 * (`copilot-win32-x64` on this machine). Discovered rather than named, so a different platform
 * or a future rename doesn't silently break it.
 */
export function copilotPlatformDir(): string | undefined {
  const pkg = copilotPackageDir();
  if (!pkg) return undefined;
  const scope = join(pkg, "node_modules", "@github");
  if (!existsSync(scope)) return undefined;
  try {
    const entry = readdirSync(scope).find((name) => /^copilot-[a-z0-9]+-[a-z0-9]+$/i.test(name));
    return entry ? join(scope, entry) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Trust level -> Copilot's own permission flags.
 *
 * Copilot's permission language is unusually granular for this app: `--deny-tool` takes a
 * pattern of the form `kind(argument)` where the kinds include `write` (anything that creates or
 * modifies a file, except via the shell) and `shell(command:*?)` (shell invocations), and
 * "denial rules always take precedence over allow rules, EVEN --allow-all-tools" (verbatim from
 * `copilot help permissions`). That is what makes a real middle ground expressible here rather
 * than approximated, which is not true of most providers in this directory.
 *
 * Every mapping below was verified behaviourally with a real turn that was asked to both write
 * a file and run a shell command, not merely checked for flag acceptance:
 *
 *   plan        file NOT created; `apply_patch` blocked ("Plan mode does not permit changes
 *               outside...") AND `powershell` blocked ("Permission to run this tool was denied
 *               due to the following rules: `shell`"). Belt and braces on purpose: --mode plan
 *               is Copilot's own read-only agent mode, and the two deny rules hold even if a
 *               future build loosens what plan mode itself allows.
 *   acceptEdits file WAS created via apply_patch; `powershell` blocked by the same `shell` rule.
 *               Note this proves `shell` matches the concrete tool Copilot actually exposes on
 *               Windows, which is named `powershell`, not `shell` - the deny kind is about the
 *               tool's category, not its name, so this does not need a per-platform tool list.
 *   bypass/auto --allow-all (documented as exactly --allow-all-tools --allow-all-paths
 *               --allow-all-urls).
 *
 * "manual" is the one level Copilot CANNOT honour, and it is treated the same way codex-cli.ts
 * treats its own gap rather than being quietly faked. Claude Code has --permission-prompt-tool,
 * which hands each approval decision to an external process we control, so a real card can be
 * raised in this app's UI and a human can answer it. Copilot has no such hook. Its nearest
 * relative, --assisted-approval, routes approvals to an LLM "safety judge" INSIDE Copilot -
 * that is a model deciding, not a person, so presenting it as "approval per action" would tell
 * the user a human gate exists when none does. Nor can approvals fall through to the terminal:
 * --allow-all-tools is documented as "required for non-interactive mode", and without it a
 * headless turn has nobody to answer the prompt.
 *
 * So "manual" is NOT offered in core/permissionCatalog.ts for this provider, and the
 * unreachable case here falls back to the plan-mode flags - the safest option, never a wider
 * one. An agent that somehow arrives here is over-restricted, which is the failure direction
 * that cannot hurt anyone.
 */
export function copilotPermissionFlags(trustLevel: TrustLevel): string[] {
  switch (trustLevel) {
    case "bypassPermissions":
    case "auto":
      // Copilot's own documented shorthand for the three --allow-all-* flags together.
      return ["--allow-all"];
    case "acceptEdits":
      // Edits allowed, shell still gated - the deny rule outranks --allow-all-tools.
      return ["--allow-all-tools", "--allow-all-paths", "--deny-tool=shell"];
    case "manual":
    case "plan":
    default:
      return ["--mode", "plan", "--allow-all-tools", "--deny-tool=write", "--deny-tool=shell"];
  }
}

/**
 * Copilot takes MCP config as a JSON STRING (or a file path prefixed with "@"), augmenting
 * ~/.copilot/mcp-config.json for this session only - so nothing is written to the user's global
 * config, exactly as qwen-code.ts and claude-code.ts avoid doing.
 *
 * Verified with a real turn: Copilot emitted
 * {"type":"session.mcp_server_status_changed","data":{"serverName":"solace","status":"connected"}}
 * and then listed all three bridge tools in its own tool table.
 *
 * env is passed explicitly inside the server entry rather than relied upon through inheritance,
 * for the reason codex-cli.ts documents: an MCP server the CLI spawns is not guaranteed to
 * inherit our environment, and without SOLACE_AGENT_ID / SOLACE_TURN_TOKEN the bridge has no
 * identity and the server refuses every tool call - which presents as an agent that simply never
 * talks to the group rather than as an error.
 *
 * process.execPath rather than "node" so this doesn't depend on whatever PATH Copilot hands its
 * MCP child. `tools: ["*"]` is Copilot's own opt-in for enabling a server's tools without an
 * interactive confirmation.
 */
export function solaceMcpConfig(
  agentId: string,
  serverPort: number,
  turnToken?: string,
  userServers: ResolvedMcpServer[] = [],
): string {
  const mcpServers: Record<string, unknown> = {
    [SOLACE_SERVER]: {
      command: process.execPath,
      args: [SOLACE_BRIDGE_SCRIPT],
      tools: ["*"],
      env: {
        SOLACE_AGENT_ID: agentId,
        SOLACE_SERVER_PORT: String(serverPort),
        ...(turnToken ? { SOLACE_TURN_TOKEN: turnToken } : {}),
      },
    },
  };
  // --additional-mcp-config is the one mechanism of the five that genuinely ADDS to what the
  // user already has (~/.copilot/mcp-config.json) rather than replacing it. A user server
  // registered here therefore rides alongside both our bridge AND anything they configured for
  // Copilot themselves - and if they had already added the same server to Copilot directly,
  // this entry simply wins for this session and nothing is written to their file either way.
  //
  // `tools: ["*"]` is set on OUR bridge only. On a third-party server it would be Copilot's
  // opt-in to enable every tool without an interactive confirmation, which is the user's call
  // to make through the agent's trust level, not ours to make by registering a server.
  for (const server of userServers) {
    if (server.name === SOLACE_SERVER) continue;
    mcpServers[server.name] = { command: server.command, args: server.args, env: server.env };
  }
  return JSON.stringify({ mcpServers });
}

/**
 * Pure so it can be asserted on without spawning anything - see copilotArgs.test.ts.
 *
 * Unlike the other adapters in this directory the prompt IS a parameter here, because Copilot
 * has no stdin channel for it (see findLoader's note). That is a deliberate, verified exception
 * and not a regression of the rule: the transport is `node` rather than a .cmd shim precisely so
 * that a multi-line prompt in argv is safe. The test suite asserts the loader-not-shim
 * invariant, which is the thing that actually makes this sound.
 */
export function buildCopilotArgs(opts: {
  loader: string;
  prompt: string;
  trustLevel: TrustLevel;
  model?: string;
  effort?: string;
  /** The id to resume, or undefined on a first turn. */
  sessionId?: string;
  /** The id to register when this is a first turn. */
  newSessionId: string;
  agentId: string;
  serverPort: number;
  turnToken?: string;
  /** The user's registered MCP servers that apply to this agent. Defaults to none, so every
   * existing caller and test sees exactly the argv it saw before. */
  userServers?: ResolvedMcpServer[];
}): string[] {
  return [
    opts.loader,
    "-p",
    opts.prompt,
    "--output-format",
    "json",
    // Copilot's --session-id is documented as "Resume an existing session or task by ID, OR set
    // the UUID for a new session", so the same flag covers both directions and there is no
    // separate --resume to switch to. Confirmed live in both directions: a first turn with a
    // UUID we generated came back with that exact id in the terminal {"type":"result",
    // "sessionId":...} event, and a second turn passing the same id correctly recalled the first
    // turn's message.
    //
    // Deliberately NOT --continue: it "resumes the most recent session", which is scoped to the
    // machine and not to this agent, so two Copilot agents in one workspace would silently
    // inherit each other's conversation - the same trap as codex's --last and qwen's -c. See
    // copilotArgs.test.ts, which asserts it can never appear.
    "--session-id",
    opts.sessionId ?? opts.newSessionId,
    ...copilotPermissionFlags(opts.trustLevel),
    "--additional-mcp-config",
    solaceMcpConfig(opts.agentId, opts.serverPort, opts.turnToken, opts.userServers ?? []),
    // Copilot's built-in GitHub MCP server is left alone rather than disabled: it is the user's
    // own configured tooling and turning it off is not this app's call.
    ...(opts.model ? ["--model", opts.model] : []),
    // --effort/--reasoning-effort is a real flag with a documented choice list
    // (none/minimal/low/medium/high/xhigh/max); anything outside it is rejected at parse time,
    // so the values offered in modelCatalog.ts are exactly that list and nothing is invented.
    //
    // But it is NEVER sent with `auto`, which is the only model most plans can select. Two
    // separate failures, both reproduced live:
    //   copilot --model auto --effort medium
    //     -> Error: Model "auto" does not support reasoning effort configuration.
    //   copilot --model auto --effort none
    //     -> 400 Unsupported value: 'none' is not supported with the
    //        'mai-code-1-flash-2026-06-02' model.
    // Auto picks its target model server-side, per turn, so there is no effort value that is
    // safe to send: whatever it routes to decides which values it accepts, and we cannot know
    // that before the request. Dropping the flag is the only correct behaviour, and it costs
    // nothing - auto does its own effort selection.
    ...(opts.effort && !isAutoModel(opts.model) ? ["--effort", opts.effort] : []),
  ];
}

/** Copilot's server-routed model. Compared case-insensitively and trimmed because it arrives
 * from a stored agent config that a user (or an older build of this app) may have written. */
function isAutoModel(model: string | undefined): boolean {
  return (model ?? "").trim().toLowerCase() === "auto";
}

/**
 * Copilot writes the not-signed-in failure as PLAIN TEXT on stderr and exits 1, emitting no
 * JSON at all - not even the terminal `result` event - because the auth check runs before the
 * JSONL pump is attached. So a parser waiting for `result` sees only EOF, and stderr is the
 * only evidence there is. Read out of the shipped bundle (app.js, the prompt-mode auth branch)
 * rather than guessed, and deliberately matched loosely: the point is to recognise the case,
 * and the CLI's own words are still what gets shown.
 */
export function isNotSignedInError(stderr: string): boolean {
  return /No authentication information found|Authentication token found but could not be validated|not supported by Copilot/i.test(
    stderr,
  );
}

/** What to tell the user when the CLI says it has no credentials. The fix is a real command
 * they can run, not a generic "check your setup". */
export const COPILOT_LOGIN_HINT =
  "GitHub Copilot CLI is installed but not signed in. Run `copilot login` in a terminal, then try again.";

/**
 * Copilot's `assistant.usage` event - one per model call, on builds that emit it.
 *
 * Shape read verbatim off the shipped app.js (@github/copilot 1.1.21), which builds it as
 *
 *   emitEphemeral("assistant.usage", { model, ...inputTokens?, ...outputTokens?,
 *     ...cacheReadTokens?, ...cacheWriteTokens?, ...reasoningTokens?, ...cost?, ...duration?,
 *     initiator, ...copilotUsage? })
 *
 * and cross-checked against the CLI's own shipped JSON schema (schemas/session-events.schema.json,
 * definition AssistantUsageData). Every token field is spread in conditionally, so an absent
 * field genuinely means "not reported" rather than zero.
 *
 * `cost` there is NOT dollars - the schema calls it "Model multiplier cost for billing purposes"
 * - and `copilotUsage.totalNanoAiu` is a nano-AI-unit figure. Both are carried as otherCosts
 * rather than as totalCostUsd, because neither is a price and nobody outside GitHub knows the
 * conversion rate.
 *
 * NOT LIVE-VERIFIED. On the build probed here (1.1.21, `--output-format json`) a complete real
 * turn emitted no `assistant.usage` line at all - see copilotTurnUsage. This function exists so
 * that when Copilot does emit it, the numbers are read correctly instead of ignored.
 */
export function copilotCallUsage(raw: unknown): TurnUsage | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const d = raw as Record<string, unknown>;
  const usage: TurnUsage = {};
  put(usage, "inputTokens", num(d.inputTokens));
  put(usage, "outputTokens", num(d.outputTokens));
  put(usage, "cacheReadTokens", num(d.cacheReadTokens));
  put(usage, "cacheWriteTokens", num(d.cacheWriteTokens));
  put(usage, "reasoningTokens", num(d.reasoningTokens));
  // "Number of output tokens used for reasoning" - i.e. already inside outputTokens.
  if (usage.reasoningTokens !== undefined) usage.reasoningCountedInOutput = true;
  if (usage.cacheReadTokens !== undefined || usage.cacheWriteTokens !== undefined) {
    // Copilot's inputTokens is the whole prompt count with cache reads inside it, matching its
    // own promptCacheBreakState record where prompt_tokens comfortably exceeds cache_read for
    // the same model call.
    usage.cacheCountedInInput = true;
  }
  const copilotUsage = d.copilotUsage;
  const nano =
    typeof copilotUsage === "object" && copilotUsage !== null
      ? num((copilotUsage as Record<string, unknown>).totalNanoAiu)
      : undefined;
  if (nano !== undefined) usage.otherCosts = [{ amount: nano, unit: "nano-AIU" }];
  return isEmptyUsage(usage) ? undefined : usage;
}

/**
 * Copilot's `session.usage_checkpoint` - the only place this build states any token count.
 *
 * Captured live from `--output-format json` on 1.1.21, trimmed into
 * __fixtures__/copilot-run.jsonl:
 *
 *   {"type":"session.usage_checkpoint","data":{"totalNanoAiu":185454000,"totalPremiumRequests":1,
 *     "modelCacheState":[...],
 *     "promptCacheBreakState":[{"conversation":"main","models":{"mai-code-1.1-flash":{
 *        ..., "prompt_tokens":11425, "cache_read":1280, "cache_write":0,
 *        "cache_details_reported":true, ...}}}]}}
 *
 * Two things the previous adapter got wrong here. It emitted a separate "usage" event for every
 * conversation and every model in that array, so whichever came last silently won; and it
 * presented `prompt_tokens` as the turn's input tokens with no output tokens at all, which the
 * UI then rendered as a confident "0 out".
 *
 * What this block actually is, per the CLI's own schema, is a "per-conversation prompt-cache-break
 * detector baseline" - the state of the LAST model call on each conversation, not a sum over the
 * turn. So only the `main` conversation is read (a sub-agent conversation is a separate baseline,
 * not an addend), and the result is stamped with a caveat saying precisely that: a figure that
 * covers one call of a six-call turn must not be shown as if it covered the turn.
 *
 * `totalNanoAiu` and `totalPremiumRequests` on this event are session-cumulative, so they are
 * deliberately not taken from here; the result event's per-turn premium count is used instead.
 */
export function copilotCheckpointUsage(raw: unknown): TurnUsage | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const states = (raw as Record<string, unknown>).promptCacheBreakState;
  if (!Array.isArray(states)) return undefined;
  const main =
    states.find((s) => (s as Record<string, unknown>)?.conversation === "main") ??
    (states.length === 1 ? states[0] : undefined);
  const models = (main as { models?: Record<string, unknown> } | undefined)?.models;
  if (!models || typeof models !== "object") return undefined;
  const usage: TurnUsage = {};
  for (const value of Object.values(models)) {
    if (typeof value !== "object" || value === null) continue;
    const m = value as Record<string, unknown>;
    put(usage, "inputTokens", num(m.prompt_tokens));
    put(usage, "cacheReadTokens", num(m.cache_read));
    put(usage, "cacheWriteTokens", num(m.cache_write));
  }
  if (isEmptyUsage(usage)) return undefined;
  // prompt_tokens on this record is the whole prompt for that call, cache_read included.
  if (usage.cacheReadTokens !== undefined || usage.cacheWriteTokens !== undefined) usage.cacheCountedInInput = true;
  usage.caveat =
    "Copilot publishes no output-token count in its JSON stream, and the prompt figure it does " +
    "publish covers only the last model call of the turn.";
  return usage;
}

/**
 * Copilot's terminal `result` event. Captured live:
 *
 *   {"type":"result", ..., "usage":{"premiumRequests":1,"totalApiDurationMs":1587,
 *     "sessionDurationMs":4465,"codeChanges":{"linesAdded":0,"linesRemoved":0,...}}}
 *
 * No tokens and no dollars anywhere in it. A premium request is the unit GitHub actually bills
 * the user in, so it is reported as that unit rather than dropped or converted into a dollar
 * figure this app would be inventing.
 */
export function copilotResultUsage(raw: unknown): TurnUsage | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const premium = num((raw as Record<string, unknown>).premiumRequests);
  if (premium === undefined) return undefined;
  return { otherCosts: [{ amount: premium, unit: "premium request" }] };
}

/**
 * Combines Copilot's three usage-bearing events into the one report for the turn.
 *
 * `assistant.usage` is preferred whenever it appears, because it is the only source with a real
 * output-token count and it is per-call, so summing it covers the whole turn. It was NOT
 * observed on the build probed here: a complete real turn through `--output-format json`
 * emitted session.usage_checkpoint, model.call_finished and result, and no assistant.usage line.
 * The checkpoint's partial figures are therefore the fallback, carrying their own caveat.
 *
 * The premium-request count from `result` is merged into whichever of the two is used, because
 * it is the only per-turn cost figure Copilot states at all.
 */
export function copilotTurnUsage(
  callUsage: TurnUsage | undefined,
  checkpointUsage: TurnUsage | undefined,
  resultUsage: TurnUsage | undefined,
): TurnUsage | undefined {
  const tokens = callUsage ?? checkpointUsage;
  if (!tokens) return resultUsage;
  if (!resultUsage) return tokens;
  return addUsage(tokens, resultUsage);
}

export const copilotCliAdapter: ProviderAdapter = {
  id: "copilot-cli",
  async runTurn({
    cwd,
    prompt,
    trustLevel,
    model,
    effort,
    agentId,
    turnToken,
    sessionId,
    onEvent,
    signal,
  }: RunTurnOptions): Promise<void> {
    const serverPort = SERVER_PORT;
    const loader = findLoader();
    if (!loader) {
      onEvent({
        type: "error",
        message:
          "Could not find the GitHub Copilot CLI's npm-loader.js on PATH. Install it with `npm install -g @github/copilot`.",
      });
      onEvent({ type: "done" });
      return;
    }

    // Pick the id ourselves on a first turn so we know it even if the turn dies before we parse
    // a single line - same reason claude-code.ts does.
    const resolvedSessionId = sessionId ?? randomUUID();
    if (!sessionId) onEvent({ type: "session", sessionId: resolvedSessionId });

    const args = buildCopilotArgs({
      loader,
      prompt,
      trustLevel,
      model,
      effort,
      sessionId,
      newSessionId: resolvedSessionId,
      agentId,
      serverPort,
      turnToken,
      userServers: mcpServersForAgent(agentId),
    });

    await new Promise<void>((resolve) => {
      // "node", not "copilot": see findLoader. spawnCli still guards everything else.
      const child = spawnCli(process.execPath, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          SOLACE_AGENT_ID: agentId,
          SOLACE_SERVER_PORT: String(serverPort),
          ...(turnToken ? { SOLACE_TURN_TOKEN: turnToken } : {}),
        },
      });

      const rl = readline.createInterface({ input: child.stdout! });

      let aborted = false;
      const onAbort = () => {
        aborted = true;
        // Not child.kill(): on Windows that leaves the real CLI (and the per-turn MCP bridge it
        // spawned) running against a turn we already gave up on. See killCliTree.
        killCliTree(child);
      };
      signal?.addEventListener("abort", onAbort);

      let reportedModel: string | undefined;
      // Three different events carry three different parts of Copilot's accounting; see
      // copilotTurnUsage for why all three are read and why none of them alone is enough.
      let callUsage: TurnUsage | undefined;
      let checkpointUsage: TurnUsage | undefined;
      let resultUsage: TurnUsage | undefined;
      // Copilot streams reasoning as many tiny deltas and then never restates it whole, so it
      // is accumulated per reasoningId and flushed once, rather than emitting one "reasoning"
      // event per word.
      const reasoning = new Map<string, string>();
      const flushReasoning = () => {
        for (const [, text] of reasoning) {
          if (text.trim()) onEvent({ type: "reasoning", text });
        }
        reasoning.clear();
      };

      rl.on("line", (line) => {
        if (!line.trim()) return;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line);
        } catch {
          // Non-JSON line - surface it rather than dropping it silently.
          onEvent({ type: "text", text: line });
          return;
        }
        const type = event.type as string | undefined;
        const data = (event.data ?? {}) as Record<string, unknown>;

        // Copilot's real JSONL vocabulary, captured from live turns. Anything not handled here
        // is intentionally ignored rather than guessed at - but the three that carry actual
        // content (assistant.message, assistant.reasoning_delta, result) are all covered, which
        // is the mistake this file is written to avoid repeating.
        switch (type) {
          case "session.auto_mode_resolved": {
            // `--model auto` routes server-side, so this is the only statement of which model
            // will actually answer. Reported for the same reason claude-code.ts reports its
            // resolved model: an alias that could be any of several models is not an answer.
            const chosen = data.chosenModel;
            if (typeof chosen === "string" && chosen && chosen !== reportedModel) {
              reportedModel = chosen;
              onEvent({ type: "model", model: chosen });
            }
            break;
          }
          case "assistant.reasoning_delta": {
            const id = typeof data.reasoningId === "string" ? data.reasoningId : "";
            const delta = typeof data.deltaContent === "string" ? data.deltaContent : "";
            if (delta) reasoning.set(id, (reasoning.get(id) ?? "") + delta);
            break;
          }
          case "assistant.message": {
            // The settled message. Preferred over the assistant.message_delta stream because it
            // is the only place the COMPLETE tool arguments appear: assistant.tool_call_delta
            // carries `inputDelta` fragments of a JSON string ("{\"", "command", ...) which
            // would have to be reassembled and could not be trusted mid-stream.
            flushReasoning();
            const modelId = data.model;
            if (typeof modelId === "string" && modelId && modelId !== reportedModel) {
              reportedModel = modelId;
              onEvent({ type: "model", model: modelId });
            }
            const content = data.content;
            if (typeof content === "string" && content.trim()) onEvent({ type: "text", text: content });
            const requests = data.toolRequests;
            if (Array.isArray(requests)) {
              for (const raw of requests) {
                const req = raw as { name?: unknown; arguments?: unknown; intentionSummary?: unknown };
                if (typeof req?.name !== "string" || !req.name) continue;
                // toolName and input passed through unflattened so core/toolLabel.ts can derive
                // a human label from the real argument values.
                onEvent({
                  type: "tool-use",
                  description:
                    typeof req.intentionSummary === "string" && req.intentionSummary
                      ? req.intentionSummary
                      : `${req.name}(${JSON.stringify(req.arguments)})`,
                  toolName: req.name,
                  input: req.arguments,
                });
              }
            }
            break;
          }
          case "result": {
            // Terminal event. Copilot reports premium-request consumption and wall-clock time
            // here, but no input/output token counts and no dollar cost, so TurnUsage carries
            // only what was actually stated - nothing is derived from a rate card this app has
            // no way to know is current.
            resultUsage = copilotResultUsage(event.usage);
            const sid = event.sessionId;
            if (typeof sid === "string" && sid && sid !== resolvedSessionId) {
              // Belt and braces: if the CLI ever rejects our id or forks the session, the stream
              // is the authority on what the session actually is.
              onEvent({ type: "session", sessionId: sid });
            }
            break;
          }
          case "session.error": {
            // A turn can fail INSIDE the JSONL stream with nothing on stderr at all. Observed
            // live: `--model auto --effort none` routed to mai-code-1-flash, which rejected the
            // effort value with a 400; the process exited 1, stderr was completely empty, and
            // the only record of the failure was this event. The close handler reads stderr, so
            // it had nothing to report - the turn simply produced no reply and no error, which
            // reads as the agent ignoring you.
            //
            // (An earlier comment in this file claimed the stream carries no error event. That
            // was wrong: it carries this one, and model.call_failure alongside it. Only this one
            // is surfaced - call_failure repeats the same message in a rawer form, and emitting
            // both would post the same failure to the chat twice.)
            const message = typeof data.message === "string" ? data.message.trim() : "";
            if (message) {
              sawStreamError = true;
              onEvent({ type: "error", message });
            }
            break;
          }
          case "session.usage_checkpoint": {
            // Session-wide accounting plus a per-call prompt figure; see copilotCheckpointUsage.
            checkpointUsage = copilotCheckpointUsage(data);
            break;
          }
          case "assistant.usage": {
            // The one event carrying real per-call token counts, when a build emits it at all.
            const call = copilotCallUsage(data);
            if (call) callUsage = addUsage(callUsage ?? {}, call);
            break;
          }
          default:
            // Nothing to SHOW, but the line is proof the CLI is alive. The idle watchdog only
            // hears about adapter events, so dropping a line silently tells it the process has
            // hung - which is how a healthy but quiet turn gets killed at the idle limit.
            onEvent({ type: "heartbeat" });
            break;
        }
      });

      // Set when the JSONL stream itself reported the failure, so the non-zero exit below does
      // not report the same thing a second time in different words.
      let sawStreamError = false;
      let stderrBuffer = "";
      child.stderr!.on("data", (chunk) => {
        stderrBuffer += chunk.toString();
      });

      child.on("close", (code) => {
        signal?.removeEventListener("abort", onAbort);
        flushReasoning();
        // Emitted once at the end rather than per event: agentManager takes each "usage" event
        // as THE usage for the turn, and Copilot spreads its figures across three events.
        const turnUsage = copilotTurnUsage(callUsage, checkpointUsage, resultUsage);
        if (turnUsage) onEvent({ type: "usage", usage: turnUsage });
        if (aborted) {
          // Why it was aborted is the caller's knowledge, not ours - see AdapterEvent.cancelled.
          onEvent({ type: "cancelled" });
        } else if (code !== 0 && !sawStreamError) {
          // stderr is the only channel a failure can use: Copilot's JSONL stream carries no
          // error event at all, and on the auth path it emits no JSON whatsoever.
          const stderr = stderrBuffer.trim();
          // The not-signed-in case gets the real fix appended to Copilot's own words, because
          // the CLI's message names three alternatives and the one that applies here is the
          // login command. Everything else is passed through verbatim.
          if (isNotSignedInError(stderr)) {
            onEvent({ type: "error", message: `${COPILOT_LOGIN_HINT}\n\n${stderr}` });
          } else if (stderr) {
            onEvent({ type: "error", message: stderr });
          }
        }
        onEvent({ type: "done" });
        resolve();
      });

      child.on("error", (err) => {
        signal?.removeEventListener("abort", onAbort);
        onEvent({ type: "error", message: `failed to start the Copilot CLI: ${err.message}` });
        onEvent({ type: "done" });
        resolve();
      });
    });
  },
};

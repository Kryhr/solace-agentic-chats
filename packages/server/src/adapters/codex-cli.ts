import * as readline from "node:readline";
import { join } from "node:path";
import type { TrustLevel, TurnUsage } from "@solace/shared";
import { killCliTree, spawnCli } from "../core/spawnCli";
import { SERVER_PORT } from "../core/serverPort";
import { accountEnv } from "../core/providerAccounts";
import { isEmptyUsage, num, put } from "../core/usage";
import { parseCodexRateLimitEvent, readCodexRateLimitFromRollout } from "../core/rateLimits";
import { mcpServersForAgent, type ResolvedMcpServer } from "../core/mcpServers";
import type { ProviderAdapter, RunTurnOptions } from "./types";

/** The group-chat MCP bridge, re-anchored to the *source* copy from the package root exactly as
 * claude-code.ts does - it's plain JS with no compile step, so the same path works under
 * `tsx watch` and in `dist/`. */
const SOLACE_BRIDGE_SCRIPT = join(__dirname, "..", "..", "src", "mcp", "solaceBridge.mjs");

/**
 * Codex has no --mcp-config flag (confirmed against `codex exec --help`). This per-invocation
 * form is INFERRED from its documented `-c, --config <key=value>` ("dotted path, value parsed
 * as TOML") applied to the `mcp_servers` table codex reads from ~/.codex/config.toml - it is
 * NOT documented as a supported way to register an MCP server, and has not been verified
 * against a real codex build. runTurn therefore treats it as strictly best-effort and falls
 * back to a plain invocation if codex rejects it (see the retry in runTurn).
 *
 * Deliberately per-invocation: writing into the user's own global ~/.codex/config.toml would
 * change how every codex run on this machine behaves, including ones we know nothing about.
 *
 * JSON.stringify does the value quoting: a TOML basic string uses the same backslash/quote
 * escapes JSON does, which matters because the script path is a Windows path full of
 * backslashes. process.execPath rather than "node" so this doesn't depend on whatever PATH
 * codex happens to hand its MCP child.
 *
 * The SOLACE_* env vars are passed explicitly because an MCP server codex spawns is not
 * guaranteed to inherit our environment, and without them the bridge has no identity or turn
 * token and every tool call would be refused by the server.
 */
export function solaceMcpConfigArgs(
  agentId: string,
  serverPort: number,
  turnToken?: string,
  userServers: ResolvedMcpServer[] = [],
): string[] {
  const entries: Array<[string, unknown]> = [
    ["mcp_servers.solace.command", process.execPath],
    ["mcp_servers.solace.args", [SOLACE_BRIDGE_SCRIPT]],
    ["mcp_servers.solace.env.SOLACE_AGENT_ID", agentId],
    ["mcp_servers.solace.env.SOLACE_SERVER_PORT", String(serverPort)],
    ...(turnToken ? ([["mcp_servers.solace.env.SOLACE_TURN_TOKEN", turnToken]] as Array<[string, unknown]>) : []),
  ];
  // Codex is the odd one out: there is no config OBJECT to merge into, only a flat list of
  // dotted `-c` overrides against the mcp_servers TOML table. So a user server is not merged,
  // it is simply more keys - one per field - under its own name. Each override sets one leaf,
  // which is why env goes in a key at a time rather than as a single table value: a whole-table
  // override under mcp_servers.<name>.env would replace whatever ~/.codex/config.toml has
  // there, and a `-c` per variable does not.
  //
  // These overrides are per-invocation and nothing is written to the user's config.toml, so a
  // server the user already has in that file keeps working; ours simply wins for this run.
  for (const server of userServers) {
    if (server.name === "solace") continue;
    // A TOML bare key is [A-Za-z0-9_-], which MCP_SERVER_NAME_PATTERN already guarantees - so
    // the name can go into the dotted path unquoted without it being able to break the key
    // syntax. That constraint is enforced at the write boundary in core/mcpServers.ts.
    entries.push([`mcp_servers.${server.name}.command`, server.command]);
    entries.push([`mcp_servers.${server.name}.args`, server.args]);
    for (const [key, value] of Object.entries(server.env)) {
      entries.push([`mcp_servers.${server.name}.env.${key}`, value]);
    }
  }
  return entries.flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]);
}

/**
 * Trust level -> Codex CLI flags. Codex has no single mode flag equivalent to Claude Code's
 * --permission-mode, so this approximates our five shared TrustLevel values onto Codex's own
 * --sandbox / --ask-for-approval / --approve-for-me / --dangerously-bypass-approvals-and-sandbox
 * (see ARCHITECTURE.md#trust-levels). No native "plan" mode exists for Codex - the permission
 * catalog (core/permissionCatalog.ts) doesn't offer it for this provider, so that case here is
 * unreachable in practice, but falls back to the safest option rather than throwing.
 *
 * IMPORTANT: --ask-for-approval is a top-level flag, NOT accepted by `codex exec` itself
 * (confirmed via `codex exec --help`, which doesn't list it) - it must come BEFORE the `exec`
 * subcommand: `codex --ask-for-approval <policy> exec ...`. Verified empirically on this
 * machine.
 */
function flagsForTrustLevel(trustLevel: TrustLevel): { beforeExec: string[]; forExec: string[] } {
  switch (trustLevel) {
    case "bypassPermissions":
      return { beforeExec: [], forExec: ["--dangerously-bypass-approvals-and-sandbox"] };
    case "auto":
      return { beforeExec: [], forExec: ["--approve-for-me"] };
    case "acceptEdits":
      return { beforeExec: [], forExec: ["--sandbox", "workspace-write"] };
    case "manual":
      // Best-effort only: Codex has no external approval-decision hook analogous to Claude
      // Code's --permission-prompt-tool (confirmed against learn.chatgpt.com/docs/
      // agent-approvals-security), so this can't be a live UI popup - the CLI's own
      // internal approval routing decides.
      return { beforeExec: ["--ask-for-approval", "on-request"], forExec: ["--sandbox", "workspace-write"] };
    case "plan":
    default:
      return { beforeExec: [], forExec: ["--sandbox", "read-only"] };
  }
}

/**
 * Codex's `turn.completed` usage block, mapped onto TurnUsage.
 *
 * The shape is read verbatim off the shipped codex.exe, where `TurnCompletedEvent { usage }`
 * carries a `TokenUsage` struct whose field list is, in order:
 *
 *   input_tokens  cached_input_tokens  cache_write_input_tokens  output_tokens
 *   reasoning_output_tokens  total_tokens
 *
 * Four of those six were being thrown away. Two semantics matter and both are confirmed against
 * a real rollout record from this machine
 * (~/.codex/sessions/.../rollout-*.jsonl, `last_token_usage`):
 *
 *     input_tokens 137957, cached_input_tokens 137600, output_tokens 254,
 *     reasoning_output_tokens 34, total_tokens 138211
 *
 *   - 137957 + 254 = 138211 = total_tokens, so `cached_input_tokens` is INSIDE `input_tokens`
 *     (hence cacheCountedInInput: true) and `reasoning_output_tokens` is INSIDE `output_tokens`.
 *     Adding the cached figure to the input figure would have double-counted 137600 tokens.
 *   - `total_tokens` is Codex's own, and is passed straight through rather than recomputed.
 *
 * No cost: `codex exec --json` states no price anywhere, and a subscription turn has no
 * per-token dollar figure to state. Absent is the honest answer.
 */
export function codexUsage(raw: unknown): TurnUsage | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const u = raw as Record<string, unknown>;
  const usage: TurnUsage = {};
  put(usage, "inputTokens", num(u.input_tokens));
  put(usage, "outputTokens", num(u.output_tokens));
  put(usage, "cacheReadTokens", num(u.cached_input_tokens));
  put(usage, "cacheWriteTokens", num(u.cache_write_input_tokens));
  put(usage, "reasoningTokens", num(u.reasoning_output_tokens));
  put(usage, "totalTokens", num(u.total_tokens));
  if (usage.cacheReadTokens !== undefined || usage.cacheWriteTokens !== undefined) usage.cacheCountedInInput = true;
  if (usage.reasoningTokens !== undefined) usage.reasoningCountedInOutput = true;
  return isEmptyUsage(usage) ? undefined : usage;
}

export const codexCliAdapter: ProviderAdapter = {
  id: "codex-cli",
  async runTurn({ cwd, prompt, trustLevel, model, effort, agentId, account, turnToken, sessionId, onEvent, signal }: RunTurnOptions): Promise<void> {
    const { beforeExec, forExec } = flagsForTrustLevel(trustLevel);
    const serverPort = SERVER_PORT;
    // Resume this agent's own prior conversation so it remembers its own work across turns.
    // Deliberately NOT `--last`: that is scoped to the user's entire codex session store, so
    // with two codex agents configured it would silently resume the other one's conversation.
    // No captured id means we run cold rather than guess.
    const buildArgs = (configArgs: string[]) => [
      ...beforeExec,
      "exec",
      ...(sessionId ? ["resume", sessionId] : []),
      "--json",
      "--skip-git-repo-check",
      // -C/--cd is an option of `codex exec`, NOT of `codex exec resume` - passing it to the
      // resume subcommand makes codex reject the whole invocation with "unexpected argument
      // '-C' found", which silently broke every turn for any agent that had a stored session.
      // The child is already spawned with `cwd` below, so the working directory is correct
      // either way; this flag is belt-and-braces for the cold-start path only.
      ...(sessionId ? [] : ["-C", cwd]),
      ...forExec,
      ...(model ? ["-m", model] : []),
      // model_reasoning_effort is a TOML string value, hence the literal embedded quotes -
      // see the -c examples in `codex exec --help`.
      ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []),
      ...configArgs,
      prompt,
    ];

    /** Resolves true when the caller should re-run WITHOUT the (undocumented, inferred) solace
     * mcp config - i.e. codex exited non-zero having produced no stream output at all, which is
     * what rejecting an unknown `-c` key looks like from out here. In that case nothing is
     * reported to the agent: the fallback run is the real turn. Group-chat posting is a feature
     * on top of codex, never a reason for a codex turn to fail. */
    const runOnce = (configArgs: string[]) => new Promise<boolean>((resolve) => {
      const canFallBack = configArgs.length > 0;
      let sawStreamEvent = false;
      const child = spawnCli("codex", buildArgs(configArgs), {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          SOLACE_AGENT_ID: agentId,
          SOLACE_SERVER_PORT: String(SERVER_PORT),
          ...(turnToken ? { SOLACE_TURN_TOKEN: turnToken } : {}),
          // Empty unless this agent names an account, in which case it is CODEX_HOME pointing
          // at that account's own config directory - codex keeps its credentials in
          // <CODEX_HOME>/auth.json, so a directory per account is a login per account. Spread
          // LAST so an account the user chose in the UI beats a CODEX_HOME that happens to be
          // in the server's own environment, otherwise the setting would silently do nothing
          // on such a machine.
          ...accountEnv("codex-cli", account),
        },
      });
      const rl = readline.createInterface({ input: child.stdout! });

      let reportedError = false;
      let seenSessionId: string | undefined;
      let aborted = false;
      const onAbort = () => {
        aborted = true;
        // Not child.kill(): on Windows that leaves the real CLI (and the per-turn MCP bridge it
        // spawned) running against a turn we already gave up on. See killCliTree.
        killCliTree(child);
      };
      signal?.addEventListener("abort", onAbort);

      rl.on("line", (line) => {
        if (!line.trim()) return;
        // Any stdout line at all means codex accepted its arguments and actually started the
        // turn, so a later non-zero exit is a real failure of the turn - not the config
        // rejection the fallback below exists for. Set before parsing on purpose: a line we
        // couldn't parse is still proof codex ran.
        sawStreamEvent = true;
        try {
          const event = JSON.parse(line);
          // codex exec also emits {"type":"token_count", ... "rate_limits":{...}} several times
          // per turn; its rate_limits block is the source of Codex's own "you have X% left".
          // The first one of a turn often has a null primary window, which parses to null here.
          const rateLimit = parseCodexRateLimitEvent(event, new Date().toISOString());
          if (rateLimit) onEvent({ type: "rate-limit", rateLimit });
          // Codex does not document its JSONL event schema, and the field carrying the session
          // id is not published - so rather than hardcode a guess, take the first plausible id
          // we see from any of the shapes observed on disk and stop looking.
          if (!seenSessionId) {
            const candidate =
              event?.session_id ?? event?.thread_id ?? event?.session?.id ?? event?.item?.thread_id;
            if (typeof candidate === "string" && candidate) {
              seenSessionId = candidate;
              onEvent({ type: "session", sessionId: candidate });
            }
          }
          // Schema: {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
          // plus item types like command_execution/file_change/reasoning we surface as tool-use
          // ("error" items are non-fatal in-stream notices, e.g. truncated skill descriptions -
          // shown as a note, not a failure), and top-level {"type":"turn.failed", ...} for the
          // terminal failure of the whole turn - "turn.failed" always follows a top-level
          // {"type":"error"} with the same message, so only act on turn.failed to avoid
          // reporting the same failure twice.
          if (event.type === "item.completed" && event.item) {
            if (event.item.type === "agent_message" && event.item.text) {
              onEvent({ type: "text", text: event.item.text });
            } else if (event.item.type === "reasoning") {
              // Reported as its own item type, so it does not have to be guessed at downstream.
              // Codex spells the body `text` in some builds and `summary` in others; either way
              // an item with no body at all is dropped rather than shown as an empty bubble.
              const text = typeof event.item.text === "string" && event.item.text.trim()
                ? event.item.text
                : typeof event.item.summary === "string"
                  ? event.item.summary
                  : "";
              if (text.trim()) onEvent({ type: "reasoning", text });
            } else if (event.item.type === "error") {
              onEvent({ type: "tool-use", description: `note: ${event.item.message ?? "codex reported a notice"}` });
            } else {
              // The whole item is passed as `input`: a command_execution item carries the real
              // `command`, `exit_code` and `aggregated_output`, all of which were being thrown
              // away - every shell call in the hub read as the literal word "command_execution".
              onEvent({ type: "tool-use", description: event.item.type, toolName: event.item.type, input: event.item });
            }
          } else if (event.type === "turn.failed") {
            reportedError = true;
            onEvent({ type: "error", message: event.error?.message ?? "codex exec reported an error" });
          } else if (event.type === "turn.completed") {
            const usage = codexUsage(event.usage);
            if (usage) onEvent({ type: "usage", usage });
          }
        } catch {
          onEvent({ type: "text", text: line });
        }
      });

      // codex exec writes informational notices to stderr even on success, so don't treat
      // stderr output itself as failure - only fall back to it if the process exited non-zero
      // and nothing more specific was already reported from the JSONL stream above.
      let stderrBuffer = "";
      child.stderr!.on("data", (chunk) => {
        stderrBuffer += chunk.toString();
      });

      child.on("close", (code) => {
        // codex exec --json does not emit token_count on this build, so the usage meter had
        // nothing to show for Codex while working fine for Claude. The CLI writes the same
        // numbers to its session rollout file, keyed by the session id we already track - so
        // read the provider's own figure from disk rather than leaving the meter blank or,
        // worse, inventing one. Best-effort: a miss simply reports nothing.
        const sid = seenSessionId ?? sessionId;
        if (sid) {
          // Same CODEX_HOME the child ran under, so a named account's meter reads that
          // account's own rollout rather than the default login's.
          const fromDisk = readCodexRateLimitFromRollout(
            sid,
            new Date().toISOString(),
            accountEnv("codex-cli", account).CODEX_HOME,
          );
          if (fromDisk) onEvent({ type: "rate-limit", rateLimit: fromDisk });
        }
        signal?.removeEventListener("abort", onAbort);
        if (!aborted && code !== 0 && !sawStreamEvent && canFallBack) {
          // Codex died before producing a single line of its own stream, with an argument set
          // that includes an mcp_servers config form we inferred rather than read in any docs.
          // Re-run plainly instead of failing the turn, and report nothing from this attempt.
          resolve(true);
          return;
        }
        if (aborted) {
          // Why it was aborted is the caller's knowledge, not ours - see AdapterEvent.cancelled.
          onEvent({ type: "cancelled" });
        } else if (code !== 0 && !reportedError && stderrBuffer.trim()) {
          onEvent({ type: "error", message: stderrBuffer.trim() });
        }
        onEvent({ type: "done" });
        resolve(false);
      });

      child.on("error", (err) => {
        signal?.removeEventListener("abort", onAbort);
        // Deliberately NOT a fallback case: this is codex failing to spawn at all (not on
        // PATH, permissions), which dropping our own config args cannot fix.
        onEvent({ type: "error", message: `failed to start codex CLI: ${err.message}` });
        onEvent({ type: "done" });
        resolve(false);
      });
    });

    const needsPlainRetry = await runOnce(solaceMcpConfigArgs(agentId, serverPort, turnToken, mcpServersForAgent(agentId)));
    if (needsPlainRetry) await runOnce([]);
  },
};

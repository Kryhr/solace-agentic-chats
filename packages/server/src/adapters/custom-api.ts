import type { ProviderAdapter, RunTurnOptions } from "./types";
import { AGENT_TOOLS, createToolExecutor, toolsWireFormat, type ToolExecutor } from "../core/agentTools";

/**
 * One adapter for *any* OpenAI-compatible Chat Completions endpoint - Ollama, LM Studio,
 * llama.cpp and vLLM locally, DeepSeek, Groq, Mistral, Together, Fireworks, OpenRouter, xAI and
 * Cerebras remotely. They all implement the same wire format, so this is one adapter rather than
 * N bespoke ones. The only thing that varies is the base URL, which comes from the saved
 * credential (see core/credentials.ts) and is threaded in as RunTurnOptions.baseUrl.
 *
 * WHAT CHANGED AND WHY. This used to POST a single request carrying one user message and stream
 * the reply back, which meant a "local"/"custom" agent could hold a conversation and do nothing
 * else, while a claude-code or codex-cli agent in the same hub could read files, edit them and
 * run git. That asymmetry was the whole gap: the point of running an open model through Ollama
 * is to have it do real work on this machine, not to narrate what it would do.
 *
 * So this is now a real agentic loop. It sends a `tools` array, and when the model answers with
 * `tool_calls` it EXECUTES them locally (core/agentTools.ts), appends the results as
 * `role: "tool"` messages, and asks again - until the model stops asking for tools or the
 * iteration bound below is hit.
 *
 * The critical asymmetry with the CLI adapters, and the reason core/agentTools.ts is as
 * paranoid as it is: claude-code.ts hands a trust level to a CLI that already implements its own
 * sandbox and its own permission prompt. Here there is no CLI. This process IS the sandbox, so
 * the trust level is enforced by our executor immediately before each side effect, and
 * `manual` raises a card through the very same /internal/approvals route Claude Code's approval
 * bridge uses.
 *
 * Deliberately NO cost estimate. claude-api.ts/openai-api.ts can price a turn because their
 * provider publishes a price list we actually looked up; for an arbitrary user-supplied endpoint
 * we have no idea what a token costs - it might even be a free local server. Token counts are
 * reported only when the endpoint itself returns a `usage` object, and totalCostUsd is omitted
 * entirely rather than guessed.
 */

/**
 * Hard bound on tool round-trips in one turn.
 *
 * Every iteration is a full request to the endpoint, so an unbounded loop is an unbounded bill on
 * a hosted endpoint and an unbounded stream of filesystem writes on a local one. A model stuck
 * re-reading the same file is a real and common failure with smaller local models, and the outer
 * turn timeout in agentManager would eventually kill it - but only after burning the entire turn
 * budget silently. Hitting this bound is reported, never hidden.
 */
const MAX_TOOL_ITERATIONS = 16;

interface WireToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface AssistantTurn {
  content: string;
  toolCalls: WireToolCall[];
  finishReason?: string;
}

/** Test seam. Production passes neither. */
export interface CustomApiDeps {
  fetchImpl?: typeof fetch;
  /** Overrides the executor built from cwd/trustLevel. Tests use it; nothing else should. */
  executor?: ToolExecutor;
}

function systemPrompt(options: RunTurnOptions): string {
  const toolNames = AGENT_TOOLS.map((t) => t.name).join(", ");
  // Everything stated here is a fact the executor actually enforces. The permission mode is
  // included so the model can plan around a refusal instead of discovering it six calls in -
  // but it is NOT how the mode is enforced. A prompt is guidance; core/agentTools.ts's gate is
  // the control, and it re-checks every single call regardless of what this text says.
  const modeNote =
    options.trustLevel === "plan"
      ? "You are in PLAN mode: read-only. write_file, edit_file and run_shell_command will be refused. Investigate and propose; do not attempt to act."
      : options.trustLevel === "manual"
        ? "You are in MANUAL mode: every file write and every command needs the user to click Allow first, which may take a moment or be denied."
        : options.trustLevel === "acceptEdits"
          ? "You are in ACCEPT-EDITS mode: file writes go through automatically, but every command needs the user to click Allow first."
          : "You may write files and run commands without asking for confirmation.";

  return [
    `You are ${options.agentHandle}, a software agent working on a real computer.`,
    `Your working directory is ${options.cwd} and the platform is ${process.platform}.`,
    `You have these tools: ${toolNames}. They really run - read_file really reads the disk and run_shell_command really executes.`,
    "Use git through run_shell_command; there is no separate git tool.",
    "Every path you touch must be inside your working directory; anything outside it is refused.",
    modeNote,
    "Never claim to have read, written or run something unless a tool result in this conversation shows it. If a tool is refused, say so plainly instead of pretending it succeeded.",
  ].join("\n");
}

export async function runCustomApiTurn(options: RunTurnOptions & CustomApiDeps): Promise<void> {
  const { prompt, model, apiKey, baseUrl, onEvent, signal } = options;
  const doFetch = options.fetchImpl ?? fetch;

  // No key check. A local server (Ollama, llama.cpp, LM Studio, ...) genuinely has no key to
  // configure, and bailing before the request made every one of them unreachable. The base URL
  // below is the requirement instead: without it there's nothing to call at all.
  if (!baseUrl) {
    onEvent({
      type: "error",
      message: "this connection has no base URL saved - re-add it under Connections with the provider's API base URL",
    });
    onEvent({ type: "done" });
    return;
  }
  if (!model) {
    // Unlike the first-party adapters there's no sane default model to fall back to: every
    // endpoint names its models differently, and guessing one just produces a 404 the user
    // can't interpret.
    onEvent({ type: "error", message: "set a model id on this agent - custom endpoints have no default model" });
    onEvent({ type: "done" });
    return;
  }

  const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const executor =
    options.executor ??
    createToolExecutor({
      cwd: options.cwd,
      trustLevel: options.trustLevel,
      agentId: options.agentId,
      turnToken: options.turnToken,
      signal,
      ownerOfPath: options.ownerOfPath,
    });

  const messages: Record<string, unknown>[] = [
    { role: "system", content: systemPrompt(options) },
    { role: "user", content: prompt },
  ];

  let inputTokens = 0;
  let outputTokens = 0;
  let sawUsage = false;
  /** Flipped off only when the endpoint itself rejects the `tools` parameter. */
  let toolsEnabled = true;
  let anyToolCalled = false;

  const emitUsage = () => {
    // Not every OpenAI-compatible endpoint honours stream_options.include_usage. If none came
    // back, say nothing at all rather than reporting a fabricated zero-token turn.
    if (sawUsage) onEvent({ type: "usage", usage: { inputTokens, outputTokens } });
  };

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
    if (signal?.aborted) {
      onEvent({ type: "cancelled" });
      emitUsage();
      onEvent({ type: "done" });
      return;
    }

    let response: Response;
    try {
      response = await doFetch(endpoint, {
        method: "POST",
        // Only send the auth header when there's actually a key. Sending `Bearer undefined` to a
        // keyless local server is not harmless - llama.cpp's server rejects a malformed
        // Authorization header outright rather than ignoring it.
        headers: apiKey
          ? { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" }
          : { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          stream: true,
          stream_options: { include_usage: true },
          messages,
          ...(toolsEnabled ? { tools: toolsWireFormat(), tool_choice: "auto" } : {}),
        }),
        signal,
      });
    } catch (err) {
      // An aborted fetch rejects rather than returning; that is a cancellation we caused, not a
      // failure of the endpoint, and must not be reported as an error (see AdapterEvent).
      if (signal?.aborted || (err as Error).name === "AbortError") {
        onEvent({ type: "cancelled" });
        emitUsage();
        onEvent({ type: "done" });
        return;
      }
      onEvent({ type: "error", message: `failed to reach ${endpoint}: ${(err as Error).message}` });
      emitUsage();
      onEvent({ type: "done" });
      return;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      // THE "this model can't do tools" PATH.
      //
      // Tool calling depends on the model AND on the server's chat template, and a great many
      // local GGUFs simply have no template for it. Ollama answers `"<model> does not support
      // tools"`, llama.cpp and vLLM return their own variants, and hosted gateways return a 400
      // naming the unsupported parameter. What they have in common is that the FIRST request -
      // the one that introduced `tools` - fails, and the same request without `tools` succeeds.
      //
      // So: retry once without tools, and SAY SO. The alternative that was explicitly not built
      // is a silent downgrade, where the agent quietly becomes a chatbot and spends the rest of
      // the turn describing edits it never made. A visible note costs one line and is the
      // difference between a limitation and a lie.
      if (toolsEnabled && looksLikeToolRejection(response.status, body)) {
        toolsEnabled = false;
        onEvent({
          type: "tool-use",
          description:
            `note: this endpoint rejected the tool definitions (HTTP ${response.status}: ${body.slice(0, 200).trim()}). ` +
            `"${model}" cannot use tools here, so this turn is conversation-only - it cannot read, write or run anything. ` +
            `Pick a tool-capable model on this endpoint if you need it to do real work.`,
        });
        // Re-send the identical messages without `tools`. The decrement gives that retry back
        // its iteration; it cannot loop, because toolsEnabled is now false and this branch is
        // unreachable for the rest of the turn.
        iteration -= 1;
        continue;
      }
      onEvent({ type: "error", message: `API error from ${endpoint} (${response.status}): ${body.slice(0, 300)}` });
      emitUsage();
      onEvent({ type: "done" });
      return;
    }

    let turn: AssistantTurn;
    try {
      turn = await readAssistantTurn(response, onEvent, (usage) => {
        sawUsage = true;
        // Summed, not overwritten: a multi-iteration turn made several billed requests and
        // reporting only the last one's numbers would understate the turn by most of its cost.
        inputTokens += usage.input;
        outputTokens += usage.output;
      });
    } catch (err) {
      if (signal?.aborted || (err as Error).name === "AbortError") {
        onEvent({ type: "cancelled" });
        emitUsage();
        onEvent({ type: "done" });
        return;
      }
      onEvent({ type: "error", message: `failed reading the response stream from ${endpoint}: ${(err as Error).message}` });
      emitUsage();
      onEvent({ type: "done" });
      return;
    }

    if (!turn.toolCalls.length) {
      // No tool calls: this is the model's final answer for the turn. Text has already been
      // streamed out as it arrived.
      emitUsage();
      onEvent({ type: "done" });
      return;
    }

    anyToolCalled = true;
    // The assistant message must be echoed back verbatim-shaped, tool_calls included: the next
    // request is rejected by every strict endpoint if a `role: "tool"` message does not follow
    // an assistant message that actually requested that tool_call_id.
    messages.push({
      role: "assistant",
      content: turn.content || null,
      tool_calls: turn.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    });

    for (const call of turn.toolCalls) {
      if (signal?.aborted) {
        onEvent({ type: "cancelled" });
        emitUsage();
        onEvent({ type: "done" });
        return;
      }
      const parsedArgs = safeParseArgs(call.arguments);
      // Emitted BEFORE the tool runs, with the provider's real tool name and real arguments, so
      // core/toolLabel.ts derives the label from the actual values and the activity row appears
      // while a long command is still running rather than only after it finishes. The names in
      // AGENT_TOOLS were chosen to already exist in that table, so these render exactly like a
      // CLI provider's calls with no special-casing downstream.
      onEvent({
        type: "tool-use",
        description: `${call.name}(${call.arguments || "{}"})`,
        toolName: call.name,
        input: parsedArgs,
      });

      const result = await executor.execute(call.name, call.arguments);

      if (call.name === "run_shell_command") {
        // A second row carrying the real output and exit code, in the same argument shape Codex
        // reports (`aggregated_output` / `exit_code`), so the disclosure shows what the command
        // actually printed. Only for commands: every other tool's result is either trivial or
        // already the file the model asked for.
        onEvent({
          type: "tool-use",
          description: `${call.name} finished`,
          toolName: call.name,
          input: { ...parsedArgs, aggregated_output: result.content, exit_code: result.exitCode },
        });
      }

      messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content: result.content });
    }
  }

  // Fell out of the loop still asking for tools.
  onEvent({
    type: "tool-use",
    description:
      `note: stopped after ${MAX_TOOL_ITERATIONS} tool rounds without the model reaching an answer. ` +
      `Anything it already did is done; nothing further was run. Send another message to continue.`,
  });
  if (!anyToolCalled) {
    // Unreachable in practice (no tool calls exits above), but if it ever happens the honest
    // thing is to say the turn produced nothing rather than let it end silently.
    onEvent({ type: "error", message: "the model produced no answer and made no tool calls" });
  }
  emitUsage();
  onEvent({ type: "done" });
}

/**
 * True when an HTTP failure is specifically "I don't do tools", as opposed to a bad key, a
 * missing model or a server that is down.
 *
 * Deliberately narrow, and gated on a 4xx: a false positive here would silently strip the tools
 * from a perfectly capable endpoint over an unrelated 500 and turn a working agent into a
 * chatbot. A false negative just surfaces the raw error, which is recoverable.
 */
export function looksLikeToolRejection(status: number, body: string): boolean {
  if (status < 400 || status >= 500) return false;
  const text = body.toLowerCase();
  return (
    /does not support tools/.test(text) ||
    /doesn'?t support tools/.test(text) ||
    /tools are not supported/.test(text) ||
    /tool (calling|use|choice) is not supported/.test(text) ||
    /(unsupported|unrecognized|unknown|invalid|unexpected)[^.]{0,40}\b(tools|tool_choice|tool_calls)\b/.test(text) ||
    /\b(tools|tool_choice)\b[^.]{0,40}(not supported|unsupported|not allowed)/.test(text)
  );
}

/**
 * Read one assistant response - streamed SSE, or a plain JSON body for a server that ignored
 * `stream: true` (several local runtimes do exactly that, and the old code showed the user
 * nothing at all when it happened).
 */
async function readAssistantTurn(
  response: Response,
  onEvent: RunTurnOptions["onEvent"],
  onUsage: (usage: { input: number; output: number }) => void,
): Promise<AssistantTurn> {
  const contentType = response.headers?.get?.("content-type") ?? "";
  if (!response.body || (contentType.includes("application/json") && !contentType.includes("event-stream"))) {
    const payload = (await response.json()) as any;
    const message = payload?.choices?.[0]?.message ?? {};
    const content = typeof message.content === "string" ? message.content : "";
    if (content.trim()) onEvent({ type: "text", text: content });
    if (payload?.usage) {
      onUsage({ input: payload.usage.prompt_tokens ?? 0, output: payload.usage.completion_tokens ?? 0 });
    }
    return {
      content,
      toolCalls: normaliseToolCalls(message.tool_calls),
      finishReason: payload?.choices?.[0]?.finish_reason,
    };
  }

  let content = "";
  let finishReason: string | undefined;
  // Keyed by the `index` the server sends, because tool-call arguments arrive as a stream of
  // fragments that must be concatenated per call - and a model asking for three files at once
  // interleaves all three. Keying by array position instead loses calls whenever a server emits
  // them out of order.
  const partial = new Map<number, WireToolCall>();

  let buffer = "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        // Exact-match the terminator, not a substring check - a real content delta can
        // legitimately contain the literal text "[DONE]" (quoted docs, logs, code), and
        // `.includes` was silently dropping that whole chunk instead of only the sentinel.
        if (!line.startsWith("data: ")) continue;
        if (line.trim() === "data: [DONE]") continue;
        let event: any;
        try {
          event = JSON.parse(line.slice(6));
        } catch {
          continue; // ignore malformed SSE chunks rather than aborting the whole stream
        }
        const choice = event.choices?.[0];
        const delta = choice?.delta;
        if (typeof delta?.content === "string" && delta.content) {
          content += delta.content;
          onEvent({ type: "text", text: delta.content });
        }
        // Several endpoints (DeepSeek's reasoner, some vLLM builds) stream chain-of-thought on a
        // separate field. It is the model's thinking, not its answer, and types.ts is explicit
        // that nothing downstream may infer that from the shape of the words.
        if (typeof delta?.reasoning_content === "string" && delta.reasoning_content) {
          onEvent({ type: "reasoning", text: delta.reasoning_content });
        }
        if (Array.isArray(delta?.tool_calls)) {
          for (const fragment of delta.tool_calls) {
            const index = typeof fragment.index === "number" ? fragment.index : 0;
            const existing = partial.get(index) ?? { id: "", name: "", arguments: "" };
            if (fragment.id) existing.id = fragment.id;
            if (fragment.function?.name) existing.name += fragment.function.name;
            if (typeof fragment.function?.arguments === "string") existing.arguments += fragment.function.arguments;
            partial.set(index, existing);
          }
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (event.usage) {
          onUsage({ input: event.usage.prompt_tokens ?? 0, output: event.usage.completion_tokens ?? 0 });
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const toolCalls = [...partial.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, call]) => ({
      // A server that streams a tool call without ever sending an id still needs one, because
      // the `role: "tool"` reply has to reference it. Synthesised ids are only ever used to pair
      // OUR request with OUR result inside this loop - nothing is claimed about their origin.
      id: call.id || `call_${index}`,
      name: call.name,
      arguments: call.arguments,
    }))
    .filter((call) => call.name);

  return { content, toolCalls, finishReason };
}

function normaliseToolCalls(raw: unknown): WireToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: WireToolCall[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const call = raw[i] as any;
    const name = call?.function?.name;
    if (typeof name !== "string" || !name) continue;
    const args = call?.function?.arguments;
    out.push({
      id: typeof call.id === "string" && call.id ? call.id : `call_${i}`,
      name,
      // Some servers hand back an already-parsed object here instead of the JSON string the
      // spec calls for. Re-stringify so the executor has one shape to parse.
      arguments: typeof args === "string" ? args : args ? JSON.stringify(args) : "{}",
    });
  }
  return out;
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = raw && raw.trim() ? JSON.parse(raw) : {};
    // A model can legally send `"[1,2]"` or `"null"` as its arguments string. toolLabel and the
    // shell result-merge below both index into this as an object, so anything that isn't a plain
    // object is carried through under `raw` rather than spread into something it isn't.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { raw };
    return parsed as Record<string, unknown>;
  } catch {
    // The raw string is passed through rather than dropped: toolLabel falls back to the tool
    // name, and the disclosure still shows exactly what the model sent, malformed or not.
    return { raw };
  }
}

export const customApiAdapter: ProviderAdapter = {
  id: "custom",
  runTurn: (options: RunTurnOptions) => runCustomApiTurn(options),
};

import type { TurnUsage } from "@solace/shared";
import { isEmptyUsage, num, put } from "../core/usage";
import type { ProviderAdapter, RunTurnOptions } from "./types";

// Anthropic Messages API pricing, USD per million tokens - sourced from anthropic.com/pricing
// on 2026-09-15. These are list prices for direct API billing and WILL drift over time; this
// is exactly why we never show a $ figure for CLI/subscription agents (see agentManager.ts) -
// only here, where the user is genuinely paying per-token on their own key.
const PRICING_PER_MILLION: Record<string, { input: number; output: number }> = {
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-opus-5": { input: 15, output: 75 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
};

function estimateCost(model: string, inputTokens: number, outputTokens: number): number | undefined {
  const rate = PRICING_PER_MILLION[model];
  if (!rate) return undefined;
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}

export const claudeApiAdapter: ProviderAdapter = {
  id: "claude-code",
  async runTurn({ prompt, model, apiKey, onEvent, signal }: RunTurnOptions): Promise<void> {
    if (!apiKey) {
      onEvent({ type: "error", message: "no API key configured for this agent" });
      onEvent({ type: "done" });
      return;
    }
    const resolvedModel = model || "claude-sonnet-5";

    let response: Response;
    try {
      response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: resolvedModel,
          max_tokens: 8192,
          stream: true,
          messages: [{ role: "user", content: prompt }],
        }),
        signal,
      });
    } catch (err) {
      onEvent({ type: "error", message: `failed to reach Anthropic API: ${(err as Error).message}` });
      onEvent({ type: "done" });
      return;
    }

    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => "");
      onEvent({ type: "error", message: `Anthropic API error (${response.status}): ${body.slice(0, 300)}` });
      onEvent({ type: "done" });
      return;
    }

    // Absent until the API says otherwise: a stream that died before message_start must not
    // report "0 tokens in", which is a claim rather than an admission.
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let cacheReadTokens: number | undefined;
    let cacheWriteTokens: number | undefined;
    let buffer = "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
              onEvent({ type: "text", text: event.delta.text });
            } else if (event.type === "message_start") {
              // Anthropic reports the three prompt buckets separately, and on a cached request
              // cache_read_input_tokens is most of the prompt - keeping only input_tokens here
              // understated the prompt exactly the way it did for the Claude Code CLI.
              const u = event.message?.usage;
              inputTokens = num(u?.input_tokens) ?? inputTokens;
              cacheReadTokens = num(u?.cache_read_input_tokens) ?? cacheReadTokens;
              cacheWriteTokens = num(u?.cache_creation_input_tokens) ?? cacheWriteTokens;
            } else if (event.type === "message_delta") {
              outputTokens = num(event.usage?.output_tokens) ?? outputTokens;
            } else if (event.type === "error") {
              onEvent({ type: "error", message: event.error?.message ?? "Anthropic API reported an error" });
            }
          } catch {
            // ignore malformed SSE chunks rather than aborting the whole stream
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const usage: TurnUsage = {};
    put(usage, "inputTokens", inputTokens);
    put(usage, "outputTokens", outputTokens);
    put(usage, "cacheReadTokens", cacheReadTokens);
    put(usage, "cacheWriteTokens", cacheWriteTokens);
    if (usage.cacheReadTokens !== undefined || usage.cacheWriteTokens !== undefined) usage.cacheCountedInInput = false;
    // estimatedCostUsd, not totalCostUsd: this figure is multiplied out of a price table in this
    // file, and the Anthropic API states no price on the stream. Keeping the two apart is what
    // lets the UI say "estimated" where it is estimated - see TurnUsage.
    put(usage, "estimatedCostUsd", estimateCost(resolvedModel, inputTokens ?? 0, outputTokens ?? 0));
    if (!isEmptyUsage(usage)) onEvent({ type: "usage", usage });
    onEvent({ type: "done" });
  },
};

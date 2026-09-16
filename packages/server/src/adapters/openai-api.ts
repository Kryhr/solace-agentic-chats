import type { TurnUsage } from "@solace/shared";
import { isEmptyUsage, num, put } from "../core/usage";
import type { ProviderAdapter, RunTurnOptions } from "./types";

// OpenAI pricing, USD per million tokens - sourced from openai.com/api/pricing on 2026-09-15.
// Same caveat as claude-api.ts: list prices drift, this is direct-API-key billing only.
const PRICING_PER_MILLION: Record<string, { input: number; output: number }> = {
  "gpt-5.1-codex": { input: 5, output: 15 },
  "gpt-5.1-codex-mini": { input: 1.5, output: 6 },
  o3: { input: 10, output: 40 },
};

function estimateCost(model: string, inputTokens: number, outputTokens: number): number | undefined {
  const rate = PRICING_PER_MILLION[model];
  if (!rate) return undefined;
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}

export const openaiApiAdapter: ProviderAdapter = {
  id: "codex-cli",
  async runTurn({ prompt, model, apiKey, onEvent, signal }: RunTurnOptions): Promise<void> {
    if (!apiKey) {
      onEvent({ type: "error", message: "no API key configured for this agent" });
      onEvent({ type: "done" });
      return;
    }
    const resolvedModel = model || "gpt-5.1-codex";

    let response: Response;
    try {
      response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: resolvedModel,
          stream: true,
          stream_options: { include_usage: true },
          messages: [{ role: "user", content: prompt }],
        }),
        signal,
      });
    } catch (err) {
      onEvent({ type: "error", message: `failed to reach OpenAI API: ${(err as Error).message}` });
      onEvent({ type: "done" });
      return;
    }

    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => "");
      onEvent({ type: "error", message: `OpenAI API error (${response.status}): ${body.slice(0, 300)}` });
      onEvent({ type: "done" });
      return;
    }

    // Absent, not 0: `stream_options.include_usage` is not honoured by every deployment, and
    // "the endpoint never said" must not render as "this turn cost nothing".
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let cacheReadTokens: number | undefined;
    let reasoningTokens: number | undefined;
    let totalTokens: number | undefined;
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
          // Exact-match the terminator, not a substring check - a real content delta can
          // legitimately contain the literal text "[DONE]" (quoted docs, logs, code), and
          // `.includes` was silently dropping that whole chunk instead of only the sentinel.
          if (!line.startsWith("data: ")) continue;
          if (line.trim() === "data: [DONE]") continue;
          try {
            const event = JSON.parse(line.slice(6));
            const delta = event.choices?.[0]?.delta?.content;
            if (delta) onEvent({ type: "text", text: delta });
            if (event.usage) {
              // OpenAI itemises cached prompt tokens and reasoning tokens in the two *_details
              // sub-objects; both are breakdowns of the headline figures, not extra tokens.
              const u = event.usage;
              inputTokens = num(u.prompt_tokens) ?? inputTokens;
              outputTokens = num(u.completion_tokens) ?? outputTokens;
              totalTokens = num(u.total_tokens) ?? totalTokens;
              cacheReadTokens = num(u.prompt_tokens_details?.cached_tokens) ?? cacheReadTokens;
              reasoningTokens = num(u.completion_tokens_details?.reasoning_tokens) ?? reasoningTokens;
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
    put(usage, "reasoningTokens", reasoningTokens);
    put(usage, "totalTokens", totalTokens);
    if (usage.cacheReadTokens !== undefined) usage.cacheCountedInInput = true;
    if (usage.reasoningTokens !== undefined) usage.reasoningCountedInOutput = true;
    // estimatedCostUsd, not totalCostUsd - the price table lives in this file, not in the API's
    // response. See the same note in claude-api.ts and the TurnUsage doc comment.
    put(usage, "estimatedCostUsd", estimateCost(resolvedModel, inputTokens ?? 0, outputTokens ?? 0));
    if (!isEmptyUsage(usage)) onEvent({ type: "usage", usage });
    onEvent({ type: "done" });
  },
};

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

    let inputTokens = 0;
    let outputTokens = 0;
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
          if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
          try {
            const event = JSON.parse(line.slice(6));
            const delta = event.choices?.[0]?.delta?.content;
            if (delta) onEvent({ type: "text", text: delta });
            if (event.usage) {
              inputTokens = event.usage.prompt_tokens ?? inputTokens;
              outputTokens = event.usage.completion_tokens ?? outputTokens;
            }
          } catch {
            // ignore malformed SSE chunks rather than aborting the whole stream
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    onEvent({
      type: "usage",
      usage: { inputTokens, outputTokens, totalCostUsd: estimateCost(resolvedModel, inputTokens, outputTokens) },
    });
    onEvent({ type: "done" });
  },
};

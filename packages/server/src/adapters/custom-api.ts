import type { ProviderAdapter, RunTurnOptions } from "./types";

/**
 * One adapter for *any* OpenAI-compatible Chat Completions endpoint - DeepSeek, Groq, Mistral,
 * Together, Fireworks, OpenRouter, xAI, Cerebras and most others all implement the same wire
 * format, so this is one adapter rather than N bespoke ones. The only thing that varies is the
 * base URL, which comes from the saved credential (see core/credentials.ts) and is threaded in
 * as RunTurnOptions.baseUrl.
 *
 * Deliberately NO cost estimate. claude-api.ts/openai-api.ts can price a turn because their
 * provider publishes a price list we actually looked up; for an arbitrary user-supplied
 * endpoint we have no idea what a token costs - it might even be a free local server. Token
 * counts are reported only when the endpoint itself returns a `usage` object, and totalCostUsd
 * is omitted entirely rather than guessed.
 */
export const customApiAdapter: ProviderAdapter = {
  id: "custom",
  async runTurn({ prompt, model, apiKey, baseUrl, onEvent, signal }: RunTurnOptions): Promise<void> {
    if (!apiKey) {
      onEvent({ type: "error", message: "no API key configured for this agent" });
      onEvent({ type: "done" });
      return;
    }
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

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          stream: true,
          stream_options: { include_usage: true },
          messages: [{ role: "user", content: prompt }],
        }),
        signal,
      });
    } catch (err) {
      onEvent({ type: "error", message: `failed to reach ${endpoint}: ${(err as Error).message}` });
      onEvent({ type: "done" });
      return;
    }

    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => "");
      onEvent({ type: "error", message: `API error from ${endpoint} (${response.status}): ${body.slice(0, 300)}` });
      onEvent({ type: "done" });
      return;
    }

    let inputTokens = 0;
    let outputTokens = 0;
    let sawUsage = false;
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
              sawUsage = true;
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

    // Not every OpenAI-compatible endpoint honours stream_options.include_usage. If none came
    // back, say nothing at all rather than reporting a fabricated zero-token turn.
    if (sawUsage) onEvent({ type: "usage", usage: { inputTokens, outputTokens } });
    onEvent({ type: "done" });
  },
};

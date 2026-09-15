import type { ProviderId } from "@solace/shared";
import type { ProviderAdapter } from "./types";
import { claudeCodeAdapter } from "./claude-code";
import { codexCliAdapter } from "./codex-cli";
import { claudeApiAdapter } from "./claude-api";
import { openaiApiAdapter } from "./openai-api";
import { customApiAdapter } from "./custom-api";
import { geminiCliAdapter } from "./gemini-cli";
import { qwenCodeAdapter } from "./qwen-code";

const cliAdapters: Record<Exclude<ProviderId, "custom">, ProviderAdapter> = {
  "claude-code": claudeCodeAdapter,
  "codex-cli": codexCliAdapter,
  "gemini-cli": geminiCliAdapter,
  "qwen-code": qwenCodeAdapter,
};

// Only claude-code and codex-cli have a direct-API-key alternative today. Gemini and Qwen have
// real CLI adapters now, but no API-key variant has been built or verified for either, and
// offering one that has never been run would be claiming support this app doesn't have.
const apiAdapters: Partial<Record<Exclude<ProviderId, "custom">, ProviderAdapter>> = {
  "claude-code": claudeApiAdapter,
  "codex-cli": openaiApiAdapter,
};

export function getAdapter(provider: ProviderId, authMode: "cli" | "api-key" = "cli"): ProviderAdapter {
  // "custom" is any OpenAI-compatible endpoint the user saved a connection for (DeepSeek,
  // Groq, ...). There's no CLI to shell out to for those - an API key is the only way in.
  if (provider === "custom") {
    if (authMode !== "api-key") throw new Error("custom endpoints only support API-key auth");
    return customApiAdapter;
  }
  if (authMode === "api-key") {
    const adapter = apiAdapters[provider];
    if (!adapter) throw new Error(`${provider} has no API-key adapter yet`);
    return adapter;
  }
  return cliAdapters[provider];
}

export type { ProviderAdapter, AdapterEvent, RunTurnOptions } from "./types";

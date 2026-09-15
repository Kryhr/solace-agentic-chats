import type { CliProviderId, ProviderId } from "@solace/shared";
import type { ProviderAdapter } from "./types";
import { claudeCodeAdapter } from "./claude-code";
import { codexCliAdapter } from "./codex-cli";
import { claudeApiAdapter } from "./claude-api";
import { openaiApiAdapter } from "./openai-api";
import { customApiAdapter } from "./custom-api";
import { geminiCliAdapter, qwenCodeAdapter } from "./stubs";

const cliAdapters: Record<CliProviderId, ProviderAdapter> = {
  "claude-code": claudeCodeAdapter,
  "codex-cli": codexCliAdapter,
  "gemini-cli": geminiCliAdapter,
  "qwen-code": qwenCodeAdapter,
};

// Only claude-code and codex-cli have a direct-API-key alternative today - gemini/qwen's CLI
// adapters aren't even implemented yet, so there's no API variant to offer for them either.
const apiAdapters: Partial<Record<CliProviderId, ProviderAdapter>> = {
  "claude-code": claudeApiAdapter,
  "codex-cli": openaiApiAdapter,
};

export function getAdapter(provider: ProviderId, authMode: "cli" | "api-key" = "cli"): ProviderAdapter {
  // "custom" is any hosted OpenAI-compatible endpoint the user saved a connection for
  // (DeepSeek, Groq, ...); "local" is one running on this machine (Ollama, llama.cpp, ...).
  // Same wire format, so the same adapter - they're separate ids because everything *around*
  // the request differs (a local one is keyless and can be positively detected, a hosted one
  // is neither). Neither has a CLI to shell out to, so the saved connection is the only way in.
  if (provider === "custom" || provider === "local") {
    if (authMode !== "api-key") throw new Error(`${provider} endpoints only support saved-connection auth`);
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

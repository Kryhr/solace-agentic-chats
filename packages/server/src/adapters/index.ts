import type { CliProviderId, ProviderId } from "@solace/shared";
import type { ProviderAdapter } from "./types";
import { claudeCodeAdapter } from "./claude-code";
import { codexCliAdapter } from "./codex-cli";
import { claudeApiAdapter } from "./claude-api";
import { openaiApiAdapter } from "./openai-api";
import { customApiAdapter } from "./custom-api";
import { geminiCliAdapter } from "./gemini-cli";
import { qwenCodeAdapter } from "./qwen-code";
import { copilotCliAdapter } from "./copilot-cli";

const cliAdapters: Record<CliProviderId, ProviderAdapter> = {
  "claude-code": claudeCodeAdapter,
  "codex-cli": codexCliAdapter,
  "gemini-cli": geminiCliAdapter,
  "qwen-code": qwenCodeAdapter,
  "copilot-cli": copilotCliAdapter,
};

// Only claude-code and codex-cli have a direct-API-key alternative today. Gemini and Qwen have
// real CLI adapters now, but no API-key variant has been built or verified for either, and
// offering one that has never been run would be claiming support this app doesn't have.
// Keyed by CliProviderId, which already excludes both endpoint-backed ids ("custom", "local") -
// those have no CLI to shell out to and reach customApiAdapter directly in getAdapter().
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

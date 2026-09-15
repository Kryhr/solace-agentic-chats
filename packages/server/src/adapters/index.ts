import type { ProviderId } from "@solace/shared";
import type { ProviderAdapter } from "./types";
import { claudeCodeAdapter } from "./claude-code";
import { codexCliAdapter } from "./codex-cli";
import { claudeApiAdapter } from "./claude-api";
import { openaiApiAdapter } from "./openai-api";
import { geminiCliAdapter, qwenCodeAdapter } from "./stubs";

const cliAdapters: Record<Exclude<ProviderId, "custom">, ProviderAdapter> = {
  "claude-code": claudeCodeAdapter,
  "codex-cli": codexCliAdapter,
  "gemini-cli": geminiCliAdapter,
  "qwen-code": qwenCodeAdapter,
};

// Only claude-code and codex-cli have a direct-API-key alternative today - gemini/qwen's CLI
// adapters aren't even implemented yet, so there's no API variant to offer for them either.
const apiAdapters: Partial<Record<Exclude<ProviderId, "custom">, ProviderAdapter>> = {
  "claude-code": claudeApiAdapter,
  "codex-cli": openaiApiAdapter,
};

export function getAdapter(provider: ProviderId, authMode: "cli" | "api-key" = "cli"): ProviderAdapter {
  if (provider === "custom") {
    throw new Error("custom provider adapters are not supported yet");
  }
  if (authMode === "api-key") {
    const adapter = apiAdapters[provider];
    if (!adapter) throw new Error(`${provider} has no API-key adapter yet`);
    return adapter;
  }
  return cliAdapters[provider];
}

export type { ProviderAdapter, AdapterEvent, RunTurnOptions } from "./types";

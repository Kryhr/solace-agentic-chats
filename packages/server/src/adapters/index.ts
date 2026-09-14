import type { ProviderId } from "@solace/shared";
import type { ProviderAdapter } from "./types";
import { claudeCodeAdapter } from "./claude-code";
import { codexCliAdapter } from "./codex-cli";
import { geminiCliAdapter, qwenCodeAdapter } from "./stubs";

const adapters: Record<Exclude<ProviderId, "custom">, ProviderAdapter> = {
  "claude-code": claudeCodeAdapter,
  "codex-cli": codexCliAdapter,
  "gemini-cli": geminiCliAdapter,
  "qwen-code": qwenCodeAdapter,
};

export function getAdapter(provider: ProviderId): ProviderAdapter {
  if (provider === "custom") {
    throw new Error("custom provider adapters are not supported yet");
  }
  return adapters[provider];
}

export type { ProviderAdapter, AdapterEvent, RunTurnOptions } from "./types";

/**
 * Quick-add tiles for well-known OpenAI-compatible Chat Completions endpoints. Purely a UI
 * convenience: it only pre-fills the name + base URL of the credential form, and anything not
 * listed here can still be added by hand via "+ Custom". The server knows nothing about this
 * list - it just stores whatever base URL it's given (see adapters/custom-api.ts).
 *
 * Base URLs verified against each provider's own OpenAI-compatibility docs on 2026-09-15.
 * They do drift; if a connection 404s, check the provider's docs and edit the base URL when
 * re-adding it.
 */
export interface CatalogProvider {
  name: string;
  /** API root; "/chat/completions" is appended to it server-side. */
  baseUrl: string;
  /** Where to get a key - shown under the tile so the form isn't a dead end. */
  keyHint: string;
}

export const PROVIDER_CATALOG: CatalogProvider[] = [
  { name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", keyHint: "platform.deepseek.com" },
  { name: "Groq", baseUrl: "https://api.groq.com/openai/v1", keyHint: "console.groq.com" },
  { name: "Mistral", baseUrl: "https://api.mistral.ai/v1", keyHint: "console.mistral.ai" },
  { name: "Together AI", baseUrl: "https://api.together.xyz/v1", keyHint: "api.together.ai/settings/api-keys" },
  { name: "Fireworks", baseUrl: "https://api.fireworks.ai/inference/v1", keyHint: "fireworks.ai/account/api-keys" },
  { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", keyHint: "openrouter.ai/keys" },
  { name: "Perplexity", baseUrl: "https://api.perplexity.ai", keyHint: "perplexity.ai/settings/api" },
  { name: "xAI (Grok)", baseUrl: "https://api.x.ai/v1", keyHint: "console.x.ai" },
  { name: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", keyHint: "cloud.cerebras.ai" },
  { name: "DeepInfra", baseUrl: "https://api.deepinfra.com/v1/openai", keyHint: "deepinfra.com/dash/api_keys" },
];

export function searchCatalog(query: string): CatalogProvider[] {
  const q = query.trim().toLowerCase();
  if (!q) return PROVIDER_CATALOG;
  return PROVIDER_CATALOG.filter((p) => p.name.toLowerCase().includes(q) || p.baseUrl.toLowerCase().includes(q));
}

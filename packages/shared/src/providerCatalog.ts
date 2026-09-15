/**
 * Quick-add tiles for well-known OpenAI-compatible Chat Completions endpoints, plus the
 * local runtimes that speak the same wire format. Purely a UI convenience: it pre-fills the
 * name + base URL of the credential form, and anything not listed here can still be added by
 * hand via "+ Custom". No server code branches on this list - it just stores whatever base
 * URL it's given (see adapters/custom-api.ts). It lives in @solace/shared only so its shape
 * can be unit-tested; nothing about it is authoritative to the server.
 *
 * Base URLs verified against each provider's own OpenAI-compatibility docs on 2026-09-15.
 * They do drift; if a connection 404s, check the provider's docs and edit the base URL when
 * re-adding it.
 */
export interface CatalogProvider {
  name: string;
  /** API root; "/chat/completions" is appended to it server-side. */
  baseUrl: string;
  /** Where to get a key - shown under the tile so the form isn't a dead end. Omitted for the
   * local runtimes, which normally need no key at all; the UI says so rather than showing a
   * blank hint that reads like a missing value. */
  keyHint?: string;
  /** True for a server running on this machine. Drives the "local" ProviderId on save, and
   * the tile's "no key needed" hint. */
  local?: boolean;
  /** For a local runtime: the id in server/core/localDiscovery.ts, so a tile the user picks
   * by hand and a server the scan found refer to the same thing. */
  runtime?: string;
}

export const PROVIDER_CATALOG: CatalogProvider[] = [
  // api-docs.deepseek.com states base_url `https://api.deepseek.com` with no /v1 suffix
  // (their docs note the /v1 form exists only for OpenAI-SDK compatibility and is unrelated
  // to model version). Current model ids there are deepseek-flash and deepseek-v4-pro.
  { name: "DeepSeek", baseUrl: "https://api.deepseek.com", keyHint: "platform.deepseek.com" },
  { name: "Groq", baseUrl: "https://api.groq.com/openai/v1", keyHint: "console.groq.com" },
  { name: "Mistral", baseUrl: "https://api.mistral.ai/v1", keyHint: "console.mistral.ai" },
  // docs.together.ai now documents api.together.ai; the old api.together.xyz host is no
  // longer the one their own OpenAI-compatibility guide tells you to use.
  { name: "Together AI", baseUrl: "https://api.together.ai/v1", keyHint: "api.together.ai/settings/api-keys" },
  { name: "Fireworks", baseUrl: "https://api.fireworks.ai/inference/v1", keyHint: "fireworks.ai/account/api-keys" },
  { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", keyHint: "openrouter.ai/keys" },
  // Perplexity's Sonar Chat Completions (the old https://api.perplexity.ai root) is
  // documented as supported only until 2026-09-27. Their Router API is the documented
  // OpenAI-compatible replacement and takes the same key.
  { name: "Perplexity", baseUrl: "https://api.perplexity.ai/router/v1", keyHint: "perplexity.ai/settings/api" },
  { name: "xAI (Grok)", baseUrl: "https://api.x.ai/v1", keyHint: "console.x.ai" },
  { name: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", keyHint: "cloud.cerebras.ai" },
  { name: "DeepInfra", baseUrl: "https://api.deepinfra.com/v1/openai", keyHint: "deepinfra.com/dash/api_keys" },
  // Moonshot's own Kimi docs show base_url https://api.moonshot.ai/v1 in every example; the
  // console has since moved to platform.kimi.ai, which is where the key comes from.
  { name: "Moonshot (Kimi)", baseUrl: "https://api.moonshot.ai/v1", keyHint: "platform.kimi.ai/console/api-keys" },

  // Local runtimes. 127.0.0.1 literally, never "localhost" - GPT4All binds IPv4 only and
  // would be missed when localhost resolves to ::1 first. Ports are each project's own
  // default; a user who moved one edits the base URL, same as any other connection.
  { name: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", local: true, runtime: "ollama" },
  { name: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1", local: true, runtime: "lmstudio" },
  { name: "Jan", baseUrl: "http://127.0.0.1:1337/v1", local: true, runtime: "jan" },
  { name: "KoboldCpp", baseUrl: "http://127.0.0.1:5001/v1", local: true, runtime: "koboldcpp" },
  { name: "GPT4All", baseUrl: "http://127.0.0.1:4891/v1", local: true, runtime: "gpt4all" },
  { name: "llama.cpp", baseUrl: "http://127.0.0.1:8080/v1", local: true, runtime: "llamacpp" },
  { name: "vLLM", baseUrl: "http://127.0.0.1:8000/v1", local: true, runtime: "vllm" },
  { name: "LocalAI", baseUrl: "http://127.0.0.1:8080/v1", local: true, runtime: "localai" },
];

export function searchCatalog(query: string): CatalogProvider[] {
  const q = query.trim().toLowerCase();
  if (!q) return PROVIDER_CATALOG;
  return PROVIDER_CATALOG.filter((p) => p.name.toLowerCase().includes(q) || p.baseUrl.toLowerCase().includes(q));
}

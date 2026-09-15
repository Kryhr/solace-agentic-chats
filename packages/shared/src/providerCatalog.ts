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
 *
 * The standing rule for this file: an entry that cannot be confirmed against the provider's
 * OWN current docs is left out, never guessed. Things deliberately NOT here as of 2026-09-15,
 * so nobody re-adds them from memory:
 *   - Anyscale Endpoints: the self-serve OpenAI-compatible product was sunset; no current
 *     public base URL on their own site.
 *   - Lambda Inference API: docs.lambda.ai now serves a redirect stub with no Inference API
 *     section, so nothing on Lambda's own site states a base URL any more.
 *   - Kluster AI: docs.kluster.ai redirects to a hostname that does not resolve.
 *   - Alibaba Model Studio (Qwen/DashScope): its international endpoint is now workspace-
 *     scoped (https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/...), which this
 *     catalog's flat "one base URL per tile" shape cannot express honestly.
 *   - Chutes and Avian: base URLs are documented, but neither documents where a key is
 *     actually issued, and a tile that sends the user nowhere is a dead end.
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

  // --- Added 2026-09-15, each confirmed against the provider's own docs on that date. ------

  // platform.claude.com/docs/en/api/openai-sdk documents base_url "https://api.anthropic.com/v1/"
  // for the OpenAI SDK. The trailing slash is dropped here because "/chat/completions" is
  // appended server-side; the resulting URL is the one the docs show.
  { name: "Anthropic (Claude)", baseUrl: "https://api.anthropic.com/v1", keyHint: "platform.claude.com/settings/keys" },
  { name: "OpenAI", baseUrl: "https://api.openai.com/v1", keyHint: "platform.openai.com/api-keys" },
  // ai.google.dev/gemini-api/docs/openai - Gemini's OpenAI-compatibility layer lives under
  // /v1beta/openai/, not at the API root.
  { name: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyHint: "aistudio.google.com/apikey" },
  // Nebius renamed AI Studio to Token Factory and moved the host with it; the old
  // api.studio.nebius.* form is not what their current docs hand you.
  { name: "Nebius Token Factory", baseUrl: "https://api.tokenfactory.nebius.com/v1", keyHint: "tokenfactory.nebius.com" },
  // docs.novita.ai/guides/llm-api - note there is no /v1 segment; the root really is /openai.
  { name: "Novita AI", baseUrl: "https://api.novita.ai/openai", keyHint: "novita.ai/settings/key-management" },
  { name: "Hyperbolic", baseUrl: "https://api.hyperbolic.xyz/v1", keyHint: "app.hyperbolic.ai" },
  { name: "SambaNova", baseUrl: "https://api.sambanova.ai/v1", keyHint: "cloud.sambanova.ai/apis" },
  // docs.baseten.co - the shared Model APIs endpoint, which is a different host from a
  // user's own dedicated deployment.
  { name: "Baseten", baseUrl: "https://inference.baseten.co/v1", keyHint: "app.baseten.co/settings/api_keys" },
  { name: "Featherless AI", baseUrl: "https://api.featherless.ai/v1", keyHint: "featherless.ai/account/api-keys" },
  { name: "Inference.net", baseUrl: "https://api.inference.net/v1", keyHint: "inference.net dashboard → API Keys" },
  { name: "Parasail", baseUrl: "https://api.parasail.io/v1", keyHint: "saas.parasail.io/keys" },
  // docs.venice.ai - the "/api" segment is part of the root, not a typo.
  { name: "Venice AI", baseUrl: "https://api.venice.ai/api/v1", keyHint: "venice.ai/settings/api" },
  // docs.z.ai/guides/develop/openai/python. Their GLM Coding Plan uses a *different* root
  // (/api/coding/paas/v4); this is the general one, which is the right default.
  { name: "Z.AI (GLM)", baseUrl: "https://api.z.ai/api/paas/v4", keyHint: "z.ai/manage-apikey/apikey-list" },
  { name: "GMI Cloud", baseUrl: "https://api.gmi-serving.com/v1", keyHint: "GMI Cloud console → Settings → API Keys" },

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

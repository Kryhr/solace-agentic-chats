import type { ModelDiscoveryResult } from "@solace/shared";

/**
 * Asks an OpenAI-compatible endpoint for its own model list (GET {baseUrl}/models).
 *
 * This is the honest counterpart to modelCatalog.ts: that file refuses to hardcode a model
 * list for anything whose catalog depends on the user's plan or install, and the reason it
 * had to refuse was that nothing here ever asked. An endpoint's /models response is the one
 * source that can't go stale - it's what that endpoint will actually accept, right now.
 *
 * Cached in memory only, briefly, so opening Add Agent doesn't re-hit a paid endpoint on
 * every keystroke. Never written to disk: a persisted model list read back on a later launch
 * would be presented as fact while being nothing but a stale guess.
 */

const TTL_MS = 60_000;
const TIMEOUT_MS = 8000;

const cache = new Map<string, { result: ModelDiscoveryResult; expiresAt: number }>();

/** Parsed from the response rather than assumed: some endpoints return entries without an
 * `id`, and a list of `undefined`s rendered as blank dropdown rows is worse than no list. */
function extractModelIds(body: unknown): string[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const ids = data
    .map((m) => (m && typeof m === "object" ? (m as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return [...new Set(ids)].sort();
}

export class ModelDiscoveryError extends Error {}

export async function discoverModels(
  baseUrl: string,
  apiKey?: string,
  /**
   * Skip the cache and really go to the network.
   *
   * The Check button MUST pass this. It previously shared the 60s cache with model-list
   * population, and connectionChecks stamps a fresh `checkedAt` onto whatever comes back - so
   * pressing Check on an endpoint that had died seconds ago reported "Working - checked 11:36"
   * for a request that never left the process. A check is the user asking "is this alive right
   * now"; answering it from a cache is the one thing it must not do.
   */
  opts: { force?: boolean } = {},
): Promise<ModelDiscoveryResult> {
  const root = baseUrl.trim().replace(/\/+$/, "");
  if (!root) throw new ModelDiscoveryError("this connection has no base URL saved");

  // Keyed by base URL *and* key, because the same endpoint can list different models for
  // different accounts - one account's catalog must never be served for another's key.
  // JSON-encoded rather than concatenated with a separator: both halves are
  // user-controlled, so any literal delimiter could in principle appear inside one of
  // them and let two different (root, key) pairs collide onto one cache entry - which
  // would serve one connection's model list for another's key. This was a NUL byte,
  // which was collision-safe but made git treat this file as binary.
  const cacheKey = JSON.stringify([root, apiKey ?? ""]);
  const hit = cache.get(cacheKey);
  if (!opts.force && hit && hit.expiresAt > Date.now()) return hit.result;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${root}/models`, {
      method: "GET",
      // Same rule as custom-api.ts: the header goes on only when there is actually a key,
      // so a keyless local server isn't sent a "Bearer undefined" it may well reject.
      headers: apiKey ? { Authorization: `Bearer ${apiKey}`, accept: "application/json" } : { accept: "application/json" },
      signal: controller.signal,
    });
  } catch (err) {
    throw new ModelDiscoveryError(`failed to reach ${root}/models: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ModelDiscoveryError(`${root}/models returned ${response.status}: ${body.slice(0, 200)}`);
  }

  const models = extractModelIds(await response.json().catch(() => null));
  if (models.length === 0) {
    // An endpoint that answers 200 with nothing usable is not a model list. Saying so beats
    // handing the UI an empty dropdown that reads as "this endpoint has no models".
    throw new ModelDiscoveryError(`${root}/models returned no model ids`);
  }

  const result: ModelDiscoveryResult = { models, fetchedAt: new Date().toISOString() };
  cache.set(cacheKey, { result, expiresAt: Date.now() + TTL_MS });
  return result;
}

/** Test seam - the cache is process-lifetime otherwise. */
export function clearModelDiscoveryCache(): void {
  cache.clear();
}

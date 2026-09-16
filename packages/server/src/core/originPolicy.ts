/**
 * Which browser origins may call this API.
 *
 * The server previously ran fastify-cors with `origin: true`, which reflects back whatever
 * Origin header it is sent. That means ANY website the user happens to visit can call
 * http://localhost:4310 from their browser and read the response - listing agents, enumerating
 * the credential vault, or creating a bypassPermissions agent that runs shell commands. None of
 * the /api routes authenticate, so this policy is the entire boundary. Verified before the fix:
 * `curl -H "Origin: https://evil.example.com" .../api/agents` came back with
 * `access-control-allow-origin: https://evil.example.com`.
 *
 * Lives in its own module so it can be tested without importing index.ts, which starts a server
 * on import.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  // No Origin at all: curl, a native client, a same-origin navigation. These are not browser
  // cross-origin requests, and refusing them would break the app's own fetches.
  if (!origin) return true;
  let hostname: string;
  try {
    ({ hostname } = new URL(origin));
  } catch {
    // Unparseable is refused rather than parsed optimistically - a string this code cannot
    // understand is not a string it should trust.
    return false;
  }
  // Compared as a whole hostname, never a substring: "localhost.evil.com" and
  // "127.0.0.1.evil.com" are different hosts that merely READ like the real thing.
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

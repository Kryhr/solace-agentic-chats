import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { ChatMessage, UrlCheck } from "@solace/shared";
import { extractLocalUrlClaims } from "./claimCheck";
import type { ChatBus } from "./chatBus";

/**
 * Turn every localhost URL an agent posts into a checked fact on the message itself.
 *
 * claimCheck.ts already did half of this: it pulled localhost URLs out of a finished turn's
 * text, probed the ones the agent ASSERTED were live, and posted a system note when nothing
 * answered. That note is a separate message in the stream, which means it can scroll away from
 * the claim, it arrives after other messages have landed between them, and - the measured
 * failure - it only ever appears for the negative case. A reader looking at "the preview is at
 * http://localhost:4321" has no way to tell a checked URL from an unchecked one, so they treat
 * every one of them as a claim. 22 live claims, 4 contradicted within fifteen messages.
 *
 * So the result becomes a STATE on the message (ChatMessage.urlChecks) rather than a note beside
 * it, and it runs for every localhost URL rather than only for asserted ones - an unasserted URL
 * is still something the operator is going to click.
 *
 * ---------------------------------------------------------------------------------------------
 * The one rule: no badge without a real check
 * ---------------------------------------------------------------------------------------------
 * A ✓ that is sometimes a guess is worse than no ✓ at all, because it teaches the reader to
 * trust every one of them. So:
 *
 *  - a check that RAN and got an answer produces a UrlCheck, whether that answer was HTTP 200
 *    or ECONNREFUSED. Both are observations.
 *  - a check that could not run - the probe threw before reaching the network, the message was
 *    gone by the time the result came back - produces NOTHING. No entry, no badge, no cross.
 *  - `checkedAt` is mandatory and rendered, because a green tick with no time on it is a claim
 *    about now that a check from four minutes ago cannot make.
 *
 * The verifier attaches to ChatBus rather than to AgentManager: every message reaches the bus
 * exactly once whatever posted it, and the badge is a property of a message rather than of a
 * turn. That also keeps this entirely out of agentManager.ts.
 */

const DEFAULT_TIMEOUT_MS = 2000;

/** Loopback only - the same rule claimCheck.ts already holds to. Reaching out to arbitrary
 * hosts an agent named in a message is not something a local tool should do on its own. */
export async function checkLocalUrl(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<UrlCheck | undefined> {
  const [claim] = extractLocalUrlClaims(url);
  if (!claim) return undefined;

  const checkedAt = new Date().toISOString();
  const base = { url: claim.url, host: claim.host, port: claim.port, checkedAt };

  const observed = await observe(claim.url, timeoutMs);
  // `undefined` means the probe could not be attempted at all, which is NOT a failed check.
  if (!observed) return undefined;
  return { ...base, ...observed };
}

type Observation = { reachable: boolean; status?: number; detail: string };

/**
 * One real HTTP request. An HTTP status is what the operator will actually experience when they
 * click the link, so it is what gets reported - a bare TCP connect would call a server that
 * answers 500 on every path "live", which is exactly the kind of technically-true badge this is
 * replacing.
 *
 * A 4xx/5xx is still `reachable: true`. Something IS serving there; what it serves is the
 * agent's business, not the registry's. The badge says "a server answered, with this status",
 * and the status is shown so the reader can judge it themselves.
 */
function observe(url: string, timeoutMs: number): Promise<Observation | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: Observation | undefined) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const isHttps = url.toLowerCase().startsWith("https:");
      const req = (isHttps ? httpsRequest : httpRequest)(
        url,
        {
          method: "GET",
          timeout: timeoutMs,
          // A dev server with a self-signed cert is still a running dev server. This is
          // loopback, the question is "is something serving here", and refusing to answer it
          // over a cert we were never going to verify anyway would produce a ✗ that is wrong.
          ...(isHttps ? { rejectUnauthorized: false } : {}),
        },
        (res) => {
          const status = res.statusCode;
          // Drain and discard: an unread response keeps the socket alive, and we want the
          // status line, not the page.
          res.resume();
          finish(
            typeof status === "number"
              ? { reachable: true, status, detail: `HTTP ${status}` }
              : { reachable: true, detail: "connected, no status line" },
          );
        },
      );
      req.on("timeout", () => {
        req.destroy();
        finish({ reachable: false, detail: `no response within ${timeoutMs}ms` });
      });
      req.on("error", (err) => {
        const code = (err as NodeJS.ErrnoException).code;
        // A connection that was refused, reset or never routed is a genuine observation that
        // nothing is serving there. Anything else is us failing to ask, which must not become
        // a cross on somebody's message.
        if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "ENOTFOUND" || code === "EADDRNOTAVAIL") {
          finish({ reachable: false, detail: code });
          return;
        }
        finish(undefined);
      });
      req.end();
    } catch {
      // Threw before any request was made - a malformed URL, a host node:http will not accept.
      // Nothing was observed, so nothing is reported.
      finish(undefined);
    }
  });
}

/** Every localhost URL in a message, checked. Order follows the text. */
export async function checkLocalUrlsIn(text: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<UrlCheck[]> {
  const claims = extractLocalUrlClaims(text);
  if (claims.length === 0) return [];
  const results = await Promise.all(claims.map((c) => checkLocalUrl(c.url, timeoutMs)));
  return results.filter((r): r is UrlCheck => r !== undefined);
}

/** Messages this never badges: the operator's own (they know what they typed) and the system's
 * (including claimCheck's own notice, which would otherwise be badged for quoting the URL it
 * is reporting as dead). */
function shouldCheck(message: ChatMessage): boolean {
  if (message.authorId === "user" || message.authorId === "system") return false;
  return extractLocalUrlClaims(message.text).length > 0;
}

/**
 * Wire the verifier onto a bus. Returns the unsubscribe function.
 *
 * Only `chat:message` is handled, never `chat:message:updated` - the update this writes emits
 * one of those, and handling it would re-check the message it just checked, forever.
 */
export function attachUrlVerification(
  bus: ChatBus,
  options: { timeoutMs?: number } = {},
): () => void {
  return bus.subscribe((event) => {
    if (event.type !== "chat:message") return;
    const message = event.payload;
    if (!shouldCheck(message)) return;
    void (async () => {
      const checks = await checkLocalUrlsIn(message.text, options.timeoutMs);
      // Nothing observed means nothing to say. Writing an empty array would be indistinguishable
      // from "checked and found nothing", and the message already renders correctly without it.
      if (checks.length === 0) return;
      bus.updateMessage(message.id, { urlChecks: checks });
    })();
  });
}

import { connect } from "node:net";

/**
 * "The landing page is live locally at http://localhost:3010" - said in the group chat while
 * nothing was listening on 3010 at all. That claim came from an agent that had already been
 * told, in the group-context block every single turn passes through, not to call something
 * live without verifying it first. It said it anyway.
 *
 * A prompt can ask for honesty; it can't enforce it. This checks the claim instead: pull any
 * localhost URL out of what the agent actually said, try to open a real TCP connection to it,
 * and if nothing answers, say so in the channel where the claim was made. It never guesses and
 * never contradicts a port that IS listening - the only thing it ever reports is a connection
 * that genuinely failed, at a stated time.
 */

/** Only loopback hosts. A claim about a public URL isn't this server's business to probe, and
 * quietly reaching out to arbitrary hosts an agent named is exactly the kind of thing a local
 * tool shouldn't do on its own. */
const LOCAL_URL = /\bhttps?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?(?:\/\S*)?/gi;

export interface LocalUrlClaim {
  url: string;
  host: string;
  port: number;
}

/**
 * Words that assert the thing is actually up right now. Merely naming a URL is not a claim -
 * "I'll serve it at http://localhost:3010 next" and "I haven't checked whether
 * http://localhost:3010 is running" are both perfectly honest sentences.
 */
const ASSERTS_AVAILABLE =
  /\b(is |it's |its |now )?(live|running|up|serving|served|available|deployed|started|hosted)\b|\b(you can|go|head|browse|open|view|visit|see it)\b/i;

/**
 * Negation and hedging. Checked against the same sentence, and it wins over an availability
 * word: "not running", "haven't verified it's live", "if it's live" must never be read as a
 * claim. This matters more than catching every real overclaim - an agent that hedges honestly
 * and gets publicly "corrected" for it is being taught the wrong lesson, and the whole point of
 * this check is to reward verifying rather than to nag. When in doubt, stay quiet.
 */
const HEDGED_OR_NEGATED =
  /\b(not|n't|never|nothing|nobody|none|no longer|yet|unverified|unconfirmed|haven't|hasn't|isn't|aren't|won't|can't|cannot|unable|failed|fails|refused|down|if|whether|once|after|unless|should be|would be|will be|going to|about to|next|todo|to-do|plan to|intend to|try|assume|assuming|maybe|might|may|could)\b/i;

/**
 * Sentence-ish segments. Newlines count as boundaries because agents write in bullets and
 * headings as often as in prose, and a bullet's claim shouldn't borrow the next bullet's hedge.
 */
function segments(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Only the URLs this text actually asserts are up right now. Deliberately conservative: a URL
 * in a sentence with no availability word, or with any negation/hedge, is not reported at all.
 */
export function extractLiveClaims(text: string): LocalUrlClaim[] {
  const claimed = new Map<string, LocalUrlClaim>();
  for (const segment of segments(text)) {
    if (!ASSERTS_AVAILABLE.test(segment)) continue;
    if (HEDGED_OR_NEGATED.test(segment)) continue;
    for (const claim of extractLocalUrlClaims(segment)) {
      claimed.set(`${claim.host}:${claim.port}`, claim);
    }
  }
  return [...claimed.values()];
}

export function extractLocalUrlClaims(text: string): LocalUrlClaim[] {
  const seen = new Map<string, LocalUrlClaim>();
  for (const match of text.matchAll(LOCAL_URL)) {
    const [raw, host, rawPort] = match;
    const port = rawPort ? Number(rawPort) : raw.toLowerCase().startsWith("https") ? 443 : 80;
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    // Strip trailing punctuation the regex happily swallowed from prose ("...at
    // http://localhost:3010." / "(http://localhost:3010)").
    const url = raw.replace(/[).,;:!?'"`\]]+$/, "");
    const key = `${host.toLowerCase()}:${port}`;
    if (!seen.has(key)) seen.set(key, { url, host: host === "[::1]" ? "::1" : host, port });
  }
  return [...seen.values()];
}

function canConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/**
 * A dev server started in the same breath as the message can legitimately need a moment to
 * bind, so a single failed connect isn't yet evidence of anything - this retries once before
 * reporting, to avoid accusing an agent of overclaiming when it was merely early.
 */
export async function findUnreachableClaims(
  claims: LocalUrlClaim[],
  opts: { timeoutMs?: number; retryDelayMs?: number } = {},
): Promise<LocalUrlClaim[]> {
  const timeoutMs = opts.timeoutMs ?? 1500;
  const retryDelayMs = opts.retryDelayMs ?? 2000;
  const unreachable: LocalUrlClaim[] = [];
  for (const claim of claims) {
    if (await canConnect(claim.host, claim.port, timeoutMs)) continue;
    await new Promise((r) => setTimeout(r, retryDelayMs));
    if (await canConnect(claim.host, claim.port, timeoutMs)) continue;
    unreachable.push(claim);
  }
  return unreachable;
}

/** Deliberately states only what was observed and when, and doesn't assert the agent was
 * wrong about its own intent - "nothing is listening" is a fact; "you lied" is an inference. */
export function unreachableClaimNotice(claims: LocalUrlClaim[], checkedAt: Date): string {
  const list = claims.map((c) => c.url).join(", ");
  const plural = claims.length > 1;
  return (
    `Checked ${list} at ${checkedAt.toLocaleTimeString()}: nothing is listening on ` +
    `${plural ? "those ports" : "that port"}. If ${plural ? "they're" : "it's"} meant to be ` +
    `running, ${plural ? "they haven't" : "it hasn't"} started yet.`
  );
}

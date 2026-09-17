import type { AccountUsage, AgentConfig, ProviderId, ProviderRateLimit } from "@solace/shared";
import { listAccounts, supportsMultipleAccounts } from "./providerAccounts";
import { rateLimitKey } from "./rateLimits";

/**
 * The usage view's rows: one per LOGIN that agents are actually spending, not one per provider.
 *
 * The bug this file exists to close: usage was keyed by provider, so two Claude agents on two
 * different Claude subscriptions collapsed into a single "Claude Code" row, and that row showed
 * whichever account had most recently finished a turn - presented as the quota of both. The
 * operator would look at it, see one account at 12%, and believe the other had 88% left when it
 * might have had none.
 *
 * Two rules hold everywhere below:
 *
 *  1. An account that has never reported gets NO rateLimit. Not a zero, not a blank bar, not the
 *     other account's figure. "No number has arrived for this login" is the honest answer, and
 *     the UI renders it as words.
 *  2. Identity is copied, never inferred. The email and plan are whatever the CLI's own
 *     read-only status command said (`claude auth status` returns both, and costs no turn and no
 *     tokens). A CLI that reports nothing leaves them undefined and the row is identified by its
 *     label alone.
 */

/** An identity as `listAccounts` reports it, reduced to what a usage row needs. Taking this as
 * data rather than calling listAccounts inside the builder is what makes the builder pure, and
 * therefore testable without spawning a real CLI. */
export interface AccountIdentityRecord {
  provider: ProviderId;
  /** undefined = the CLI's own default login. */
  account?: string;
  email?: string;
  plan?: string;
  loggedIn?: boolean;
}

/**
 * Build the usage rows.
 *
 * The row set comes from the AGENTS, not from the accounts on disk: an account directory with
 * no agent pointed at it is a login the user made, not a subscription this app is spending, and
 * a row for it would be a bar that can never move. Ordering follows the agent roster so the
 * rows sit in the same order as everything else in the app rather than in map-insertion order.
 */
export function buildAccountUsage(
  agents: Pick<AgentConfig, "provider" | "account" | "handle">[],
  limits: ProviderRateLimit[],
  identities: AccountIdentityRecord[] = [],
): AccountUsage[] {
  const limitByKey = new Map(limits.map((l) => [rateLimitKey(l.provider, l.account), l]));
  const identityByKey = new Map(identities.map((i) => [rateLimitKey(i.provider, i.account), i]));

  const rows = new Map<string, AccountUsage>();
  for (const agent of agents) {
    // An empty-string account in a hand-edited config is not a label - isValidAccountLabel would
    // reject it - so it means the default login, and must key identically to undefined or the
    // same subscription would get two rows.
    const account = agent.account && agent.account.length > 0 ? agent.account : undefined;
    const key = rateLimitKey(agent.provider, account);
    const existing = rows.get(key);
    if (existing) {
      existing.agentHandles.push(agent.handle);
      continue;
    }
    const identity = identityByKey.get(key);
    rows.set(key, {
      provider: agent.provider,
      account,
      email: identity?.email,
      plan: identity?.plan ?? limitByKey.get(key)?.planType,
      loggedIn: identity?.loggedIn,
      // Absent when nothing has ever been observed for this login - see rule 1 above.
      rateLimit: limitByKey.get(key),
      agentHandles: [agent.handle],
    });
  }
  return [...rows.values()];
}

/**
 * Who each account is, asked of the CLIs themselves.
 *
 * `listAccounts` spawns one short-lived process per account (`claude auth status`), which is
 * free in money and tokens but costs real wall-clock time, and the usage popover can be opened
 * repeatedly. So it is memoised - in memory only, never persisted: an identity read off disk on
 * a later launch would be shown as current while describing a login that may since have been
 * replaced, which is the same class of lie as a stale quota.
 *
 * Only providers that some agent actually uses are probed, so a machine with eight CLIs
 * installed does not spawn eight processes to render a meter about two of them.
 */
const IDENTITY_TTL_MS = 5 * 60_000;

/**
 * Cached PER PROVIDER, not per call.
 *
 * One cache entry for the whole call was wrong and was caught live: the server asks for
 * identities once at boot, when the roster is still empty, so it cached an empty answer - and
 * every later request, by then with two real Claude accounts configured, was served that empty
 * answer for the next five minutes. Both rows rendered with no email and no plan. Keying by
 * provider means an answer is only ever reused for the provider it was actually about.
 */
const identityCache = new Map<ProviderId, { at: number; value: AccountIdentityRecord[] }>();

export function clearAccountIdentityCache(): void {
  identityCache.clear();
}

async function identitiesFor(provider: ProviderId): Promise<AccountIdentityRecord[]> {
  const cached = identityCache.get(provider);
  if (cached && Date.now() - cached.at < IDENTITY_TTL_MS) return cached.value;
  let value: AccountIdentityRecord[];
  try {
    value = (await listAccounts(provider)).map((identity) => ({
      provider,
      account: identity.label,
      email: identity.email,
      plan: identity.subscriptionType,
      // identityUnknown means the CLI has no read-only way to say. Reporting its loggedIn:false
      // as a real "signed out" would tell someone their working account was signed out, so the
      // field is left undefined instead.
      loggedIn: identity.identityUnknown ? undefined : identity.loggedIn,
    }));
  } catch {
    // A CLI that cannot be probed contributes no identity. The row still renders, named by its
    // label, with whatever quota was genuinely observed - strictly better than failing the whole
    // request over one uncooperative binary. Not cached, so the next request tries again rather
    // than treating a transient failure as five minutes of settled fact.
    return [];
  }
  identityCache.set(provider, { at: Date.now(), value });
  return value;
}

export async function readAccountIdentities(providers: ProviderId[]): Promise<AccountIdentityRecord[]> {
  const wanted = [...new Set(providers)].filter(supportsMultipleAccounts);
  const perProvider = await Promise.all(wanted.map(identitiesFor));
  return perProvider.flat();
}

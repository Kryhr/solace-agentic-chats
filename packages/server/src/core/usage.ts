import type { TurnUsage, UsageCost } from "@solace/shared";

/**
 * Accumulation and shape-guarding for TurnUsage, in one place so that every adapter and the
 * agent runtime agree about what "absent" means.
 *
 * The rule the whole file exists to enforce: a field is written ONLY when a provider actually
 * produced a number for it. `undefined + undefined` stays `undefined`; it never becomes 0.
 * See the TurnUsage doc comment in packages/shared/src/index.ts.
 */

/** Adds two optional counts, keeping `undefined` when NEITHER side reported anything. */
function addCount(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

function addCosts(a: UsageCost[] | undefined, b: UsageCost[] | undefined): UsageCost[] | undefined {
  if (!a && !b) return undefined;
  const byUnit = new Map<string, number>();
  for (const cost of [...(a ?? []), ...(b ?? [])]) {
    byUnit.set(cost.unit, (byUnit.get(cost.unit) ?? 0) + cost.amount);
  }
  return [...byUnit].map(([unit, amount]) => ({ amount, unit }));
}

/**
 * Sums one usage report into a running total.
 *
 * Session-scoped reports are REPLACED, not added. Crush publishes only a cumulative total for
 * the whole conversation, so adding each turn's report to a running total made an agent's
 * third turn claim roughly three times the tokens Crush itself would show for that session -
 * the provider had already done the adding. `scope` is what tells the two cases apart.
 *
 * The two "is X already inside Y" booleans are carried from the newer report rather than
 * merged: they are facts about the provider, identical on every report from that provider, and
 * OR-ing or AND-ing them would be arithmetic on something that is not a quantity.
 */
export function addUsage(total: TurnUsage, delta: TurnUsage): TurnUsage {
  if (delta.scope === "session") return { ...delta };
  const next: TurnUsage = {};
  const inputTokens = addCount(total.inputTokens, delta.inputTokens);
  if (inputTokens !== undefined) next.inputTokens = inputTokens;
  const outputTokens = addCount(total.outputTokens, delta.outputTokens);
  if (outputTokens !== undefined) next.outputTokens = outputTokens;
  const cacheReadTokens = addCount(total.cacheReadTokens, delta.cacheReadTokens);
  if (cacheReadTokens !== undefined) next.cacheReadTokens = cacheReadTokens;
  const cacheWriteTokens = addCount(total.cacheWriteTokens, delta.cacheWriteTokens);
  if (cacheWriteTokens !== undefined) next.cacheWriteTokens = cacheWriteTokens;
  const reasoningTokens = addCount(total.reasoningTokens, delta.reasoningTokens);
  if (reasoningTokens !== undefined) next.reasoningTokens = reasoningTokens;
  // Summing the provider's own per-turn totals is not the same thing as computing a total from
  // parts, which TurnUsage forbids: each addend is a figure the provider itself stated.
  const totalTokens = addCount(total.totalTokens, delta.totalTokens);
  if (totalTokens !== undefined) next.totalTokens = totalTokens;
  const totalCostUsd = addCount(total.totalCostUsd, delta.totalCostUsd);
  if (totalCostUsd !== undefined) next.totalCostUsd = totalCostUsd;
  const estimatedCostUsd = addCount(total.estimatedCostUsd, delta.estimatedCostUsd);
  if (estimatedCostUsd !== undefined) next.estimatedCostUsd = estimatedCostUsd;
  const otherCosts = addCosts(total.otherCosts, delta.otherCosts);
  if (otherCosts !== undefined) next.otherCosts = otherCosts;
  const cacheCountedInInput = delta.cacheCountedInInput ?? total.cacheCountedInInput;
  if (cacheCountedInInput !== undefined) next.cacheCountedInInput = cacheCountedInInput;
  const reasoningCountedInOutput = delta.reasoningCountedInOutput ?? total.reasoningCountedInOutput;
  if (reasoningCountedInOutput !== undefined) next.reasoningCountedInOutput = reasoningCountedInOutput;
  const caveat = delta.caveat ?? total.caveat;
  if (caveat !== undefined) next.caveat = caveat;
  return next;
}

/**
 * Folds one OpenCode/Kilo `step_finish` part into the running per-turn usage.
 *
 * Both CLIs are the same stream format (Kilo is a fork) and both report ONE of these per step
 * of a multi-step turn, shaped - captured live from `opencode run --format json` on
 * opencode/mimo-v2.5-free, three steps of one real turn:
 *
 *   "tokens":{"total":21423,"input":20354,"output":25,"reasoning":20,"cache":{"write":0,"read":1024}}
 *   "tokens":{"total":21600,"input":127,  "output":87,"reasoning":10,"cache":{"write":0,"read":21376}}
 *   "tokens":{"total":21729,"input":271,  "output":10,"reasoning":8, "cache":{"write":0,"read":21440}}
 *
 * The arithmetic in that capture settles two questions that guessing would have got wrong, and
 * it holds exactly on all three steps:
 *
 *   total = input + output + reasoning + cache.write + cache.read
 *
 * so (a) `input` EXCLUDES cache reads - cacheCountedInInput is false, the opposite of Codex -
 * and (b) `reasoning` is NOT inside `output` - reasoningCountedInOutput is false, again the
 * opposite of Codex and Claude. Keeping only input+output, as this adapter used to, dropped
 * 1047 of step one's 21423 tokens and every cached token after it.
 *
 * Accumulated rather than emitted per step because agentManager treats each "usage" event as
 * THE usage for the turn, so emitting per step would make a six-step turn report only its last
 * step's numbers. `total` is summed the same way: each addend is a total OpenCode itself stated
 * for that step, so this is aggregating the provider's own figures, not computing a total from
 * parts.
 */
export function addStepFinishUsage(total: TurnUsage | undefined, tokens: unknown, cost: unknown): TurnUsage {
  const t = (typeof tokens === "object" && tokens !== null ? tokens : {}) as Record<string, unknown>;
  const cache = (typeof t.cache === "object" && t.cache !== null ? t.cache : {}) as Record<string, unknown>;
  const step: TurnUsage = {};
  put(step, "inputTokens", num(t.input));
  put(step, "outputTokens", num(t.output));
  put(step, "reasoningTokens", num(t.reasoning));
  put(step, "cacheReadTokens", num(cache.read));
  put(step, "cacheWriteTokens", num(cache.write));
  put(step, "totalTokens", num(t.total));
  put(step, "totalCostUsd", num(cost));
  if (step.cacheReadTokens !== undefined || step.cacheWriteTokens !== undefined) step.cacheCountedInInput = false;
  if (step.reasoningTokens !== undefined) step.reasoningCountedInOutput = false;
  return addUsage(total ?? {}, step);
}

/** True when a usage report carries no number at all, i.e. there is nothing honest to show. */
export function isEmptyUsage(usage: TurnUsage | undefined): boolean {
  if (!usage) return true;
  return (
    usage.inputTokens === undefined &&
    usage.outputTokens === undefined &&
    usage.cacheReadTokens === undefined &&
    usage.cacheWriteTokens === undefined &&
    usage.reasoningTokens === undefined &&
    usage.totalTokens === undefined &&
    usage.totalCostUsd === undefined &&
    usage.estimatedCostUsd === undefined &&
    (usage.otherCosts?.length ?? 0) === 0
  );
}

/** Reads a number out of untrusted provider JSON, rejecting NaN/Infinity and non-numbers. */
export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Assigns `value` to `key` only when the provider actually gave a number.
 *
 * Written as a helper rather than inline `??` so that no adapter can accidentally spell a
 * missing figure as 0 - which is the single bug this whole change exists to stop.
 */
export function put<K extends keyof TurnUsage>(
  usage: TurnUsage,
  key: K,
  value: TurnUsage[K] | undefined,
): void {
  if (value !== undefined) usage[key] = value;
}

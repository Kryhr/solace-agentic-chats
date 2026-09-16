import type { TurnUsage } from "@solace/shared";

/**
 * Token usage for one agent, rendered from what the provider actually said.
 *
 * The rule this component exists to enforce, and which the bar it replaces broke: an ABSENT
 * figure and a ZERO figure are different claims, and only one of them can be made honestly.
 * The old bar read `status.totalUsage.inputTokens ?? 0` and `outputTokens ?? 0`, so Copilot -
 * which publishes no output-token count anywhere in its JSON stream - rendered as a confident
 * "0 out", and any provider that reported nothing at all rendered as "0 in · 0 out". Here a
 * figure the provider never gave is shown as an em dash and named in the tooltip.
 *
 * Nothing here recomputes a provider's own number. The one derived figure is the prompt total,
 * and it is derived only where TurnUsage says it is safe to: cache reads are added to the input
 * count when `cacheCountedInInput` is false (Anthropic, OpenCode) and NOT added when it is true
 * (Codex, Gemini, Qwen, Copilot), because in that case the provider has already counted them.
 * Getting this wrong in either direction is how a displayed prompt size stops matching what the
 * user's own CLI prints - which is the whole point of the meter.
 */

function formatTokens(n: number | undefined): string {
  // An em dash, not "0". See the note above.
  return n === undefined ? "—" : n.toLocaleString();
}

function formatCost(n: number): string {
  // Sub-cent turns are the common case for cheap models, so a 2-decimal format would show most
  // real turns as "$0.00", which reads as free.
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function plural(amount: number, unit: string): string {
  return `${amount.toLocaleString()} ${unit}${amount === 1 ? "" : "s"}`;
}

/**
 * The prompt size to show: the provider's input count, plus its cache-read count only when the
 * provider counts the two separately. Returns undefined when no prompt figure was reported.
 */
export function promptTokens(usage: TurnUsage): number | undefined {
  if (usage.inputTokens === undefined) return usage.cacheReadTokens;
  if (usage.cacheCountedInInput === false) {
    return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  }
  return usage.inputTokens;
}

/** The sentence shown on hover: every figure the provider gave, and what it left out. */
export function usageTooltip(usage: TurnUsage): string {
  const lines: string[] = [];
  const scope = usage.scope === "session" ? "this session, as the provider totals it" : "this session";
  lines.push(`Prompt: ${formatTokens(promptTokens(usage))} · Output: ${formatTokens(usage.outputTokens)} (${scope})`);
  if (usage.cacheReadTokens !== undefined) {
    const inside = usage.cacheCountedInInput ? "already inside the prompt figure" : "on top of the prompt figure";
    lines.push(`Cache read: ${usage.cacheReadTokens.toLocaleString()} (${inside})`);
  }
  if (usage.cacheWriteTokens !== undefined) {
    lines.push(`Cache written: ${usage.cacheWriteTokens.toLocaleString()}`);
  }
  if (usage.reasoningTokens !== undefined) {
    const inside = usage.reasoningCountedInOutput ? "already inside the output figure" : "on top of the output figure";
    lines.push(`Reasoning: ${usage.reasoningTokens.toLocaleString()} (${inside})`);
  }
  if (usage.totalTokens !== undefined) {
    lines.push(`Provider's own total: ${usage.totalTokens.toLocaleString()}`);
  }
  if (usage.totalCostUsd !== undefined) lines.push(`Cost, as the provider stated it: ${formatCost(usage.totalCostUsd)}`);
  if (usage.estimatedCostUsd !== undefined) {
    lines.push(`Estimated cost: ${formatCost(usage.estimatedCostUsd)} — calculated here from a list price, not billed`);
  }
  for (const cost of usage.otherCosts ?? []) lines.push(`Billed by the provider as: ${plural(cost.amount, cost.unit)}`);
  if (usage.outputTokens === undefined) lines.push("This provider does not report output tokens.");
  if (usage.caveat) lines.push(usage.caveat);
  return lines.join("\n");
}

export function TokenUsageBar({ usage, authMode }: { usage?: TurnUsage; authMode?: string }) {
  if (!usage) return null;
  const prompt = promptTokens(usage);
  const output = usage.outputTokens;
  const costs = usage.otherCosts ?? [];
  // Nothing numeric at all means there is nothing to say; saying nothing is the honest render.
  if (
    prompt === undefined &&
    output === undefined &&
    usage.totalTokens === undefined &&
    usage.totalCostUsd === undefined &&
    usage.estimatedCostUsd === undefined &&
    costs.length === 0
  ) {
    return null;
  }

  // The bar is only drawn when BOTH halves are known. A split drawn from a missing number would
  // be a picture of a fact nobody reported.
  const split = prompt !== undefined && output !== undefined && prompt + output > 0;
  const inPct = split ? Math.round((prompt! / (prompt! + output!)) * 100) : 0;
  const tooltip = usageTooltip(usage);
  const scopeLabel = usage.scope === "session" ? "this session (provider total)" : "this session";

  return (
    <div className="hub-usage-bar">
      {split && (
        <div className="usage-meter" title={tooltip}>
          <div className="usage-meter-in" style={{ width: `${inPct}%` }} />
        </div>
      )}
      <span className="usage-meter-label" title={tooltip}>
        {formatTokens(prompt)} in · {formatTokens(output)} out {scopeLabel}
        {usage.totalTokens !== undefined && ` · ${usage.totalTokens.toLocaleString()} total`}
        {usage.totalCostUsd !== undefined && ` · ${formatCost(usage.totalCostUsd)}`}
        {/* Only ever labelled an estimate where it IS one - the adapter decides that, not the UI,
            by choosing estimatedCostUsd over totalCostUsd. authMode still qualifies a provider's
            own figure, because a subscription CLI's dollar figure is what the run would have
            cost on the API rather than something the user is billed per turn. */}
        {usage.totalCostUsd !== undefined &&
          authMode !== "api-key" &&
          " (≈ API-equivalent, you're not billed per-token)"}
        {usage.estimatedCostUsd !== undefined && ` · ≈${formatCost(usage.estimatedCostUsd)} estimated`}
        {costs.map((cost) => ` · ${plural(cost.amount, cost.unit)}`)}
        {output === undefined && <span className="usage-meter-gap"> · output not reported</span>}
      </span>
    </div>
  );
}

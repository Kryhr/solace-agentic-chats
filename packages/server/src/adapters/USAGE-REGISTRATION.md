# Usage reporting — what changed, and the two edits outside the adapters

Branch `usage-truth`. Everything here is about making per-turn usage match what each provider's
own CLI reports. The adapters and `packages/server/src/core/usage.ts` are self-contained; two
edits land in files other agents also touch, and both are listed below so they can be reviewed
or re-applied on their own.

## 1. `packages/shared/src/index.ts` — `TurnUsage` replaced

`TurnUsage` had three fields (`inputTokens`, `outputTokens`, `totalCostUsd`), which is fewer
than any provider reports. It now carries the buckets providers actually publish, plus the two
facts needed to read them correctly:

| field | why it exists |
| --- | --- |
| `cacheReadTokens` / `cacheWriteTokens` | For Claude these are routinely 99% of the prompt. Dropping them understated Claude's input by orders of magnitude. |
| `reasoningTokens` | Codex, OpenCode, Copilot and Droid all itemise it; none of it was kept. |
| `totalTokens` | Several providers state a total that is **not** input + output (OpenCode's includes reasoning and cache; Gemini's includes thought and tool tokens). That stated total is the number the user's own CLI prints, so it is carried verbatim and never replaced by a computed sum. |
| `cacheCountedInInput` | Codex/Gemini/Qwen/Copilot count cache reads **inside** their input figure; Anthropic, Droid, OpenCode and Kilo report them **alongside** it. Without this flag any prompt total is wrong for half the providers. |
| `reasoningCountedInOutput` | Same problem for reasoning: inside `output_tokens` for Codex and Claude, outside it for OpenCode. |
| `estimatedCostUsd` | Kept strictly apart from `totalCostUsd`, which is now *provider-stated dollars only*. The two direct-API adapters multiply a hard-coded price table; that must never look like a receipt. |
| `otherCosts` | Copilot bills in premium requests and nano-AIU, Droid in Factory credits. These are the only cost figures those providers give. Converting them to dollars would mean inventing an exchange rate. |
| `scope` | Crush publishes only a session-cumulative total. Marked so the running total replaces rather than re-adds it. |
| `caveat` | One sentence saying what a provider's figures do **not** cover — Copilot's, in particular. |

A `UsageCost` interface is added alongside it. Every field is optional and **absent means "the
provider did not say"**, never 0 — the same rule the `RateLimitWindow` doc comment states.

## 2. `packages/server/src/core/agentManager.ts` — `addUsage` moved out

Two lines of import plus deleting the local `addUsage`, which now lives in
`packages/server/src/core/usage.ts` next to the per-provider extraction it has to agree with.

It is not a drop-in rename; the behaviour changed deliberately, in two ways:

- **Absent stays absent.** The old version spelled every field `(a ?? 0) + (b ?? 0)`, so a
  provider that never reported output tokens accumulated a confident `outputTokens: 0`. That is
  the bug the whole branch is about.
- **Session-scoped reports replace instead of adding.** Crush's numbers are cumulative for the
  whole conversation, so adding each turn's snapshot made an agent's third turn claim roughly
  three times the tokens Crush itself would show. Guarded by `delta.scope === "session"`, so no
  other provider's path is affected.

If `agentManager.ts` conflicts, the whole of this change is: add `import { addUsage } from
"./usage";`, delete the old `function addUsage(...)`, and leave the two call sites alone.

## Not changed, deliberately

- `core/commands.ts`'s `/usage` command still prints rate-limit windows only. It never printed
  token counts, so nothing there regressed; extending it is a separate piece of work.
- `estimateCost`'s price tables in `claude-api.ts` / `openai-api.ts` are untouched. They are
  still stale-able list prices — the change is only that their output is now labelled as an
  estimate in the type and in the UI, rather than sitting in the same field as a figure a
  provider actually stated.

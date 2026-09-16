# Registering the Crush adapter

`packages/server/src/adapters/crush.ts` is complete, built, and unit-tested, but nothing imports
it yet. Seven adapters were built in parallel and every one of them needs a line in the same
handful of shared files, so those edits were deliberately left out of this branch to avoid seven
merge conflicts on identical lines. Apply the diffs below.

Everything here was verified against the real `crush` binary, **v0.95.0** (`@charmland/crush`),
on Windows, on 2026-09-16. Where a claim could not be verified live it is called out explicitly.

---

## 1. `packages/shared/src/index.ts`

Add `"crush"` to the `ProviderId` union (line ~73). `CliProviderId` is derived from it, so
nothing else in that file changes.

```ts
export type ProviderId =
  | "claude-code"
  | "codex-cli"
  | "gemini-cli"
  | "qwen-code"
  | "copilot-cli"
  | "crush"          // <-- add
  | "custom"
  | "local";
```

**Note:** `crush.ts` currently casts its id (`id: "crush" as ProviderAdapter["id"]`) precisely
because this union does not include it yet. Once the line above lands, **delete the cast** and
write `id: "crush"`.

## 2. `packages/server/src/adapters/index.ts`

```ts
import { crushAdapter } from "./crush";

const cliAdapters: Record<CliProviderId, ProviderAdapter> = {
  // ...
  "crush": crushAdapter,
};
```

Do **not** add an entry to `apiAdapters`. Crush has no direct-API-key variant in this app.

## 3. `packages/server/src/core/permissionCatalog.ts`

```ts
const CRUSH_MODES: TrustLevel[] = ["plan", "acceptEdits", "bypassPermissions"];

const CATALOG: Record<CliProviderId, ProviderPermissionInfo> = {
  // ...
  "crush": { provider: "crush", availableModes: CRUSH_MODES },
};
```

Please also extend that file's doc comment with:

> Crush: three of the five. Headless `crush run` has **no approval mechanism whatsoever** —
> `--yolo` exists only on the interactive TUI root command and `run` rejects it
> ("Unknown flag: --yolo"), and a headless turn with no permissions config at all executed
> `bash` and wrote a new file to disk without asking. `permissions.allowed_tools` does not help:
> it is a *pre-approval* list, not a restrictive allowlist (with `allowed_tools: ["view"]` set,
> a `write` call still created the file). The only lever that genuinely restricts is
> `options.disabled_tools`, which does work and is not defeatable from a repo-local crush.json.
> So the three modes are expressed by removing tools outright. "manual" is omitted because Crush
> has no external approval hook like Claude Code's `--permission-prompt-tool` — offering it would
> promise a human gate that does not exist. "auto" is omitted for the reason Gemini's and
> Copilot's are: no classifier-judged middle ground distinct from full access.

## 4. `packages/server/src/core/providerStatus.ts`

```ts
const CLI_BIN: Record<CliProviderId, string> = { /* ... */ "crush": "crush" };

export const INSTALL_COMMAND: Record<CliProviderId, string> = {
  // ...
  "crush": "npm install -g @charmland/crush",
};

export const LOGIN_COMMAND: Record<CliProviderId, string> = {
  // ...
  // `crush login [hyper|copilot|openai]` is a real top-level subcommand (and there is a
  // `crush logout` counterpart), but it only covers those three platforms. Every other
  // provider is configured by running `crush` once interactively, which is also what Crush's
  // own signed-out error tells the user to do, so that is what we echo.
  "crush": "crush",
};

const INSTALL_HINT: Record<CliProviderId, string> = {
  // ...
  "crush": "npm install -g @charmland/crush, then run `crush` once to set up a provider",
};
```

`crush --version` prints `crush version v0.95.0` on stdout and exits 0, so the existing version
probe needs no special-casing.

## 5. `packages/server/src/core/modelCatalog.ts`

Add a `"crush"` entry to the catalog record (~line 553):

```ts
"crush": {
  provider: "crush",
  models: crush.models,
  sources: crush.sources,
  sourceError: crush.error,
  // `crush run --reasoning-effort` takes low/medium/high, but the CLI's own help says the
  // accepted levels DEPEND ON THE MODEL and that unsupported values are rejected with the
  // accepted list. Not verified per-model here (no credentialed model was reachable on this
  // machine), so treat this list as the common case rather than as exhaustive.
  effortLevels: ["low", "medium", "high"],
  // No per-machine default is readable: the default model lives in the `models.large` key of
  // whichever crush.json applies, which may be the global one, a repo-local one, or neither.
  // Left undefined rather than asserting a default that may not exist.
  currentDefaultModel: undefined,
},
```

**Model list source (`cliModelSources.ts`).** Unlike the other CLIs, Crush does not need a
bundled-catalogue scrape: `crush models` prints every known model id, one per line, in exactly
the `provider/model` form that `crush run -m` accepts. Verified live — the output begins:

```
aihubmix/AiHubmix-Phi-4-mini-reasoning
aihubmix/DeepSeek-V3
...
```

So the source is simply `crush models`, split on newlines, each non-empty line an id. It exits 0
and needs no auth. Be aware the full list is very large (thousands of lines, every provider Crush
knows about, not just configured ones); `crush models <search>` filters it.

## 6. `packages/server/src/core/validateAgentConfig.ts`

```ts
const PROVIDER_IDS: ProviderId[] = ["claude-code", "codex-cli", "gemini-cli", "qwen-code", "copilot-cli", "crush", "custom", "local"];
```

## 7. `packages/web/src/components/AddAgentModal.tsx`

```ts
const PROVIDERS: ProviderId[] = ["claude-code", "codex-cli", "gemini-cli", "qwen-code", "copilot-cli", "crush", "custom", "local"];
```

## 8. `packages/web/src/components/ProviderIcon.tsx`

Three spots, matching the existing pattern:

```ts
// colour/label map
"crush": { color: "#ff5f87", label: "crush" },   // Charm's pink; pick to taste
// switch (provider) in the icon renderer
case "crush":
  // ...whatever mark is chosen
// short-name map
"crush": "crush",
```

## 9. `packages/shared/src/connectors.ts`

Not touched by any other CLI adapter's registration (`grep '"qwen-code"'` returns nothing there),
so **no change is expected**. If a sibling adapter turns out to need one, Crush needs the
equivalent.

---

## Things that were deliberately NOT built

- **No `manual` / `auto` trust level.** See §3. There is no approval hook to wire one to.
- **No `rate-limit` event.** Crush reports nothing about account quota anywhere in `run`,
  `session`, or `stats` output.
- **No live token streaming.** `crush run` has no `--json`/`--format` equivalent and its stdout
  is only the final answer text, so structure (tool calls, model, usage) is recovered after the
  turn from `crush session show --json`. The adapter therefore replays the turn on completion
  instead of streaming it. This is the single biggest fidelity gap versus the other adapters and
  is inherent to the CLI, not to the adapter.
- **Per-turn usage is cumulative.** `meta.prompt_tokens` / `completion_tokens` / `cost` in the
  session document are session totals, not per-turn deltas. Reported as-is so the numbers agree
  with the user's own `crush stats`; if per-turn is wanted later, difference against the previous
  turn's totals.
- **Crush writes a `.crush/` directory into the agent's working directory.** Confirmed live:
  after a turn, `crush projects` listed the data directory for the probe cwd as
  `<cwd>\.crush`, and that is where sessions live — not in the global data dir. The adapter
  deliberately does **not** override `--data-dir`, because Crush keeps credentials in the global
  data dir and redirecting it would break auth. So `.crush/` should be added to the workspace
  `.gitignore` the same way `.claude/` is, or agents will start offering it as a change to
  commit.
- **`crush server` / `-H --host` was not used.** Crush has a client/server mode over a named pipe
  which may expose a richer event stream. It was not investigated; `crush run` was sufficient and
  is the documented non-interactive path.

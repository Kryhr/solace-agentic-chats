# Registering `kilo` as a provider

Everything in this file is an edit to a SHARED file that this agent deliberately did not make,
because sibling agents were adding their own providers to the same files in parallel. Apply
them together.

**Verdict: SHIP, gated on one authenticated smoke test.** Kilo is the stronger of the two CLIs
this agent evaluated, for one structural reason: **it is a fork of OpenCode**, which this repo
already has a behaviourally-verified adapter for. Almost every design question was already
answered by `opencode.ts`, and the parts that are Kilo-specific were re-verified against the
real 7.7.2 binary.

---

## 1. `packages/shared/src/index.ts`

Add `"kilo"` to the `ProviderId` union (around line 73):

```ts
export type ProviderId =
  | "claude-code"
  | ...
  | "opencode"
  | "kilo"         // <-- add
```

`CliProviderId` is derived and needs no edit. Once this lands, delete the `as ProviderId` cast
on `kiloAdapter.id` in `adapters/kilo.ts`.

## 2. `packages/server/src/adapters/index.ts`

```ts
import { kiloAdapter } from "./kilo";

const cliAdapters: Record<CliProviderId, ProviderAdapter> = {
  ...
  kilo: kiloAdapter,
};
```

No `apiAdapters` entry — Kilo is a CLI, not an OpenAI-compatible endpoint.

## 3. `packages/server/src/core/permissionCatalog.ts`

```ts
const KILO_MODES: TrustLevel[] = ["plan", "acceptEdits", "bypassPermissions"];

const CATALOG: Record<CliProviderId, ProviderPermissionInfo> = {
  ...
  kilo: { provider: "kilo", availableModes: KILO_MODES },
};
```

Same three modes as OpenCode, for the same reasons. Suggested paragraph for the file's doc
comment:

> Kilo: three of the five, reached through config rather than a flag — it is an OpenCode fork
> and has no `--permission-mode` equivalent either. "manual" is omitted because a headless
> "ask" is auto-rejected rather than routed to a person, and "auto" is omitted because Kilo has
> no classifier-judged middle ground distinct from full access. One Kilo-specific hazard is
> worth knowing: an INVALID permission value is silently dropped rather than rejected, so a typo
> downgrades an agent to Kilo's permissive defaults with no error — `kiloArgs.test.ts` asserts
> every emitted value against the accepted set for exactly this reason.

## 4. `packages/server/src/core/providerStatus.ts`

```ts
const CLI_BIN:                { ... kilo: "kilo" }
export const INSTALL_COMMAND: { ... kilo: "npm install -g @kilocode/cli" }
export const LOGIN_COMMAND:   { ... kilo: "kilo auth login" }
const INSTALL_HINT:           { ... kilo: "npm install -g @kilocode/cli, then run `kilo auth login` to sign in" }
```

`kilo auth login` is a real top-level subcommand — confirmed in `kilo auth --help`, which also
lists `kilo auth logout`. Not an interactive-session sign-in.

## 5. `packages/server/src/core/modelCatalog.ts`

`kilo models` works exactly like `opencode models` and — usefully — **works while signed out**:
it printed **310** `provider/model` lines on this machine with zero credentials. So
`opencodeModels()` can be copied nearly verbatim:

```
$ kilo models
kilo/~anthropic/claude-opus-latest
kilo/~anthropic/claude-sonnet-latest
kilo/~deepseek/deepseek-pro-latest
kilo/~google/gemini-flash-latest
...
```

**`parseOpencodeModels()` cannot be reused as-is.** Two Kilo-specific differences, both measured
rather than guessed against the real signed-out output (310 lines):

- Some ids carry a `~` in the provider segment (`kilo/~anthropic/claude-opus-latest`), and its
  regex — `^([A-Za-z0-9._-]+)\/([A-Za-z0-9._:\/-]+)$` — has no `~` in either character class.
  **18 of the 310 lines are dropped**, and they are the worst 18 to lose: the
  `~anthropic` / `~google` / `~deepseek` aliases are the headline models a user would actually
  pick. Adding `~` to the second character class fixes it.
- Kilo ids are **three** segments (`kilo/~anthropic/claude-opus-latest`), not two. The existing
  parser treats the segment before the first `/` as the family, which would group all 310 under
  the single family `kilo` and make the grouping useless. The *second* segment is the real
  family here; the full string stays the id, since that is what `-m` takes.

Catalog entry:

```ts
kilo: {
  provider: "kilo",
  models: kilo.models,
  sources: kilo.sources,
  sourceError: kilo.error,
  // `kilo run --help` documents --variant as "model variant (provider-specific reasoning
  // effort, e.g., high, max, minimal)" and names exactly these three. It is a free-form
  // string, not a yargs `choices` list, so this is what the CLI's own help states rather
  // than a set it would enforce.
  effortLevels: ["minimal", "high", "max"],
  currentDefaultModel: undefined,
},
```

## 6. `connectors.ts` — no edit needed

The `solace` MCP bridge **is** registered by the adapter, and its config shape was **confirmed
against the real binary** rather than assumed: with

```json
{"mcp":{"solace":{"type":"local","command":["node","C:/nonexistent/probe.mjs"],
                  "enabled":true,"environment":{"SOLACE_AGENT_ID":"probe"}}}}
```

`kilo mcp list` listed the server and actually tried to spawn it, reporting
`MCP error -32000: Connection closed` against the deliberately non-existent script — i.e. the
CLI launched it. Keys are OpenCode's own: `type: "local"`, `command` as a **single argv array**
(not a command string plus args), and `environment` (not `env`).

This is the main functional advantage over the Droid adapter, which ships with no MCP bridge at
all because its config shape could not be confirmed.

---

## What was verified live, and what was not

Kilo on this machine is **installed but has zero credentials** (`kilo auth list` → "0
credentials"). No sign-in was attempted. So:

### Verified against the real 7.7.2 binary (unauthenticated)

| Question | Answer | How it was established |
|---|---|---|
| **Prompt on stdin or argv?** | **stdin** — the safe answer | `echo "..." \| kilo run --format json` read the piped prompt, minted session `ses_f54e81818ffeG52RGsQtmif4uj` and reached the model call, failing only on auth. Nothing was passed in argv. |
| Machine-readable output | Yes, `--format json` | A real `yargs` choice (`"default"` or `"json"`), and it produced genuine structured NDJSON, not a prose instruction to the model. The error event below is real captured output. |
| Session id | `sessionID`, OpenCode's `ses_...` form | Present as a top-level field on a real event. Resumed with `-s`. |
| Working directory | Both — `--dir <path>` flag, and spawn `cwd` | Adapter passes both. |
| Model selection | `-m provider/model`; **310 models listable while signed out** | `kilo models`. |
| Reasoning effort | `--variant` | `kilo run --help`. |
| **Config** | **`KILO_CONFIG` env var, honoured exactly like `OPENCODE_CONFIG`** | A probe file with `{"username":"PROBE_MARKER","permission":{...}}` came back through `kilo debug config` with the marker in place and `permission_origins` attributing the values to `"local"`. The adapter writes a per-turn temp file and **never touches `~/.config/kilo`**. |
| Permission block really governs the agent | **Yes** | `kilo debug agent code` resolves permissions into a flat rule array. With no config there is **no `edit` rule at all** (edit falls under a `"*": allow` wildcard). With `{"permission":{"edit":"deny","bash":"deny"}}`, `edit/*/deny` and `bash/*/deny` rules are **injected and appended last**, after Kilo's ~78 built-in read-only allowances (`cat *`, `ls *`, …) and its default `bash "*" → ask`. |
| Permission enum | `allow` / `ask` / `deny`, **silently enforced** | See the hazard below. |
| MCP config shape | Confirmed (§6) | |

**The silent-drop hazard, verified.** `{"permission":{"edit":"bogus"}}` does not error — the
**entire `permission` block vanishes** from the resolved config, exit 0, no warning. One typo
therefore downgrades an agent to Kilo's permissive defaults while this app still believes it is
restricted. `kiloArgs.test.ts` asserts every emitted value against `KILO_PERMISSION_VALUES` for
exactly this reason; that test is not boilerplate.

The captured unauthenticated error event (real output, truncated):

```json
{"type":"error","timestamp":1789576875322,"sessionID":"ses_f54e81818ffeG52RGsQtmif4uj",
 "error":{"name":"APIError","data":{"message":"You need to sign in to use this model.",
 "statusCode":401,"responseHeaders":{ ...several KB of CSP headers... }}}}
```

The adapter unwraps this to the sentence alone — the raw `data` block carries the full HTTP
response headers, which must never reach a chat bubble.

### NOT verified — no authenticated turn was ever run

1. **A successful turn of any kind**, and therefore the `text` / `tool_use` / `step_finish`
   event payload shapes. Those are taken from `opencode.ts`, which verified them against the
   real OpenCode stream. Kilo is the same engine emitting the same top-level envelope
   (`sessionID` + `part`), and the one Kilo-specific event observed here (`error`) is handled
   explicitly — but the `part` shapes are inherited, not re-observed.
2. **Permission semantics at call time.** Requirement was to test each mode with a turn that
   really writes a file and really runs a shell command. Not possible without credentials.
   Three behaviours are inherited from OpenCode and are the things to confirm:
   - that `"deny"` **removes** a tool from the model's tool list rather than rejecting the call
     (this is what makes `plan` read-only by construction);
   - that `"ask"` is **auto-rejected** headlessly and never reaches a human (this is why
     `"manual"` is not offered);
   - **rule precedence.** The config's deny rules are appended *after* Kilo's default
     `bash "*" → ask` and its read-only allowlist. Last-match-wins would make the deny
     effective; first-match-wins would not. **This was not provable without a live turn and is
     the single most important thing to check.**
3. **Whether Kilo binds an agent's tool set at session creation**, as OpenCode verifiably does.
   The adapter *assumes it does* and starts a fresh session whenever the trust level changes
   (`encodeSessionToken` / `resumableSessionId`). That is the safe direction: the cost is losing
   conversation memory when the user changes trust level; the cost of guessing the other way is
   an agent retaining authority the user revoked. If a signed-in test shows Kilo re-evaluates
   per turn, this can be relaxed deliberately — it must not be relaxed on assumption.

### Recommended smoke test before registering

With any provider signed in (`kilo auth login` — BYOK against an Anthropic/OpenAI/OpenRouter
key works and Kilo takes no markup), in a scratch directory:

1. `plan` — ask it to create `x.txt` **and** run `echo hi`. Expect both refused/unavailable.
2. `acceptEdits` — same turn. Expect the file written, the shell command refused.
3. `bypassPermissions` — same turn. Expect both to succeed.
4. A second turn in the same chat that references the first, to confirm `-s` continuity.
5. Confirm the `solace` MCP tools appear to the model at `bypassPermissions`.

If step 1 or 2 lets a shell command through, the rule-precedence question above resolved the
wrong way and `kiloPermissions` needs pattern-based rules rather than the category map.

### Account requirements

Not enterprise-gated, and **better than Droid's on this axis**: Kilo is free and open source
for individuals, with a documented BYOK path (Anthropic, OpenAI, Google, DeepSeek, OpenRouter,
local Ollama/LM Studio) at **no markup**, plus a free `kilo-auto/free` tier requiring no API key
at all. Paid Kilo Pass credits are additive, not a gate on the CLI. Whether a Kilo account is
strictly avoidable for pure BYOK use is not clearly documented; the observed signed-out failure
("You need to sign in to use this model") was against Kilo's own gateway model, which is the
default — a user with their own provider key should not hit it.

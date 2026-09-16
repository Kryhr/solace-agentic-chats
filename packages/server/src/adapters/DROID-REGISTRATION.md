# Registering `droid` (Factory) as a provider

Everything in this file is an edit to a SHARED file that this agent deliberately did not make,
because sibling agents were adding their own providers to the same files in parallel. Apply
them together.

**Verdict: SHIP, but gated on one authenticated smoke test.** See "What was never verified"
before registering — one claim in this document (the trust mapping) rests on Factory's
documented tier boundaries rather than on observed behaviour, because the machine this was
built on has Droid installed but **not logged in**, and completing a device-auth flow was out
of scope.

---

## 1. `packages/shared/src/index.ts`

Add `"droid"` to the `ProviderId` union (around line 73):

```ts
export type ProviderId =
  | "claude-code"
  | "codex-cli"
  | "gemini-cli"
  | "qwen-code"
  | "copilot-cli"
  | "opencode"
  | "droid"        // <-- add
  | ...
```

`CliProviderId` is derived (`Exclude<ProviderId, "custom" | "local">`) and needs no edit.

Once this lands, delete the `as ProviderId` cast on `droidAdapter.id` in `adapters/droid.ts`
(it is commented there and exists only to keep the build clean before this edit).

## 2. `packages/server/src/adapters/index.ts`

```ts
import { droidAdapter } from "./droid";

const cliAdapters: Record<CliProviderId, ProviderAdapter> = {
  ...
  droid: droidAdapter,
};
```

No `apiAdapters` entry. Factory does expose a `FACTORY_API_KEY`, but it authenticates the same
`droid exec` CLI path — it is not a separate OpenAI-compatible endpoint, so there is no
direct-API adapter to add.

## 3. `packages/server/src/core/permissionCatalog.ts`

```ts
const DROID_MODES: TrustLevel[] = ["plan", "acceptEdits", "bypassPermissions", "auto"];

const CATALOG: Record<CliProviderId, ProviderPermissionInfo> = {
  ...
  droid: { provider: "droid", availableModes: DROID_MODES },
};
```

**`"manual"` is deliberately absent, and this one is firm.** `droid exec` has no path to a
human at all. Droid's interactive / `stream-jsonrpc` surface genuinely does have one — the
shipped binary contains `droid.request_permission` plus internal
`waiting_for_tool_confirmation` and `permission_resolved` notifications — but that is a
bidirectional JSON-RPC protocol this adapter does not speak. Offering "manual" while running
`exec` would promise a human gate that cannot fire.

The doc comment at the top of `permissionCatalog.ts` should gain a Droid paragraph in the same
style as the others:

> Droid: four of the five, via `droid exec`'s tiered autonomy rather than a permission mode.
> "plan" is the CLI's own default with no flag at all, and it is the one level whose
> enforcement is structural rather than classifier-judged — `droid exec --list-tools` reports
> `ApplyPatch` as `status: blocked` at the default level and `allowed` at every `--auto` tier.
> "acceptEdits" is `--auto low` (file creation/modification, no system changes) and "auto" is
> `--auto medium` (adds installs, network fetches, local git writes); these are Factory's own
> documented tier boundaries, not observed behaviour — Droid gates per COMMAND at call time,
> so `--list-tools` cannot prove what a tier blocks. "manual" is omitted because `droid exec`
> has no route to a human. `--auto high` is mapped to by nothing: it permits `curl | bash` and
> `git push --force`, which no trust level here warrants while still being distinguishable
> from bypassPermissions.

## 4. `packages/server/src/core/providerStatus.ts`

```ts
const CLI_BIN:          { ... droid: "droid" }
export const INSTALL_COMMAND: { ... droid: "npm install -g droid" }
export const LOGIN_COMMAND:   { ... droid: "droid" }
const INSTALL_HINT:     { ... droid: "npm install -g droid, then run `droid` once to log in (or set FACTORY_API_KEY)" }
```

`LOGIN_COMMAND` is bare `droid` — sign-in happens from the interactive session via `/login`,
like `claude` and `gemini`, not as a top-level subcommand. There is no `droid login`. The
`FACTORY_API_KEY` alternative is worth keeping in the hint because it is the only headless
path and is self-serve at <https://app.factory.ai/settings/api-keys>.

## 5. `packages/server/src/core/modelCatalog.ts`

Droid's model list is readable from the CLI **without being signed in**, which is unusual and
useful. Validation is local and runs before the auth check, so an invalid `-m` prints the full
built-in catalog:

```
$ droid exec -m __invalid__ < /dev/null     # exits 1; list goes to STDERR
Invalid model: __invalid__

Available built-in models:
  auto, claude-fable-5.1, claude-opus-5, claude-sonnet-5, gpt-6-astra, gpt-5.6-sol,
  gemini-3.1-pro-preview, glm-5.3, kimi-k3, grok-4.6, ... (50 ids on 0.220.0)

No custom models configured. Add them to ~/.factory/settings.json
```

Parsing an error message is uglier than `opencode models`, but it is the CLI's own list and it
works pre-auth. Add a `droidModels()` source alongside `opencodeModels()` that runs
`droid exec -m __invalid__` with stdin closed and reads the comma-separated ids after
`Available built-in models:`.

Two details that were checked rather than assumed, because both would break a naive reader:

- With **stdin closed** the output goes to **stderr only** (stdout is 0 bytes) and the list
  appears **once**. `runForStdout()` as used by `opencodeModels()` would therefore read nothing
  — this source must capture stderr.
- With a **prompt present** on stdin, the same message is emitted **twice**. Closing stdin is
  what makes the output single and predictable, so the recipe above is the one to use.

Exit code is 1 in both cases; that is normal here and must not be treated as the source
failing.

Catalog entry:

```ts
droid: {
  provider: "droid",
  models: droid.models,
  sources: droid.sources,
  sourceError: droid.error,
  // The CLI's own enforced enum, captured from its rejection message:
  //   `droid exec -r bogus` -> "Allowed values: none, dynamic, off, minimal, low, medium,
  //   high, xhigh, max". This is a real yargs/zod choices list, not prose.
  effortLevels: ["none", "dynamic", "off", "minimal", "low", "medium", "high", "xhigh", "max"],
  // `droid exec --help` states the default model is `gpt-5.6-sol`, and the stream-json
  // `system/init` event confirms it live. Safe to assert.
  currentDefaultModel: "gpt-5.6-sol",
},
```

## 6. `connectors.ts` — no edit

The `solace` MCP bridge is **not** registered for this provider, on purpose.

Droid does support MCP (`droid mcp add|list|remove`, and `mcpServers` appears ~148 times in the
shipped binary), but the config shape could not be confirmed. A per-process settings file —
`droid --settings <temp.json> mcp list` with `{"mcpServers":{"solace":{"command":"node","args":[...]}}}` —
reported **"No MCP servers configured."**, i.e. the key was not picked up from that file (the
same probe against Kilo listed the server and actually tried to spawn it). Either `--settings`
does not feed MCP config, or the shape/location differs; `mcp.json` also appears in the binary
as a separate filename.

Per the build rules, the bridge is registered only where the config shape is confirmed, so
`droid.ts` writes no config at all and passes no `--settings`. The consequence is real and
should be stated in the UI if this provider ships: **a Droid agent cannot use the group-chat
MCP bridge or the user's own MCP servers.** It can still take a turn, read, write and run
commands; it just cannot call back into Solace. Closing this needs one authenticated session to
run `droid mcp add` against a throwaway `FACTORY_HOME`/`--settings` and diff what gets written.

---

## What was verified live, and what was not

Droid on this machine is **installed but not signed in** (`droid doctor`: "Auth verification —
no usable credentials found"; `api.factory.ai/api/cli/whoami` → HTTP 401). No login was
attempted. So:

### Verified against the real 0.220.0 binary (unauthenticated)

| Question | Answer | How it was established |
|---|---|---|
| **Prompt on stdin or argv?** | **stdin** — the safe answer | With stdin closed, `droid exec -o json` exits 1 printing *nothing* (it never reaches the auth check — it is waiting for a prompt). With a **200,000-byte** prompt on stdin it runs normally through to the auth failure with no length complaint. No `ENAMETOOLONG` risk. |
| Machine-readable output | Yes, `-o json` | Real envelope captured verbatim (below). Not a "tell the model to answer in JSON" flag — it is the CLI's own structured result. |
| Session id | `session_id`, a plain UUID, in the envelope | Present even on a failed turn. Resumed with `-s <id>`. |
| Working directory | Both — `--cwd <path>` flag, and spawn `cwd` | Adapter passes both. |
| Model selection | `-m`, validated locally pre-auth | Full built-in list readable (see §5). |
| Reasoning effort | `-r`, a real enforced enum | Rejection message names all 9 values. |
| Config | Not needed per-turn | Nothing is written; the user's `~/.factory/settings.json` is never touched. |

The captured `-o json` envelope (real output, unauthenticated run):

```json
{"type":"result","subtype":"failure","is_error":true,"duration_ms":45,"num_turns":0,
 "result":"Authentication failed. Please log in using /login or set a valid FACTORY_API_KEY environment variable.",
 "session_id":"dd44f5b8-fabf-4c98-8403-75cefa8563ae",
 "usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,
          "cache_creation_input_tokens":0,"factory_credits":0}}
```

Only `input_tokens` / `output_tokens` are mapped onto `TurnUsage`. **`factory_credits` is
deliberately NOT mapped to `totalCostUsd`** — a Factory credit is not a dollar, and inventing
an exchange rate would put a fabricated figure in front of the user. No cost is reported for
this provider.

### NOT verified — no authenticated turn was ever run

1. **A successful turn of any kind.** Every observation above comes from a run that ended at
   the auth check. The success envelope's shape is Factory-documented (`"subtype":"success"`,
   `is_error:false`, `result` carrying the answer) and the adapter parses exactly those fields,
   but nobody here has seen one.
2. **The trust mapping — the important gap.** Requirement was to test each mode with a turn
   that really writes a file and really runs a shell command. That was impossible without auth.
   `--list-tools` is *not* a substitute: it reports `Execute - status: allowed` at **every**
   level including read-only, because Droid gates per COMMAND at call time rather than by
   removing the tool. The only structural signal `--list-tools` gives is `ApplyPatch:
   blocked` at the default level and `allowed` at all four `--auto` tiers — which supports
   "plan" being genuinely read-only but says nothing about where `low` / `medium` / `high`
   actually draw the line. **Before shipping, run one authenticated turn per offered mode that
   creates a file and runs `echo`, and correct `droidAutonomyFlags` if the boundaries differ.**
3. **Whether `usage` is populated on success** the way it is on failure (all zeros there).

### Known limitation, accepted deliberately

`-o json` returns **one blob at the end of the turn**: no incremental text, and **no
`tool-use` events**. A Droid agent will appear silent while working and then answer all at
once, and the UI will never show what tools it ran.

The richer-looking alternative was rejected on evidence, not taste: `-o stream-json` really
does emit NDJSON, and its `system/init` event carries `session_id`, `model` and
`reasoning_effort` (captured live) — but **Factory's own documentation marks `stream-json`
DEPRECATED and publishes no schema for it**, and its `assistant` / `tool_call` / `result`
event shapes could not be captured here without auth. Writing a stream parser against event
shapes nobody has ever observed is the exact trap this repo has been burned by before, so the
adapter uses the one structured surface whose envelope was captured verbatim and that Factory
documents as current.

The genuinely right long-term surface is `stream-jsonrpc`, which is current, documented, gives
incremental events **and** carries `droid.request_permission` — which would make a real
`"manual"` mode possible. It is a bidirectional JSON-RPC protocol and a substantially larger
piece of work; it should be its own task, done with a signed-in account.

### Account requirements

Self-serve, **not** enterprise-gated — but **there is no free tier**. Individual plans start at
Pro $20/mo; `FACTORY_API_KEY` is self-serve at `https://app.factory.ai/settings/api-keys`.
Worth surfacing in the UI: unlike every other CLI provider here, a user cannot try Droid
without paying.

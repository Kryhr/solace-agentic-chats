# Registering the Kimi Code adapter

Exact edits for the shared/core files this agent does not own. Everything asserted here was
verified against the installed `@moonshot-ai/kimi-code` **0.43.1**, most of it by real headless
turns (see "How this was verified" at the end).

**Read the trust-level section before applying anything.** Kimi is not shaped like the other
CLIs here, and the naive registration would tell users something false.

---

## 1. `packages/shared/src/index.ts`

Add to `ProviderId` (order matters only for display consistency; keep it with the CLI group):

```ts
export type ProviderId =
  | "claude-code"
  | "codex-cli"
  | "gemini-cli"
  | "qwen-code"
  | "copilot-cli"
  | "opencode"
  | "kimi"
  | "custom"
  | "local";
```

`CliProviderId` needs no change — it is `Exclude<ProviderId, "custom" | "local">`.

## 2. `packages/server/src/adapters/index.ts`

```ts
import { kimiAdapter } from "./kimi";
```

and in `cliAdapters`:

```ts
  kimi: kimiAdapter,
```

No entry in `apiAdapters`: Moonshot has an OpenAI-compatible API, but no API-key variant of this
adapter has been built or run, and offering one unverified would claim support this app does not
have.

**Also remove the cast in `kimi.ts`.** It currently reads:

```ts
  id: "kimi" as ProviderAdapter["id"],
```

Once `"kimi"` is a real `ProviderId`, that becomes plain `id: "kimi",`. The cast exists only so
the adapter compiles before this file is edited; leaving it would hide a genuine type error if
the id were ever misspelled.

## 3. `packages/server/src/core/validateAgentConfig.ts`

```ts
const PROVIDER_IDS: ProviderId[] = ["claude-code", "codex-cli", "gemini-cli", "qwen-code", "copilot-cli", "opencode", "kimi", "custom", "local"];
```

## 4. `packages/server/src/core/providerStatus.ts`

```ts
const CLI_BIN: Record<CliProviderId, string> = {
  // ...
  kimi: "kimi",
};

export const INSTALL_COMMAND: Record<CliProviderId, string> = {
  // ...
  kimi: "npm install -g @moonshot-ai/kimi-code",
};

export const LOGIN_COMMAND: Record<CliProviderId, string> = {
  // ...
  // `kimi login` IS a real top-level subcommand (confirmed in `kimi --help`), but it runs a
  // DEVICE-CODE flow that opens a browser. That is the right command to SHOW a user so they can
  // run it themselves; nothing in this app should ever execute it on their behalf.
  kimi: "kimi login",
};

const INSTALL_HINT: Record<CliProviderId, string> = {
  // ...
  kimi: "npm install -g @moonshot-ai/kimi-code, then run `kimi login` to sign in",
};
```

`isCliProvider` keys off `CLI_BIN`, so it picks this up automatically.

### Not-signed-in detection

An unauthenticated Kimi fails **closed** — it does not start a login flow. Verified: a headless
prompt exits **1** having written to stderr:

```
error: failed to run prompt: No model configured. Run `kimi` and use /login to sign in, then retry; or set default_model in config.toml.
```

With `--output-format stream-json`, stdout still emits the version line
(`{"role":"meta","type":"system.version","version":"0.43.1"}`) before the failure, so an
"it produced output, therefore it worked" check would go green on a signed-out CLI. The adapter
already special-cases the `No model configured` string in its `close` handler.

`kimi --version` succeeds while signed out, so the status panel's version probe alone must not
be read as "ready".

## 5. `packages/server/src/core/permissionCatalog.ts`

**Offer exactly one mode:**

```ts
const KIMI_MODES: TrustLevel[] = ["bypassPermissions"];
```

```ts
  kimi: { provider: "kimi", availableModes: KIMI_MODES },
```

This is the most important decision in the whole registration, and it is not conservatism — it
is the only non-fictional option. Three findings, each verified against the real CLI:

1. **The trust flags cannot be used headlessly at all.** `-p/--prompt` is rejected in
   combination with every one of them:
   - `error: Cannot combine --prompt with --yolo.`
   - `error: Cannot combine --prompt with --auto.`
   - `error: Cannot combine --prompt with --plan.`

   `--plan`, `-y/--yolo` and `--auto` are interactive-TUI-only. The premise that Kimi's trust
   levels "map unusually well" holds for the TUI and does not survive contact with `-p`.

2. **Headless forces full autonomy, unconditionally.** Kimi's prompt-mode session setup calls
   `setMode("auto")` on a fresh session and again on every resume, and its own `--help` defines
   `--auto` as "never interrupts you; everything runs and is decided automatically". Kimi tells
   the model as much: every headless request carries
   `<system-reminder> Auto permission mode is active. Tool approvals will ...`.

   Behaviourally confirmed, not just read: a headless turn asked to write a file **wrote it**,
   and one asked to run a shell command **ran it**, with no human present. So on the question
   the brief raised — OpenCode auto-rejects, Crush auto-approves — **Kimi auto-APPROVES**, and
   there is no default/`-y` distinction to compare, because neither flag is reachable from `-p`.

3. **Permission rules do not claw it back.** A config carrying explicit
   `[[permission.rules]] decision = "deny"` for `Write`, `Bash` and `Edit` was accepted as valid
   by `kimi doctor` — and then ignored. The file was still written and the shell still ran.
   Kimi's `auto-mode-approve` policy short-circuits to "approve" before any user-configured deny
   rule is evaluated.

There is therefore no headless trust gradient, and `"manual"` is doubly impossible: there is no
`--permission-prompt-tool` equivalent to route an approval into this app's UI, and in auto mode
Kimi actively **denies** its own `AskUserQuestion` tool ("AskUserQuestion is disabled while auto
permission mode is active"). An agent set to "stop and ask me" could not ask.

> **The one mechanism that does work, and why it is not used yet.** `[tools] disabled = [...]`
> in `config.toml` genuinely blocks execution even under forced auto — verified: Write and Bash
> each came back `Tool "..." is disabled by the active tool policy`, and **the file was not
> created and the command did not run**. That is a real capability removal, the same shape
> `opencode.ts` relies on.
>
> It is unusable today because of *where* Kimi reads it from. `config.toml` exists at exactly one
> path, `<KIMI_CODE_HOME>/config.toml` — there is no project-level `config.toml` and no
> `--config` flag. And `KIMI_CODE_HOME` relocates the **entire** Kimi home *including credentials*
> (the token store is `join(homeDir, "credentials")`), so pointing it at a per-turn temp dir —
> the trick `gemini-cli.ts` uses, where `GEMINI_CLI_SYSTEM_DEFAULTS_PATH` moves only a settings
> layer — would also hide the user's login and leave the CLI unable to run.
>
> That leaves only rewriting the user's own `~/.kimi-code/config.toml`, which governs every other
> `kimi` run on their machine. This adapter does not cross that line. `kimiToolPolicy()` is
> implemented and tested in `kimi.ts` so that the day Kimi grows a per-invocation config path,
> only the plumbing has to change. **Until then, do not add trust levels to the catalog.**

## 6. `packages/server/src/core/modelCatalog.ts`

There is no `kimi models` command. The honest source is **`kimi provider list --json`**, which
prints the configured providers and model aliases:

```json
{ "providers": { "moonshot": { "baseUrl": "...", "type": "kimi" } },
  "models":    { "k2": { "provider": "moonshot", "model": "kimi-k2-...", "maxContextSize": 131072 } } }
```

The **keys of `models`** are the aliases `-m` accepts. `default_model` in `config.toml` is the
alias used when `-m` is omitted, so it is a real `currentDefaultModel` — unlike most providers
here, this one genuinely is written down.

> ⚠️ **`--json` includes provider `apiKey` values in cleartext.** Parse it for the `models` keys
> only; never log the raw stdout, and never surface it in a source/error string. A signed-out
> machine prints `{"providers":{},"models":{}}` — sourceError should then say to run `kimi login`.

`effortLevels`: **leave empty/undefined.** Kimi has no per-invocation effort or reasoning flag.
Its thinking settings are a `config.toml` section (`[thinking] effort = ...`), which this adapter
does not write. The `[models]` schema has optional `supportEfforts`/`defaultEffort` per alias, so
if effort is ever wanted, read it from `provider list --json` per model rather than hardcoding a
list. The adapter passes no effort flag today.

## 7. Web (`AddAgentModal.tsx`, `ProviderIcon.tsx`)

A `kimi` entry with a display name of **"Kimi Code"** and an icon. Not owned by this agent — flagged
only so the provider is not left unlabelled in the picker.

---

## MCP bridge: confirmed shape, but NOT registered

The brief asked to register the `solace` bridge if the config shape could be confirmed, and to say
so if not. **The shape is confirmed and the bridge still cannot be registered.** Both halves matter:

MCP servers are **not** a `config.toml` section. `[mcp_servers.*]` there is explicitly discarded —
`kimi doctor` reports `Unknown top-level key ignored by the v2 engine: mcp_servers.` They live in
`mcp.json`, read from three layers:

| layer | path |
| --- | --- |
| user | `<KIMI_CODE_HOME>/mcp.json` |
| project (git root) | `<gitRoot>/.mcp.json` |
| project (cwd) | `<cwd>/.kimi-code/mcp.json` |

The file shape (verified live):

```json
{ "mcpServers": { "solace": { "command": "<node>", "args": ["<solaceBridge.mjs>"],
                              "enabled": true, "env": { "SOLACE_AGENT_ID": "..." } } } }
```

`transport` is inferred as `"stdio"` when `command` is present. **This works** — a probe server
registered at the user layer appeared to the model as `mcp__solace__probe_ping`, 26 tools instead
of 25.

Why it is still not wired up:

- The **user layer** lives inside `KIMI_CODE_HOME`, so writing it means writing the user's real
  Kimi home — the same line as §5.
- Both **project layers** are gated by Kimi's workspace-trust check, which headless cannot satisfy.
  Verified: the turn printed
  `Warning: this folder is not trusted; skipped 1 project-level MCP server: solace (...)`
  `Run \`kimi\` here and choose "Trust this folder" to enable them.`
  and the tool never reached the model. Pre-trusting the folder means writing
  `<KIMI_CODE_HOME>/workspace-trust/` — i.e. silently granting a security decision on the user's
  behalf, which is worse than the missing feature.

**Consequence to be honest about in the UI:** a Kimi agent cannot use the group-chat bridge, so it
cannot post to a group, read the roster, or hand work to another agent. It is a capable solo agent
in its workspace and a non-participant in the multi-agent features. If the hub implies otherwise,
that is a lie to the user. The unblock is the same as §5 — a per-invocation config path — or an
explicit, user-facing "trust this folder for Kimi" action that a human actually confirms.

---

## Things about Kimi that do not fit this app's model

- **No usage or cost anywhere.** Kimi's stream-json writer has no branch that emits token counts
  or cost, and a real turn whose upstream response carried a full `usage` block still printed
  none. The adapter emits **no** `usage` event rather than reporting zeros. Per-turn usage will be
  blank for Kimi agents, and that is the truth, not a gap to paper over.
- **No stdin, so an unavoidable prompt ceiling.** See the next section.
- **Text is buffered, not streamed.** The writer accumulates deltas and flushes at tool-call and
  end-of-turn boundaries, so `text` events arrive as a few large blocks. A UI that reads a pause
  as "the agent stopped" will be wrong.
- **Thinking is discarded in JSON mode** (`writeThinkingDelta()` is empty), so no `reasoning`
  event is possible. In text mode it goes to stderr; there is no machine-readable form.
- **Bash output contaminates the JSON stream.** A turn running `echo KIMI_RAN_SHELL` printed a
  bare `KIMI_RAN_SHELL` line on stdout *between* JSON lines. The adapter surfaces unparseable
  lines as text rather than dropping them or letting the parse derail.
- **Sessions are directory-bound.** Resuming from a different cwd is refused outright
  (`Session "..." was created under a different directory.`). Fine today because each agent has a
  stable workspace, but repointing an agent's folder will invalidate its Kimi session.
- **Telemetry is on by default** and is sent to Moonshot's cloud unless `telemetry = false` is set
  in `config.toml` — which this adapter cannot write. Worth telling users, since it is their
  config to change.
- **An unowned surface with real reach:** Kimi ships `CronCreate`/`CronDelete` tools that schedule
  work *outliving the turn*, plus `Agent`/`AgentSwarm` subagents. Under forced-auto these are all
  available and nothing in this app gates them.
- **`kimi acp` is the strategically better transport** — an Agent Client Protocol server over
  **stdio**, which would eliminate the argv ceiling entirely and, because ACP carries permission
  request/response in-protocol, could give a genuine `manual` mode routed into this app's approval
  UI. It was not built: it is a large JSON-RPC surface and could not be verified end to end here
  (and `kimi acp --login` is the device-code flow, which must never be triggered). It is the right
  next investment for this provider.

---

## The argv ceiling — the single most important operational fact

**Kimi has no stdin path for the prompt.** Its only uses of `process.stdin` are the TUI's
raw-mode key reader and the MCP client transport; prompt mode never reads it, and `-p` is a
required-value option so it cannot fall through. So the prompt **must** travel in argv, and Kimi
carries the same `spawn ENAMETOOLONG` exposure as Codex and Copilot.

Measured by binary search against the real binary — **the limit is on the whole command line, not
the prompt**:

| command line | max prompt | fixed overhead | total |
| --- | --- | --- | --- |
| `node main.mjs -p <prompt>` | 32 643 | 121 | **32 764** |
| `node main.mjs --output-format stream-json -S <id> -p <prompt>` | 32 575 | 189 | **32 764** |

33 000 characters throws `spawn ENAMETOOLONG`; 32 600 does not. Because the overhead varies with
the session id, the model alias and the installed node/package path lengths — all per-machine —
the adapter computes the budget from the **actual argv** (`kimiPromptBudget`) and refuses before
spawning, with the real numbers in the message. A raw `ENAMETOOLONG` surfaces as a throw with no
output and no explanation, which is exactly how the original outage presented.

Two further mitigations already in `kimi.ts`:

- It spawns **`node <main.mjs>`**, not the `kimi`/`kimi.cmd` shim, so the command line never goes
  through cmd.exe — where a literal newline silently truncates the rest of the argument. Every
  group prompt is multi-line, so the shim route would corrupt essentially every turn.
- `spawnCli`'s newline guard stays satisfied for the right reason: it inspects what the command
  resolves to, and `node` resolves to `node.exe`, not a shim.

**Callers should treat ~32 KB as a hard per-turn ceiling for Kimi agents** and keep large context
out of the prompt, because there is no stdin to spill into.

---

## How this was verified

Moonshot auth was **never** completed — `kimi login` and `kimi acp --login` were never run, and
the CLI on this machine remains signed out (`kimi provider list` → `No providers configured.`).

Instead, Kimi was pointed at a **local OpenAI-compatible mock provider** on a spare port via a
scratch `KIMI_CODE_HOME`, using its own `type = "openai"` provider support. That made real turns
possible — real tool execution, real session resumption, the real event stream — with no Moonshot
account involved. The user's `~/.kimi-code` was never written to; the scratch home was confirmed
to receive all state.

Verified **live**: flag conflicts; the signed-out failure; forced-auto approving a real file write
and a real shell command; deny rules failing to bite; `[tools] disabled` genuinely blocking both;
the full stream-json vocabulary; MCP registration at user layer and its trust-gating at project
layer; session continuity across three turns; the argv ceiling; and the compiled adapter itself
driven through two turns (turn 2 resumed turn 1, and the model received turn 1's message *and*
reply).

Verified **only by unit test / code reading**: the `kimiToolPolicy` mapping for `acceptEdits` vs
`plan` as *this app's* trust levels (the mechanism is live-verified; the level-to-tool-list
assignment is a judgement call, and unused today anyway), and whether subagents spawned via the
`Agent` tool inherit the tool policy — **not** verified, and worth checking before relying on the
policy for containment.

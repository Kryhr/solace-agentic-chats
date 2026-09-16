# Registering the Continue CLI adapter

`packages/server/src/adapters/continue.ts` and its tests are self-contained. Everything below is a
change to a file **shared by all seven in-flight adapters**, which is why it is written down here
instead of applied — seven agents editing the same six files would conflict on every merge.

Verified against the installed **`@continuedev/cli` 1.5.47** (`cn`) on Windows, 2026-09-16.
Every claim in this document was produced by running the real binary; see "Evidence" at the end.

---

## 1. `packages/shared/src/index.ts`

Add `"continue"` to the `ProviderId` union:

```ts
export type ProviderId =
  | "claude-code"
  | "codex-cli"
  | "gemini-cli"
  | "qwen-code"
  | "copilot-cli"
  | "continue"          // <-- add
  | "custom"
  | "local";
```

`CliProviderId` is `Exclude<ProviderId, "custom" | "local">`, so it picks this up automatically.

**Then delete the temporary cast** in `continue.ts`:

```ts
// before
id: "continue" as unknown as ProviderAdapter["id"],
// after
id: "continue",
```

The cast exists only because this shared line is not applied yet; the comment above it says so.

## 2. `packages/server/src/adapters/index.ts`

```ts
import { continueAdapter } from "./continue";

const cliAdapters: Record<CliProviderId, ProviderAdapter> = {
  // ...existing entries...
  continue: continueAdapter,
};
```

Nothing goes in `apiAdapters`: Continue has no direct-API-key variant here, and offering one that
has never been run would claim support this app does not have.

## 3. `packages/server/src/core/permissionCatalog.ts`

```ts
const CONTINUE_MODES: TrustLevel[] = ["plan", "acceptEdits", "bypassPermissions"];

const CATALOG: Record<CliProviderId, ProviderPermissionInfo> = {
  // ...
  continue: { provider: "continue", availableModes: CONTINUE_MODES },
};
```

Add to the file's block comment:

> **Continue CLI:** three of the five. `plan` → `--readonly`, `bypassPermissions` → `--auto`, and
> `acceptEdits` → `--allow Write --allow Edit --exclude Bash`, each verified by a real turn that
> asked the CLI to write a file. `manual` is omitted because Continue has no external approval
> hook: run headless with no mode flag, a tool needing approval is **auto-cancelled** — the
> transcript records `status: "canceled"` / `"Command blocked by security policy"` and the process
> then exits **0 having printed nothing at all**. That is the same auto-reject trap that keeps
> `manual` off OpenCode, and offering it would promise a human gate that does not exist. `auto` is
> omitted for the reason Gemini's and Copilot's are: there is no classifier-judged middle ground
> between `--readonly` and `--auto`, so it would be a second, more cautious-sounding name for
> `bypassPermissions`.

## 4. `packages/server/src/core/providerStatus.ts`

```ts
// binary name
continue: "cn",
// install hint
continue: "npm install -g @continuedev/cli",
// sign-in hint  -- see the caveat below
continue: "cn",
// combined hint
continue: "npm install -g @continuedev/cli, then run `cn` once to configure a model in ~/.continue/config.yaml",
```

⚠️ The binary is **`cn`**, not `continue`. There is no `cn login` subcommand (`cn --help` lists only
`ls`, `checks`, `review`). A Continue **hub account is not required**: every turn verified here ran
with no hub sign-in at all, against a model declared directly in `~/.continue/config.yaml`. What an
agent actually needs is a config with a working `models:` entry — so the hint points at that, not
at a login command that does not exist.

**"Not signed in" / not configured is not usefully reported by this CLI.** With no usable model it
prints, on **stdout**, and still **exits 0**:

```
{"status":"error","message":"The request failed and the interceptors did not return an alternative response"}
{"status":"error","message":"404 model 'AUTODETECT' not found"}
```

The first of those is what an unconfigured install produces and it says nothing a user could act
on. `continue.ts` therefore does not try to pattern-match it; it reports a turn that produced no
text and no tool call with its own message naming `~/.continue/config.yaml`.

## 5. `packages/server/src/core/modelCatalog.ts`

**Add an entry that offers no model list, and no effort levels.** Do not add a
`cliModelSources.ts` parser for this provider.

`--model` **cannot select a configured model.** Verified: with two models (`alpha`, `beta`) in
`config.yaml` pointing at two different local endpoints, `cn --model beta` still hit `alpha`'s
endpoint. `--model` only *adds* a model from the Continue hub, and an unresolvable slug
(`--model anthropic/claude-sonnet-4`, unauthenticated) is **silently ignored** rather than
rejected. The first `chat`-role model in the active config always wins.

So the model is whatever the user's `config.yaml` names, and listing model ids the app cannot
actually select would be offering a control that does nothing. `buildContinueArgs` never passes
`--model`, and `continueArgs.test.ts` pins that.

There is also no `cn models` subcommand and no account-scoped roster on disk, so there is no
authoritative local source to read a list from even if it were selectable.

## 6. `packages/server/src/core/connectors.ts`

Add a connector row so the provider is installable/detectable from the UI, matching the shape the
other CLI rows use: id `continue`, binary `cn`, install `npm install -g @continuedev/cli`.
I could not verify the exact field names without reading a file I do not own — **copy the
`copilot-cli` row's shape** and substitute the three values above.

---

## What is NOT implemented, and why

| Not implemented | Why |
| --- | --- |
| Per-invocation model selection | `--model` cannot select among configured models (§5). Would require rewriting the user's `config.yaml`, which needs a YAML parser `@solace/server` does not have. |
| Live streaming of text / tool calls | Continue has no structured output stream (see below). Events are reconstructed from the session transcript after the process exits, so they land at end of turn. Ordering is still correct (tool-use → text → usage). |
| Cost reporting (`totalCostUsd`) | Continue reports `cost_cents` per message and `totalCost` per session, but both were `0` for a locally-configured model. Emitting `0` would tell every non-hub user their turns were free. |
| `manual` and `auto` trust levels | §3. |
| MCP bridge when the user's config already declares `mcpServers:` | Appending would create a duplicate top-level YAML key. The turn runs on the user's own config with no bridge rather than risking a config an agent needs to reach a model at all. |
| User MCP servers at `plan` trust | **Continue's permission modes do not gate MCP tools at all** — see the safety note below. |

### ⚠️ Safety finding: `--readonly` does not gate MCP tools

Verified directly: under `--readonly`, a built-in `Write` call came back `status: "canceled"` with
no file created — while **in the same mode an MCP tool call executed**, returned its result, and
the turn ran a second model round-trip on it.

So `--readonly` constrains Continue's own built-in tools and nothing else. `continue.ts` therefore
does not register the user's own MCP servers at `plan` trust (`stageUserServers()`), because an
agent the user set to read-only would otherwise be able to call a third-party tool whose blast
radius this app cannot inspect, with no gate and nothing in the UI saying so. The `solace` bridge
is still registered at every level — teammate chat is bookkeeping with no effect on the user's
machine, and its one privileged tool (`get_secret`) is gated in the server's own
`/internal/solace/secret` route rather than by a tool list, which is exactly why that design holds
up here, where the tool list gates nothing.

**This is worth raising with the other adapter agents**: it is a property of Continue, but the
"register the server, let the permission mode gate it" assumption is shared across adapters.

---

## Evidence for the design decisions in `continue.ts`

**Prompt goes on stdin.** `echo "..." | cn -p` works and is Continue's own documented example; its
error message names stdin as the alternative to a positional prompt. No `ENAMETOOLONG` risk, and no
truncation at the first newline by the Windows `cmd.exe` shim.

**`-p` must be LAST.** `cn -p --format json` fails outright with *"A prompt is required when using
the -p/--print flag"*, while `cn --format json -p` reads stdin fine. Putting `-p` before another
option breaks Continue's own stdin detection. Reproduced repeatedly.

**`--format json` is not a machine-readable protocol — do not use it.** It appends a system
instruction telling the *model* to reply in JSON ("You are operating in JSON output mode... the
entire response must be parseable JSON" — read straight off the wire from the outgoing request
body), then wraps the reply, stamping
`{"note":"Response was not valid JSON, so it was wrapped in a JSON object"}` when it does not
comply. It carries **no tool calls, no usage, no session id**, and it corrupts the answer text.
Plain `-p` returns the answer verbatim.

**The session transcript is the only structured data source.**
`<CONTINUE_GLOBAL_DIR|~/.continue>/sessions/<id>.json` carries `sessionId`, `workspaceDirectory`,
per-message `usage` (`prompt_tokens`, `completion_tokens`, `model`, `cost_cents`), and
`toolCallStates` with `status`, `parsedArgs` and `output`. This is where tool calls, tokens and the
resolved model come from.

**Session continuity.** First turn: `CONTINUE_CLI_TEST_SESSION_ID=<uuid>` forces the id so the
transcript path is known up front. Later turns: `--fork <id>` — verified to send the complete prior
exchange up to the model. `--fork` mints a **new random id** and **ignores**
`CONTINUE_CLI_TEST_SESSION_ID`, so the adapter recovers the new id by diffing the sessions
directory and matching `workspaceDirectory`. `--resume` is deliberately unused: it resumes whatever
the *last* session was, so two Continue agents in one workspace would resume each other's.

**Working directory.** There is no `--cwd` flag; a session's `workspaceDirectory` is literally
`process.cwd()`, so the spawn `cwd` is the only thing that sets it.

**MCP config shape (confirmed live, including `env`).** A top-level `mcpServers:` list in the
*active* config:

```yaml
mcpServers:
  - name: solace
    command: node
    args: ["C:\\...\\solaceBridge.mjs"]
    env:
      SOLACE_AGENT_ID: agent-1
```

A `--verbose` run then logs the tool inside its own `Tools prepared` list, and the `env` map reaches
the server process verbatim. Continue names MCP tools **flat** (`post_to_group`), not
`mcp__solace__post_to_group`.

Local block files are **not** auto-loaded: `<globalDir>/mcpServers/*.yaml` was ignored (the tool was
absent from `Tools prepared`). Only `mcpServers:` inside the active config works — which is why the
adapter stages a per-turn config copy.

**The user's config is only ever READ.** The per-turn config is the user's `config.yaml` copied
byte-for-byte into a fresh temp dir with our block appended, passed via `--config`, and deleted when
the turn ends. Note that merely *running* `cn` creates `~/.continue/permissions.yaml` (empty
scaffold) if absent — that is the CLI's own doing, not this adapter's.

**Continue's built-in tool names** (from `Tools prepared`, 1.5.47): `Read`, `Write`, `List`, `Bash`,
`Fetch`, `Checklist`, `CheckBackgroundJob`, `AskQuestion`, `Edit`, `Exit`, `Skills`. These are the
exact spellings `--allow`/`--exclude` expect; a typo is silently meaningless rather than an error.

**Exit codes are not a failure signal.** `cn` exits **0** even when the run failed (a bad model
config printed `{"status":"error",...}` on stdout and exited 0) and also when a turn was fully
cancelled by the permission mode (printing nothing at all).

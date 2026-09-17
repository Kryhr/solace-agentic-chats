# Persistent sessions — what was driven, and what is still a guess

ROADMAP v2.0 asks for one thing: an agent that can be spoken to without its process being
respawned. This directory is that transport. This file is the evidence behind every claim it
makes, and the reason every provider is currently switched **off**.

Written 2026-09-17 against this machine. Everything below is raw observation, not summary.

## The answer in one line

**Yes — an agent can now receive a message without its process being respawned, and it was
watched happening end to end against `opencode acp`.** No provider is switched on, for two
different reasons, both recorded below. The seam, both transports, the pool and 65 tests land;
enablement is one boolean per provider, guarded by a test that has to be edited deliberately.

## What each provider's state actually rests on

| provider | mode | driven live? | enabled | why not |
|---|---|---|---|---|
| OpenCode | ACP over stdio (`opencode acp`) | **fully, end to end** | no | its ACP session cannot carry a trust level |
| Claude Code | `--input-format stream-json` | framing yes, model output no | no | OAuth expired on this machine |
| Kimi | ACP over stdio (`kimi acp`) | handshake only (2026-09-16) | no | account out of quota |
| Gemini | ACP over stdio (`gemini --acp`) | handshake only, captured | no | not signed in |
| Qwen | ACP over stdio (`qwen --acp`) | handshake only, captured | no | not signed in |

---

## OpenCode — the one that proves the transport works

`opencode acp` 1.18.31, free model `opencode/mimo-v2.5-free`, driven through this repo's own
`AcpPersistentSession` via `fixtures/probeAcpLive.mts`. Raw, trimmed only of the reasoning stream:

```
== opened, pid=24208, acp session=ses_f4f7ef88dffex8ylNVFPR6Su6H ==

== prompt 1 ==
  [session] ses_f4f7ef88dffex8ylNVFPR6Su6H
  [text] ONE
pid after prompt 1: 24208 (alive=true)

== prompt 2, pushed into the SAME process and the SAME session ==
  [reasoning] The user asked me to reply with exactly "ONE" previously. Now they ask what word
              I said. Answer in one word.
  [text] ONE
pid after prompt 2: 24208 (alive=true)
acp session after prompt 2: ses_f4f7ef88dffex8ylNVFPR6Su6H

== prompt 3, cancelled mid-turn by protocol ==
  [text] 1
  -> sending session/cancel
  -> accepted: true
  [text] 2 3 4 ... 10
  [cancelled]
pid after the cancel: 24208 (alive=true)

== prompt 4, after the cancel, same process ==
  [text] FOUR
pid after prompt 4: 24208 (alive=true)

== closing ==
alive after close: false
```

What that establishes, item by item:

- **One pid and one session id across four prompts.** Nothing was respawned between them.
- **Context survived between turns with no resume dance.** Prompt 2 answered *out of prompt 1's
  context* — "The user asked me to reply with exactly ONE previously" — which is the claim that
  matters and the one a pid alone does not prove.
- **`session/cancel` landed mid-turn**, the turn ended `cancelled`, the process survived, and the
  next prompt answered normally on it. An interrupt is a protocol call, not a kill.
- **`agent_thought_chunk` and `agent_message_chunk` read back as `reasoning` and `text`** —
  separately, never conflated.
- **Graceful close works**: the process is gone afterwards.

A second probe confirmed the group-chat bridge survives the move. Asked to list its tools, the
live ACP agent answered:

```
- bash, edit, glob, grep, read, skill
- solace_announce, solace_block_on, solace_claim_files, solace_get_secret,
  solace_list_agents, solace_post_contract, solace_post_to_group, solace_release_files
- task, todowrite, webfetch, websearch, write
```

So `session/new`'s `mcpServers` really does start the stdio bridge, and an agent on the live
transport keeps `post_to_group` and the coordination tools.

### Why it is still off

Asked to write a file, `opencode acp` **wrote it and never sent `session/request_permission`**:

```
pid 20760
[tool] write
[text] DONE.
```

And its `session/new` advertises no `modes` and exactly one config option:

```
"id":"model","name":"Model","category":"model"
```

There is therefore **no way to express a trust level over its ACP surface**. Enabling this would
silently promote every OpenCode agent — including ones the operator set to `plan` or `manual` — to
unrestricted writes, while the UI went on showing the trust level they chose. That is a worse
outcome than a slower transport, so it stays off until a trust level can be carried.

---

## Claude Code — framing proven, content not

`claude.exe` 2.1.238, driven through this repo's `ClaudeStreamJsonSession` via
`fixtures/probeClaudeLive.mts`. The flags, verbatim from the run:

```
["-p","--session-id","2830447f-…","--input-format","stream-json","--output-format","stream-json",
 "--verbose","--permission-mode","plan","--mcp-config","{…solace…}","--strict-mcp-config",
 "--allowedTools","mcp__solace__post_to_group,…","--model","haiku"]
```

```
== opened, pid=22892 ==
== message 1 ==   [text] Failed to authenticate: OAuth session expired and could not be refreshed
pid after message 1: 22892 (alive=true)
== message 2, pushed into the SAME process ==
pid after message 2: 22892 (alive=true)
== message 3, interrupted mid-turn by protocol ==
  -> sending control_request interrupt
  -> acknowledged: true
pid after the interrupt: 22892 (alive=true)
== message 4 ==   pid after message 4: 22892 (alive=true)
== closing ==     alive after close: false
```

**Proven:** the CLI accepts `--input-format stream-json`, stays up across four messages on one pid
and one session id, produces a terminal `result` frame per message, answers
`{"type":"control_request","request":{"subtype":"interrupt"}}` with a real `control_response` of
subtype `"success"`, and exits gracefully when stdin closes.

**Not proven:** anything the model says. Every turn failed at the auth layer. This is a machine
fact, not a transport defect — a plain `claude -p` fails identically:

```
$ echo "Reply with exactly the word PING." | claude -p --model haiku
Failed to authenticate: OAuth session expired and could not be refreshed
```

Re-authenticating was out of scope (no login flows). The frames a working account produces —
interleaved `tool_use`, partial messages, mid-turn `rate_limit_event` — are precisely the ones an
auth-failure turn never emits, so switching this on would be claiming the half nobody has seen.

**To enable:** sign in, run the probe, watch a real answer arrive on the second message, then set
`CLAUDE_STREAM_JSON_ENABLED = true` in `index.ts` and fix the seam test that asserts it is off.

### Protocol details read off the binary, not from prose

The CLI's own description of its input stream, verbatim from `claude.exe`:

> exactly one StdinMessage per line, as a single JSON object — user messages that start turns,
> control requests the client originates, control responses answering the CLI's requests,
> cancellations and keep-alives. … Closing the stream tells the CLI to finish the current turn and
> exit.

That last sentence is why `close()` ends stdin first and only reaches for `killCliTree` after a
grace period.

`--replay-user-messages` exists and would be a free acknowledgement that a message landed. It is
deliberately **not** used: the echoed frame is shaped like an assistant frame (`message.content[]`
with a text block), so the shared stream reader would post the agent's own incoming prompt into
the chat as if the agent had said it.

---

## Kimi, Gemini, Qwen — handshake is fact, the rest is inference

All three speak the same ACP as OpenCode, and the same code drives all four (they differ only in
argv: `kimi acp`, `gemini --acp`, `qwen --acp`). Their `initialize` responses are captured
verbatim in `../acp/fixtures/` and are replayed byte-for-byte by `acpSession.test.ts`, so the
capability handling is checked against real agent answers rather than invented ones.

Past the handshake, each refuses for an account reason:

- **Kimi** — `-32000 Authentication required: 403 You've reached your monthly usage limit…`
  The 2026-09-16 capture does show **two `session/prompt` calls against one live process**, which
  is real evidence for the shape; but both were slash commands and no prompt ever reached a model.
- **Gemini** — `-32000 Gemini API key is missing or not configured.`
- **Qwen** — `-32000 Authentication required: Use Qwen Code CLI to authenticate first.`

So for these three: the transport is the same code that was watched working; the accounts are not
available. "This code is proven and these accounts are not" is a different statement from "this
provider works", and only the first one is being made.

---

## Running the probes again

Both are fixtures, never tests — `node --test` must not spend a subscription or need a network.

```
PORT=4399 node --import tsx src/adapters/persistent/fixtures/probeClaudeLive.mts
PORT=4399 PROBE_MODEL=opencode/mimo-v2.5-free \
  node --import tsx src/adapters/persistent/fixtures/probeAcpLive.mts
```

`PORT` is a spare one on purpose. The solace MCP bridge the CLI spawns calls back to
`SOLACE_SERVER_PORT`, and 4310/4320 are the operator's live instances.

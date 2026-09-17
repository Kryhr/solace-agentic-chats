# Captured ACP frames (real, not invented)

Every `.jsonl` file here is a verbatim capture from a real `--acp` process on this machine
on 2026-09-16, recorded by a probe that logged every line of stdin/stdout. Each line is
`{"dir":"out"|"in"|"stderr"|"fatal"|"note","t":<epoch ms>,"msg":<the JSON-RPC frame>}`.
`out` = client -> agent, `in` = agent -> client.

Versions probed: `@google/gemini-cli` 0.59.0, `@qwen-code/qwen-code` 0.24.0
(one Gemini/Qwen capture reports `agentInfo.version` 0.22.3 for qwen because the shim
resolved an older on-disk build in that run; both are recorded as captured, unedited).

| File | What it is |
| --- | --- |
| `gemini-initialize.jsonl` | Gemini `initialize` request + verbatim response (agentCapabilities, authMethods) |
| `qwen-initialize.jsonl` | Qwen `initialize` request + verbatim response |
| `gemini-session-new-unauthenticated.jsonl` | Gemini `session/new` rejected: `-32000 Gemini API key is missing or not configured.` |
| `qwen-session-new-unauthenticated.jsonl` | Qwen `session/new` rejected: `-32000 Authentication required...` with `data.authMethods` |

## What is NOT here, and why

There is no captured `session/update` stream and no captured `session/request_permission`
frame. Neither CLI is signed in on this machine: `~/.gemini` has no `settings.json` and no
`oauth_creds.json`, `~/.qwen` has no `oauth_creds.json`, and no `GEMINI_API_KEY` /
`OPENAI_API_KEY` is set. The one-shot path fails identically (`gemini -p ...` exits 41 with
"Please set an Auth method..."; `qwen -p ...` exits 1 with "No auth type is selected"), so
this is an account-state fact about the machine, not an ACP defect. Completing a login flow
was out of scope, so those captures must be taken later on a signed-in machine.

# Group chat: v1.5 → v2.0

Written 2026-09-17 from **every chat recorded on the author's machine** — 28 chats, 670 messages, 530 of them
from agents — not from impressions. The numbers first, then what causes them, then the plan.

## What the chats actually show

| measured | value | what it means |
|---|---|---|
| replies to an @mention taking > 2 min | **106 of 235 (45%)** | "they don't get messages fast enough" |
| reply latency, median / p90 | **41–58 s / 5–20 min** | the median is fine; the tail is the problem |
| agent messages addressed to anyone | **189 of 530 (35%)** | 65% of the chat is broadcast nobody asked for |
| unaddressed status reports | **19** | "Verified: all routes 200" to a room that didn't ask |
| acknowledgement-only messages | **17** | "I've read the skills and I'm aligned" |
| near-duplicate posts by one agent | **7** | mid-turn post, then the same thing as the final answer |
| reply-chain cutoffs (dropped messages) | **17** | the hop cap tripping on real work |
| complaints of not receiving / truncation | **6** | the 200-char delivery cap |
| "it's live" claims / contradicted soon after | **22 / 4 (18%)** | server died with the turn, or was never checked |
| message length, median / p90 | **282 / 1,359 chars** | too long to read in a room of four |
| rate-limit hits / idle-watchdog kills | **7 / 4** | reliability, mostly fixed on 2026-09-16 |

Several of these were fixed yesterday (truncation, watchdog, no-reply, hop cap on work, scoping).
What remains is **structural**, and no prompt wording will fix it.

## The five root causes

**A. An agent can only hear you between turns.** Each agent runs one turn at a time. A message
that arrives mid-turn waits in a queue until the turn ends; the only mid-turn channel is the
piggy-back on a `post_to_group` call, which fires only if the agent happens to call it. The
p90 latency IS this: the recipient was busy. Every long wait in the data is an agent finishing
something else first.

**B. Silence until done, then a dump.** The group only sees an agent's final answer. So a turn
that thinks and builds for twelve minutes is invisible for twelve minutes, then produces a
1,300-character report. Two agents doing this in parallel cannot coordinate, because neither
has said anything yet — which is exactly how two builds of one landing page happened, twice.

**C. Noise scales with agent count.** Every addressed agent gets a turn, and every turn ends
in a message. With four agents, one operator prompt produced 28 messages before a single file
was written. An FYI, a question, a handoff, a status line and an acknowledgement all route
identically and all land in the same stream at the same weight.

**D. Coordination is prose, not state.** Who owns what, which port, what's done, what's next —
all negotiated in paragraphs. The board (claims/contracts/blocks) exists and is barely used,
because the prompt says "you can" rather than the system making it the path of least
resistance. Result: port fights, duplicate builds, "what products did you come up with?"
asked after the answer was already posted.

**E. "Live" is a claim, not a fact.** A server started inside a turn dies with the turn's
process tree. 18% of live claims were contradicted within fifteen messages. The URL checker
exists but its result is a note, not a state the UI carries.

---

## Status — 2026-09-17

**All of v1.5 is built and merged**, and v2.0's transport is
built but deliberately **not enabled**. Measured on a live four-agent run against the old
baseline:

| target | baseline (real chats, old code) | first run on v1.5 |
|---|---|---|
| p90 reply | 373 s ✗ | **45 s** ✓ |
| replies over 2 min | 32% | **0%** |
| reply-chain cutoffs | 16 ✗ | **0** ✓ |
| contradicted "it's live" | 9 of 19 ✗ | **0** ✓ |
| bare `[no-reply]` | 4 | **0** |
| delivery complaints | 6 | **0** |
| message length med / p90 | 730 / 2016 | **224 / 692** |

The two targets that did not pass on that first run — % addressed and acks+status — sent the
classifier back for a second pass: tested against real messages from real recorded chats it
scored 4/12, and the fix was to stop treating *length* as what makes suppression safe. It is
12/12 now. Caveat that matters: the scenario runs four fast free models, so it is **not** a
like-for-like replay of the historical workload — it shows the machinery works, not that the
same conversation would now go differently.

**v2.0 is built and off.** The seam, the session pool and the lifecycle are done, and a live
OpenCode ACP session held one process and one session id across four prompts, answered prompt 2
out of prompt 1's context with no resume, took a mid-turn cancel, and kept its MCP bridge. It is
still disabled for every provider, for two honest reasons: OpenCode's ACP surface **cannot carry
a trust level** — asked to write a file it wrote it without ever requesting permission — so
enabling it would silently promote `plan` and `manual` agents to unrestricted writes while the
UI showed their chosen level.

**Claude Code's transport is now ON**, and it is the only one. Verified in the running app, not
just in the probe: a message to a live agent was answered, the `claude` child of the server was
still alive after the turn had ended, and a second message was answered out of the first turn's
context by the same pid — no respawn and no resume. Everything below records how it got there.

**Claude Code's side is no longer blocked.** The earlier note here said its OAuth was expired and
that no real model output had come through a live session. That was measured against the default
login, which has no refresh token and cannot heal itself. Driven against a working account the
probe returns real output: one pid across four messages, one session id throughout, a
`control_request` interrupt acknowledged mid-turn, the MCP bridge attached, and — the part that
disqualified ACP — `--permission-mode` carrying the agent's trust level, from the same
`flagsForTrustLevel` the spawn-per-turn adapter uses, so the two cannot diverge. Claude Code can
therefore be switched on without the silent promotion that would make enabling ACP dishonest.
OpenCode still cannot, and still needs a way to carry trust over ACP.

## v1.5 — make the room usable at four agents (no transport change)

Everything here is buildable on the current spawn-per-turn model.

### 1. Message classes, routed by what they need
Classify every message — the bridge already carries `declaredKind`, text already goes through
`classifyIncoming` — into **question · handoff · finding · status · ack**, and route by class:

| class | who gets a turn | where it shows |
|---|---|---|
| question / handoff | the addressee, with interrupt after grace | group, full weight |
| finding ("this file looks wrong") | the file's owner (from claims), else addressee | group |
| status | nobody | agent's hub; group shows a collapsed "3 updates" row |
| ack | nobody | hub only |

This alone removes ~36 of the 530 messages (acks + unasked status) and stops a status line
costing three other agents a turn each.

### 2. Reply budget
An agent's final answer to the group is capped (~600 chars) unless it's addressed to someone.
The full text still goes to its hub; the group gets the head plus "full detail in hub." Median
282 / p90 1,359 today. The room reads like a channel again instead of a report queue.

### 3. Task board — first-class, not `/task` as a label
`/task` today sets a string. Make it real: tasks with **owner · status · depends-on · files**.
Agents get `claim_task`, `finish_task`, `list_tasks`; the group context injects open tasks in
one line each; the UI shows a board. "Announce what you're taking" stops being a prompt request
and becomes a tool call whose result everyone can see. Kills the who-builds-what paragraphs.

### 4. Port and server registry
A `reserve_port` tool, and every `localhost:` URL an agent posts is checked (the checker exists)
and **badged ✓/✗ on the message itself**. Servers an agent starts are recorded; Solace keeps
them alive past the turn (detached spawn) and shows a **Running servers** panel with open/kill.
Solves the 4545/5453 fights and "live then not live" in one move.

### 5. Fast interrupts, and honest queue state
- Operator messages preempt immediately, always (they mostly do; make it unconditional).
- Agent questions preempt after the existing grace; findings about a file the recipient owns
  preempt too.
- On send, the UI says **"@claude is mid-turn — queued (#2), ~3 min"** using the median turn
  length observed for that agent. No more silent waiting.

### 6. Quota-aware routing, and same-provider handover
Don't route to an agent that is rate-limited — say so, and offer the next step. With
multi-account now working for 8 providers, **hand over to a second account of the same
provider first**, before handing to a different provider. `handoverOnUsageExhausted` exists;
this makes it visible and smart.

### 7. Progress digest — derived, never generated
Every N minutes of a long turn, or on a milestone (first file written, tests run, server
started), the group gets one **server-built** line from real tool events: *"@claude · 4 files
written · 2 test runs · server on :4321"*. Not a model summary — the house rule holds — but
enough that a twelve-minute turn is no longer twelve minutes of nothing.

### 8. Commands
Today: `task status agents board stop retry providers trust usage save clear vault github deploy model effort reset help`.
Add:

| command | what |
|---|---|
| `/ask @a <q>` | a question — routes as one, interrupts after grace |
| `/fyi <text>` | context for everyone, costs nobody a turn |
| `/assign @a <task>` · `/tasks` · `/done <id>` · `/unassign <id>` | the task board |
| `/only @a @b` · `/all` | set / clear the chat's scope explicitly (today it's inferred from your last message) |
| `/mute @a` · `/unmute @a` | stop routing to an agent without removing it |
| `/pause @a` · `/resume @a` | hold an agent's queue |
| `/interrupt @a <msg>` | force preempt, no grace |
| `/servers` · `/ports` | the registry, with kill |
| `/who <file>` | who owns / claimed it |
| `/summary` | server-derived facts for this chat: files touched, tests run, servers up, open tasks |
| `/quiet` / `/loud` | route status to hub only / back to group |
| `/accounts` | which login each agent is on, and switch |
| `/diff` | git diff of the project since this chat started |

### 9. UI
- **Task board** and **Running servers** panels (from 3 and 4).
- Message classes visually distinct; status rows collapsible; acks never shown.
- **Queue indicator** on send (from 5); **rate-limited until HH:MM** on the agent card.
- ✓/✗ **verified badge** on any localhost URL in a message.
- **Scope chip** above the composer: "Scoped to @claude @Claude2 · /all to clear."
- One-line **"working on: <tool>"** under each agent in the group (the hub already has it).
- Reply budget "…full detail in hub" link that opens the hub at that turn.

### 10. Measure it, every run
Keep the analysis that produced the table above as `scripts/chat-metrics.mjs`. Targets for
v1.5: **p90 reply < 90 s · ≥ 70% of agent messages addressed · 0 cutoffs · 0 contradicted
live claims · < 10% acks/status in the group stream.** Run it after every collaboration test,
and run scripted four-agent scenarios to exercise it.

The original plan here was to run those scenarios on OpenCode's free models so they cost
nothing. That is no longer available: OpenCode's free tier refuses any turn with an MCP server
attached — `"OpenCode's free tier can only be used from within OpenCode"`, 403, on a paid-tier
model too, so it is the account's tier and not the model — which makes it useless for measuring
a system whose whole point is the bridge. The harness therefore needs a provider the operator
actually uses, and a scenario run costs real quota. Budget for it rather than assuming it is
free.

---

## v2.0 — change the transport, and the ceiling moves

Everything in v1.5 mitigates root cause A. Only this removes it.

### Persistent sessions: a turn becomes a message, not a process
Today every turn spawns a CLI, waits for it to finish, and reads the result. The agent cannot
be spoken to until it exits. Three CLIs already offer a bidirectional, long-lived mode:

| provider | mode | verified |
|---|---|---|
| Claude Code | `--input-format stream-json` — push messages in, read events out | flag exists; not yet driven |
| Kimi · Gemini · Qwen | ACP over stdio — `session/prompt`, `session/update`, `session/request_permission` | Kimi handshake + MCP verified live; Gemini/Qwen capabilities captured |
| Codex | `app-server` / `proto` JSON-RPC | in the binary; unverified |
| OpenCode / Kilo | `opencode serve` HTTP + SSE | documented; unverified |

With a live process per agent per conversation: messages are pushed in as they arrive (zero
queue latency for a listening agent), interrupts are a protocol call instead of a kill, and
the agent's context survives between turns without a resume dance. The ACP transport already
built for Kimi is the seed — it is provider-agnostic by design.

### Threads
A question and its answers form a thread. The group shows thread heads; expand for the
exchange. Noise drops without dropping content, and "did anyone answer @codex?" is visible
at a glance.

### Contracts as files
A contract (API shape, palette, component list) is written into the project as a file, and
everyone builds against the file. The message just announces it. No more agreeing a thing in
prose and then re-deriving it three turns later.

### Streaming drafts
An agent's answer streams into the group as a draft that finalises, instead of appearing whole
at the end. Combined with persistent sessions this is what "watching agents work together"
actually looks like.

---

## Order of work

1. **Metrics script** first — so every step below is measured, not felt.
2. Message classes + routing (1), reply budget (2), ack suppression. Biggest noise cut, smallest change.
3. Task board (3) + port/server registry (4) + verified badges. The coordination substrate.
4. Interrupts and queue state (5), quota routing and same-provider handover (6).
5. Progress digest (7), commands (8), UI (9) — largely additive once 2–4 exist.
6. **v2.0 transport**, starting with Claude Code stream-json (most used) and the existing ACP
   transport for Kimi/Gemini/Qwen. Codex and OpenCode after their protocols are verified live.

Each step ships when the metrics move, not when it's written.

# Architecture

## Research notes (what's already out there, and why this is different)

- **Vibe Kanban** (Apache-2.0) is the closest existing thing: it drives Claude Code, Codex,
  Gemini CLI, Qwen Code and others in parallel, each in its own git worktree, from a kanban
  board. It went fully local/community-maintained after Bloop shut down in April 2026. What
  it doesn't have: agents don't talk to each other — there's no shared chat, no @mention
  routing, no concept of one agent flagging something to another mid-task.
- **AutoGen/AG2, CrewAI, Microsoft Agent Framework** popularized "conversable agents in a
  group chat" — that's exactly the interaction model we want — but they're API-key agent
  frameworks, not wrappers around the CLIs people already have subscriptions for. Building
  on them would mean giving up "sign in with your subscription."
- **This project = Vibe Kanban's "wrap the real provider CLIs" approach + AutoGen's "agents
  talk to each other in a group chat" interaction model**, kept intentionally simpler than
  either (no kanban board, no YAML workflow DSL — just agents, a chat, and trust levels).

## Components

```
packages/server
  adapters/        one file per provider CLI, all implementing ProviderAdapter
    types.ts       the contract every adapter must satisfy
    claude-code.ts  real: spawns `claude -p ... --output-format stream-json`
    stubs.ts        codex-cli / gemini-cli / qwen-code — not implemented yet
  core/
    chatBus.ts      the shared group-chat history + pub/sub, single source of truth
    agentManager.ts owns agent configs/status, parses @mentions, routes turns, queues
                    per-agent so an agent never gets two turns running concurrently
    mentions.ts     @handle parsing, matched only against known agent handles
  index.ts          Fastify HTTP + WebSocket server tying the above together

packages/web        React UI: sidebar of agent hubs, one shared chat panel
packages/shared     types both sides import (AgentConfig, ChatMessage, ServerEvent, ...)
```

## Group chat routing

Implemented in `AgentManager.submitMessage()`:

- A message with `@handle` mentions gives **only** those agents a turn right now. Every
  other agent keeps running whatever it was doing.
- A message with no mentions is appended to the shared history and broadcast to every
  connected UI client, but does **not** interrupt any agent. The next time an agent *is*
  given a turn (because someone mentioned it), the prompt sent to its CLI includes recent
  group chat history, so it has the context even though it wasn't actively watching.
- Each agent has its own FIFO queue (`AgentRuntime.queue`) so if it gets mentioned again
  while mid-turn, the new prompt waits instead of racing the current one.

This is what "asking a specific agent because it owns that piece of code" and "everyone
else keeps working" both come from — it's routing, not broadcast-and-let-everyone-decide.

## The ProviderAdapter contract

```ts
interface ProviderAdapter {
  id: ProviderId;
  runTurn(options: {
    cwd: string;
    prompt: string;
    trustLevel: TrustLevel;
    onEvent: (event: AdapterEvent) => void; // "text" | "tool-use" | "done" | "error"
  }): Promise<void>;
}
```

To add a new provider: spawn that CLI's non-interactive/headless mode (every major coding
CLI has one — `claude -p`, `codex exec`, `gemini -p`, `qwen -p`), translate whatever
structured output it produces into `AdapterEvent`s, map `trustLevel` onto that CLI's own
permission flags, and register it in `adapters/index.ts`. Auth is deliberately **not**
handled in this layer — we shell out to whatever the CLI already has signed in, which is
exactly what makes multiple accounts per provider possible (point different agents at
different machines/profiles/subscriptions).

## Trust levels

v0.1 approximates "how much can this agent do without asking" using each CLI's allow-listed
tools, because true per-action ("approve this one `Edit` call") human-in-the-loop approval
requires wiring a CLI's permission-prompt hook back to our UI over a request/response
channel, which isn't built yet.

| Trust level      | Claude Code flags today                          | Meaning |
|-------------------|--------------------------------------------------|---------|
| `confirm-all`     | `--allowedTools Read,Grep,Glob`                   | Can look around, can't change anything |
| `confirm-risky`   | `--allowedTools Read,Grep,Glob,Edit,Write`        | Can edit files, no shell/network |
| `auto-approve`    | `--dangerously-skip-permissions`                  | Fully unattended |

Roadmap item: replace this with real per-call approval, surfaced in the UI as a
`PendingApproval` (already modeled in `packages/shared`, not wired up to any adapter yet).

## Why Fastify + plain WebSocket instead of a heavier framework

Single small server process, no separate message broker needed for a single-machine tool —
`ChatBus` is just an in-memory pub/sub. If/when this needs to run across machines (e.g. one
agent hub per remote box), that's the seam to swap for something like Redis pub/sub, without
touching `AgentManager`'s routing logic.

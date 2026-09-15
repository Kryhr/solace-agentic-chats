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
    codex-cli.ts    real: spawns `codex exec --json`
    gemini-cli.ts   real: spawns `gemini -p "" --output-format stream-json`
    qwen-code.ts    real: spawns `qwen -p "" --output-format stream-json`
  core/
    chatBus.ts      the shared group-chat history + pub/sub, single source of truth
    agentManager.ts owns agent configs/status, parses @mentions, routes turns, queues
                    per-agent so an agent never gets two turns running concurrently
    mentions.ts     @handle parsing, matched only against known agent handles
  index.ts          Fastify HTTP + WebSocket server tying the above together

packages/web        React UI: sidebar of agent hubs, one shared chat panel
packages/shared     types both sides import (AgentConfig, ChatMessage, ServerEvent, ...)
```

## Chats and projects

A **chat** is a room with an id, a title and optionally a project (`ChatMeta`). There used to
be exactly one, addressed by the literal channel string `"group"`; `ChatChannel` is now
`{ chatId } | { agentId }`, and a state file written before that migrates its whole `"group"`
history into one chat titled "Group chat" (`migrateChatChannels`, `core/persistence.ts`).

A **project** is a directory under `WORKSPACE_ROOT` the user has adopted (`ProjectMeta`).
Adopting one goes through `core/workspace.ts`'s `createProject`, the same code path the
Add-agent modal uses. Unlinking a project removes the link and unfiles its chats; it never
touches the folder.

**An agent belongs to the project its `cwd` is inside** — there is no separate field. An agent
already has a working directory, which is where its CLI genuinely runs; a second, independently
editable "which project is this agent in" could disagree with it, and one of the two would then
be lying. Membership is derived (`ChatStore.agentInProject`), so it cannot drift.

## Chat routing

Implemented in `AgentManager.submitMessage()` -> `routeChatMessage()`, per chat. An unfiled chat
reaches every agent; a chat filed under a project reaches only the agents working in that
project's directory (`ChatStore.agentsForChat`). Within that set:

- A message with `@handle` mentions gives **only** those agents a turn right now. Every
  other agent keeps running whatever it was doing.
- A message with no mentions is appended to the shared history and broadcast to every
  connected UI client, but does **not** interrupt any agent. The next time an agent *is*
  given a turn (because someone mentioned it), the prompt sent to its CLI includes recent
  chat history, so it has the context even though it wasn't actively watching.
- An `@handle` naming a real agent this chat cannot reach summons nobody and posts a system
  notice saying so. Silently dropping it would turn the message into an unaddressed one, which
  then broadcasts — so "@codex do this" would be answered by everyone except codex.
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

`TrustLevel` is Claude Code's own real `--permission-mode` enum (verified via `claude
--help`: `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan` - we expose
all but `dontAsk`), not a hand-rolled approximation. `core/permissionCatalog.ts` exposes
which modes each provider's adapter actually supports (`GET /api/providers/permission-modes`)
so the UI only ever offers real, working options per provider.

| Trust level         | Claude Code flag(s)                                                  | Codex CLI flag(s)                                                 |
|----------------------|-----------------------------------------------------------------------|---------------------------------------------------------------------|
| `plan`               | `--permission-mode plan`                                              | not offered - no native equivalent |
| `manual`             | `--permission-mode manual` + live approval bridge (see below)         | `--ask-for-approval on-request --sandbox workspace-write` (best-effort - no live popup, Codex has no external approval-decision hook) |
| `acceptEdits`        | `--permission-mode acceptEdits`                                       | `--sandbox workspace-write` |
| `bypassPermissions`  | `--permission-mode bypassPermissions`                                  | `--dangerously-bypass-approvals-and-sandbox` |
| `auto`               | `--permission-mode auto`                                               | `--approve-for-me` |

**Live approval loop (Claude Code `manual` mode only)**: a per-turn stdio MCP server
(`server/approval/approvalMcpServer.ts`, via `@modelcontextprotocol/sdk`) is spawned
alongside the `claude` subprocess, wired in via `--permission-prompt-tool
mcp__approval-bridge__permission --mcp-config <inline JSON> --strict-mcp-config
--permission-prompts host`. Its one tool call blocks Claude's turn until a human resolves the
`PendingApproval` it creates (`POST /api/approvals/:id/resolve`), broadcast over the existing
WebSocket as `approval:requested`/`approval:resolved`. Confirmed via
code.claude.com/docs/en/agent-sdk/permissions and `claude --help`; the exact tool-call JSON
schema is an acknowledged documentation gap (anthropics/claude-code#1175) verified
empirically against a logging MCP server before the real handler was written. Codex CLI has
no equivalent external-hook mechanism (confirmed against learn.chatgpt.com/docs/
agent-approvals-security) - its `manual` mode is a best-effort approximation only.

## Why Fastify + plain WebSocket instead of a heavier framework

Single small server process, no separate message broker needed for a single-machine tool —
`ChatBus` is just an in-memory pub/sub. If/when this needs to run across machines (e.g. one
agent hub per remote box), that's the seam to swap for something like Redis pub/sub, without
touching `AgentManager`'s routing logic.

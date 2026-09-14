# solace-agentic-chats

A local-first hub for running **multiple AI coding agents from multiple providers on the
same project at the same time** — Claude Code, Codex CLI, Gemini CLI, Qwen Code, whatever
you've got — where they can see each other's work, task each other in a shared group chat,
and you control how much they're allowed to do without asking first.

> Status: **early skeleton (v0.1)**. Claude Code and Codex CLI adapters are real and
> working; Gemini CLI and Qwen Code are stubbed with a clear contract to fill in (see
> [ARCHITECTURE.md](ARCHITECTURE.md)). The goal right now is "a couple of providers work
> end to end, cleanly" before adding more.

## Why this exists

Everyone touching a big codebase with AI agents runs into the same problem once you use
more than one at a time: they can't see each other, they don't know who's working on what,
and there's no cheap way to say "hey Codex, take a look at what Claude just built." Existing
multi-agent tools (Vibe Kanban, AutoGen/CrewAI, Conductor, etc.) either orchestrate a single
provider's API-key agents in isolated worktrees with no real cross-agent conversation, or
they're a general agent framework rather than something built around the coding CLIs people
already sign in to with a subscription. This project is specifically about that gap:
**subscription-based, multi-provider, local, with a real shared group chat.**

## Core ideas

- **Each agent gets its own hub** — its own working directory, its own current task, its
  own trust level — but can post into a **shared group chat** with every other agent.
- **@mention routing**: `@codex can you check the compiler bug in parser.ts` interrupts only
  the `codex` agent to look at it; agents with no mention keep working uninterrupted. A
  message with no `@mention` is still visible to everyone as shared context, it just doesn't
  interrupt anyone.
- **Trust levels, per agent**: `Read-only`, `Can edit files`, `Full auto`. This maps directly
  onto each CLI's own permission flags — see [ARCHITECTURE.md#trust-levels](ARCHITECTURE.md#trust-levels)
  for exactly what each level allows today and what's still roadmap (a real per-action
  "approve this one tool call" popup needs more plumbing than v0.1 has).
- **Sign in with your subscription, not just an API key.** We never touch auth directly —
  each agent is just a wrapper around that provider's own official CLI (`claude`, `codex`,
  `gemini`, `qwen`, ...), running whatever is already logged in on your machine. Want five
  Claude accounts? Point five agents at five machines/profiles that are each logged in
  separately.
- **Fully local.** The server runs on your machine, the UI is a local web page, nothing
  is sent anywhere except each CLI's own normal traffic to its own provider.

## Repo layout

```
packages/
  shared/   # types shared between server and web (AgentConfig, ChatMessage, ...)
  server/   # Node/TS backend: spawns provider CLIs, routes group chat, WebSocket + REST API
  web/      # React + Vite UI: agent hubs sidebar, group chat panel
```

## Setup

Prerequisites:
- Node.js 20+ and npm
- At least one provider CLI installed and **already signed in with your subscription**:
  - Claude Code: `npm install -g @anthropic-ai/claude-code`, then run `claude` once to log in
  - Codex CLI: `npm install -g @openai/codex`, then run `codex login`
  - Gemini CLI / Qwen Code: not wired up yet, see roadmap below

```bash
git clone https://github.com/Kryhr/solace-agentic-chats.git
cd solace-agentic-chats
npm install
npm run dev
```

One command starts both the server (`http://localhost:4310`) and the UI
(`http://localhost:5173`) in the same terminal. Every project lives under one workspace
folder created automatically on first run — `~/Desktop/solace-workspace` by default,
override with the `SOLACE_WORKSPACE_ROOT` env var.

Open the UI: the **Providers** panel in the sidebar shows which CLIs it found installed on
your machine, with a **Test connection** button that runs a real trivial prompt through
each one so you can confirm sign-in actually works before adding an agent for it. Then
click **+ Add agent**, pick an existing project or create a new one right there, choose a
provider that shows as connected, and start chatting — @mention its handle to give it a
turn (autocompletes as you type).

## Roadmap (deliberately not built yet)

Per-project rule: don't add more until the current thing works cleanly. Rough order:

1. Implement the Gemini CLI and Qwen Code adapters against the same `ProviderAdapter`
   interface used by Claude Code and Codex CLI.
2. Real per-action approval flow (a popup asking "allow `Edit(file.ts)`?" instead of the
   current allow-listed-tools approximation of trust levels).
3. Click into an agent hub to see its full turn-by-turn history (including tool calls and
   reasoning, not just what it posted to the group chat).
4. Multiple accounts per provider (run N instances of the same CLI under different
   profiles/credentials, load-balance tasks across them).
5. Slash commands for the group chat (`/task @codex "build the parser"`, `/status`, etc).
6. Packaging as a single local desktop app instead of "clone + npm run dev".

## License

MIT — see [LICENSE](LICENSE).

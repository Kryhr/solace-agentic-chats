# solace-agentic-chats

A local-first hub for running **multiple AI coding agents from multiple providers on the
same project at the same time** — Claude Code, Codex CLI, Gemini CLI, Qwen Code, whatever
you've got — where they can see each other's work, task each other in a shared group chat,
and you control how much they're allowed to do without asking first.

## Quicc setup

```bash
git clone https://github.com/Kryhr/solace-agentic-chats.git
cd solace-agentic-chats
npm install
npm run dev
```

That's one command for both the server (`http://localhost:4310`) and the UI
(`http://localhost:5173`) — open the UI in your browser. You'll need at least one of these
already signed in on your machine:

| Provider | Install | Sign in |
|---|---|---|
| Claude Code | `npm install -g @anthropic-ai/claude-code` | run `claude` once |
| Codex CLI | `npm install -g @openai/codex` | `codex login` |
| Gemini CLI / Qwen Code | CLI adapters not wired up yet | — |

The sidebar's **Providers** panel shows what it actually found installed, with a **Test
connection** button that runs a real trivial prompt through each one. Click **+ Add agent**,
pick a project (or create one — every project lives under `~/Desktop/solace-workspace` by
default, override with `SOLACE_WORKSPACE_ROOT`), pick a connected provider, and start
chatting. `@mention` a handle to give it a turn in the group chat, or click its card to open
its own hub for a direct 1:1 conversation. Type `/help` in either for the full command list.

Don't have a CLI subscription? Any agent can instead run on a **raw API key** (Anthropic or
OpenAI) — pick "API key" as the sign-in method when adding it. Keys are stored in a local
file outside the repo, never sent anywhere except that provider's own API, and never shown
again in the UI after you save one.

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

- **Each agent gets its own hub** — a full page (click its card) with its own working
  directory, current task, model/effort/trust controls, real session usage, and a **direct
  1:1 chat** with just that agent — but it can also post into a **shared group chat** with
  every other agent.
- **The group chat is a coordination channel, not a transcript.** An agent's full turn-by-turn
  work (tool calls, intermediate reasoning, everything) streams into its own hub in real
  time; the group chat only ever sees the *final* answer for that turn, e.g. "done with the
  backend, @codex go ahead and wire it in" — not a wall of internal chatter. Want the full
  detail on what an agent actually did? Open its hub.
- **@mention routing**: `@codex can you check the compiler bug in parser.ts` interrupts only
  the `codex` agent to look at it; agents with no mention keep working uninterrupted. A
  message with no `@mention` is still visible to everyone as shared context, it just doesn't
  interrupt anyone.
- **Real permission modes**, not an invented approximation: `Plan`, `Manual`, `Accept edits`,
  `Bypass permissions`, `Auto` — these are Claude Code's own `--permission-mode` values.
  `Manual` on a Claude Code agent is a genuine live approval loop: the CLI actually pauses
  mid-turn and a popup in the browser asks Allow/Deny before it proceeds. Codex CLI doesn't
  expose an equivalent live-approval hook, so its `Manual` mode is a best-effort mapping onto
  its own sandbox/approval flags — see [ARCHITECTURE.md](ARCHITECTURE.md) for the full mechanism.
- **Slash commands**: `/task @handle <desc>`, `/status`, `/github status` / `/github init
  <repo>`, `/clear`, `/model <value>`, `/effort <value>`, `/help` — typed straight into
  either chat composer, with autocomplete.
- **GitHub-aware.** The sidebar shows whether `gh` is authenticated on this machine; `/github
  init <name>` (from an agent's own hub) asks that agent to initialize and push the project
  using its own shell access, gated by its own trust level like anything else it does.
- **Sign in with your subscription, not just an API key.** Each CLI-based agent is a wrapper
  around that provider's own official CLI (`claude`, `codex`, `gemini`, `qwen`), running
  whatever is already logged in on your machine. Want five Claude accounts? Point five agents
  at five machines/profiles that are each logged in separately. Prefer an API key instead?
  That's supported too (see Quick setup above), with real per-token cost tracking.
- **Fully local, nothing silently lost.** The server runs on your machine; every agent config
  and message is continuously saved to disk and survives a crash or restart. `/clear` (or the
  hub's "Clear history" button) never deletes anything — it moves that chat to **Saved
  Chats**, browsable from the sidebar.
- **Per-agent model + thinking effort**, set from that agent's hub using each CLI's own real
  flags. The hub shows your CLI's actual currently-configured default model (read live from
  its own config file, e.g. Codex's `~/.codex/config.toml`) rather than a guessed name, plus
  real per-turn token/cost usage as the CLI itself reports it. For CLI/subscription agents
  that's labeled as an API-equivalent estimate, not a real bill — no provider exposes a
  queryable usage-quota API, so this project doesn't pretend to show one.

## Repo layout

```
packages/
  shared/   # types shared between server and web (AgentConfig, ChatMessage, ...)
  server/   # Node/TS backend: spawns provider CLIs, routes group chat, WebSocket + REST API
    src/adapters/   one file per provider (CLI-based and API-key-based)
    src/approval/   the live approval-loop MCP bridge (Claude Code "Manual" mode)
    src/core/       agent manager, chat bus, slash commands, persistence, credentials, ...
  web/      # React + Vite UI: agent hubs sidebar, group chat panel, hub pages, saved chats
```

## Roadmap (deliberately not built yet)

1. Implement the Gemini CLI and Qwen Code adapters against the same `ProviderAdapter`
   interface used by Claude Code and Codex CLI.
2. A live approval-loop equivalent for Codex CLI, if OpenAI ever exposes one (currently
   confirmed not to exist - see ARCHITECTURE.md).
3. Multiple accounts per provider (run N instances of the same CLI under different
   profiles/credentials, load-balance tasks across them).
4. Custom-built dropdown components (currently native `<select>`s, styled) for full control
   over the model/effort/trust pickers' appearance.
5. Packaging as a single local desktop app instead of "clone + npm run dev".

## License

MIT — see [LICENSE](LICENSE).

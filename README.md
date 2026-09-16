# Solace — agentic chats

**Run several AI coding agents, from different providers, on the same project at the same
time — in a shared group chat where they can see each other's work and hand things off.**

Claude Code, Codex, Copilot, Gemini, Qwen, OpenCode and five more, each signed in with your
own subscription, each running as its own agent with its own working directory, model,
reasoning effort and permission level. Everything runs on your machine. Nothing is sent
anywhere except to the provider you already pay for.

---

## Setup

You need [Node.js 20 or newer](https://nodejs.org) and at least one coding-agent CLI already
installed and signed in (see [the list below](#connect-a-cli)).

```bash
git clone https://github.com/Kryhr/solace-agentic-chats.git
cd solace-agentic-chats
npm install
npm run dev
```

Then open **<http://localhost:5173>** in your browser. That is the whole setup.

| What | Where | Change it with |
|---|---|---|
| The app (open this) | `http://localhost:5173` | — |
| The backend API | `http://localhost:4310` | `PORT=4310` |
| Your projects on disk | `~/Desktop/solace-workspace` | `SOLACE_WORKSPACE_ROOT=/some/path` |

`npm run dev` starts the backend and the UI together and leaves them running; stop both with
`Ctrl-C`. Both bind to `127.0.0.1` only, so nothing is reachable from your network.

### First run

A fresh install starts completely empty — no agents, no connections, no projects. It stays
empty until you add something, and everything you add is saved to disk immediately and is
still there after a restart.

Three steps to a working chat:

1. **Connect a CLI.** Sidebar → **+ Add connection** → **Coding agent CLI**. You get a card
   per provider with its sign-in command and a **Test** button. **Add connection** checks the
   binary actually runs before it accepts it.
2. **Add an agent.** Sidebar → **+ Add agent**. Give it a handle (that's its `@name`), pick a
   provider — only ones you've connected are offered — a model, and a permission level.
   Choose an existing project or let it make its own folder.
3. **Talk to it.** Type in the group chat. `@handle` gives that agent a turn; a message with
   no mention is shared context everyone can see but nobody has to answer. Click an agent's
   card to open its own hub for a 1:1 conversation and its full working detail.

Type `/help` in either composer for every command.

### Connect a CLI

Install whichever you want, sign in, then add it in the app. Sign-in is always against
**your own subscription** — Solace never asks for an API key for a CLI and never holds a
login for one.

| Provider | Install | Sign in |
|---|---|---|
| Claude Code | `npm install -g @anthropic-ai/claude-code` | `claude auth login` |
| Codex CLI | `npm install -g @openai/codex` | `codex login` |
| GitHub Copilot CLI | `npm install -g @github/copilot` | `copilot login` |
| Gemini CLI | `npm install -g @google/gemini-cli` | run `gemini`, sign in from the session |
| Qwen Code | `npm install -g @qwen-code/qwen-code` | run `qwen`, sign in from the session |
| OpenCode | `npm install -g opencode-ai` | `opencode auth login` |
| Crush | `npm install -g @charmland/crush` | run `crush` once to set up a provider |
| Continue | `npm install -g @continuedev/cli` | run `cn` once to configure a model |
| Kilo | `npm install -g @kilocode/cli` | `kilo auth login` |
| Droid | `npm install -g droid` | run `droid`, then `/login` (paid only, no free tier) |
| Kimi Code | `npm install -g @moonshot-ai/kimi-code` | `kimi login` |

Every command in that table was read from that CLI's own `--help` rather than from its docs,
and the app shows you which invocation it came from, so you can check it yourself.

**No subscription?** You can point an agent at any OpenAI-compatible endpoint instead — a
hosted one (DeepSeek, Groq, Together, …) with an API key, or a local model server (Ollama,
LM Studio, llama.cpp, vLLM, …) with no key at all. Add those under **+ Add connection** too.

---

## What it actually does

**Each agent gets its own hub.** A full page with its working directory, current task,
model/effort/permission controls, real token usage, and a direct 1:1 chat. Its complete
turn-by-turn work — every tool call, every intermediate step — streams there live.

**A chat is a coordination channel, not a transcript.** The group chat only ever sees an
agent's *final* answer for a turn ("backend's done, @codex wire it in"), never the wall of
internal chatter. Want the detail? Open the hub.

**Agents can talk to each other mid-work.** Through a built-in MCP bridge an agent can post
to the group while it is still working — claim files so two agents don't edit the same thing,
agree a contract before building against it, or ask a question and get an answer inside the
same turn instead of discovering the conflict afterwards.

**Permission levels are what the CLI really enforces.** `Plan`, `Manual`, `Accept edits`,
`Bypass permissions`, `Auto` — and each agent is only offered the levels its own CLI genuinely
implements. On Claude Code, `Manual` is a real live approval loop: the CLI pauses mid-turn and
a card in your browser asks Allow or Deny. Where a provider has no equivalent, that level is
**not offered** rather than faked into something more permissive than it sounds.

**Your own MCP servers.** Add any MCP server once and it reaches every agent whose CLI
supports them, without editing five different config files by hand.

**Skills.** If you have Claude skills installed, agents are told what's available and reach
for the relevant one on their own.

**Nothing is silently lost.** Every config and message is written to disk as it happens.
Clearing a chat moves it to **Saved chats** rather than deleting it; unlinking a project never
touches the folder on disk.

---

## How it works

Each agent is a real subprocess of that provider's own official CLI, spawned per turn in the
agent's working directory, with its prompt, model, effort and permission flags translated into
whatever that particular CLI actually accepts. There is one adapter per provider because no two
of them agree on anything — the prompt goes on stdin for some and argv for others, permissions
are a flag here and a config file there, and usage is reported in four different shapes.

The house rule throughout is that **nothing is claimed unless it was checked.** Provider
capabilities are probed, not assumed; a model list is what the CLI itself printed; a usage
number is what the provider actually stated. Where a provider reports nothing, the UI shows
nothing rather than a confident zero. Where a capability is missing, it is absent from the UI
rather than approximated.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the mechanisms in detail.

```
packages/
  shared/   types shared by both sides
  server/   Node/TS backend: spawns the CLIs, routes the chat, REST + WebSocket
    src/adapters/   one per provider
    src/mcp/        the bridge agents use to reach the group chat
    src/core/       agent manager, chat bus, commands, persistence, credentials
  web/      React + Vite UI
```

---

## Where this is going

v1.0 is the point where the thing is genuinely usable every day: agents that remember their
work, coordinate, and run against whichever provider you already pay for. It is not the
finished shape, and the next versions are mostly about making the group chat better rather
than adding more providers.

Being worked on now:

- **Richer coordination.** The group chat works; it should be better at handing work off,
  splitting a task across agents, and showing who is blocked on whom.
- **More UI control** over how agents are grouped, filtered and watched while they work.
- **Agent Client Protocol adapters.** Kimi, Gemini and Qwen all speak ACP, which offers real
  approval gates and per-session MCP where today's one-shot path offers neither.
- **Live approval loops for more providers**, so `Manual` means the same thing everywhere.
- **Multiple accounts per provider**, so several agents can run the same CLI under different
  logins.
- **Packaging as a desktop app**, instead of clone-and-run.

Known limits in v1.0, stated plainly: a few providers report no usage at all (their CLIs
don't expose it); Copilot's prompt figure covers its last model call rather than a whole turn;
and the four newest adapters were built and unit-tested against their real binaries but have
not each completed a full turn on a signed-in account. The UI says so where it matters rather
than papering over it.

Issues and pull requests are welcome.

## License

MIT — see [LICENSE](LICENSE).

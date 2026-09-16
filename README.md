# Solace — agentic chats

**Run several AI coding agents, from different providers, on the same project at the same
time — in a shared group chat where they can see each other's work and hand things off.**

Everything runs on your machine. Nothing is sent anywhere except to the provider you choose.

## Get started

You need [Node.js 20+](https://nodejs.org). Copy-paste this:

```bash
git clone https://github.com/Kryhr/solace-agentic-chats.git
cd solace-agentic-chats
npm install
npm start
```

Then open **<http://localhost:5173>**. That's the whole setup.

## What you can run agents on

Three kinds of connection, and you can mix them freely — one agent on a Claude subscription
and another on a model running on your own GPU, in the same chat, on the same project.

**1. Coding-agent CLIs, on your own subscription** — 11 of them, no API key involved:

> Claude Code · Codex CLI · GitHub Copilot CLI · Gemini CLI · Qwen Code · OpenCode ·
> Crush · Continue · Kilo · Droid · Kimi Code

**2. Hosted API endpoints**, with your API key — any OpenAI-compatible provider. 25 are
built in with their base URLs already filled:

> DeepSeek · Groq · Mistral · Together AI · Fireworks · OpenRouter · Perplexity · xAI (Grok) ·
> Cerebras · DeepInfra · Moonshot (Kimi) · Anthropic · OpenAI · Google Gemini · Nebius ·
> Novita · Hyperbolic · SambaNova · Baseten · Featherless · Inference.net · Parasail ·
> Venice · Z.AI (GLM) · GMI Cloud

**3. Local model servers on this machine**, keyless and free — Solace can scan for them and
add whichever it finds:

> Ollama · LM Studio · Jan · llama.cpp · vLLM · LocalAI · KoboldCpp · GPT4All

Not on the list? **Add any OpenAI-compatible endpoint** by URL, hosted or local.

## Where things live

| What | Where | Change it with |
|---|---|---|
| The app (open this) | `http://localhost:5173` | `SOLACE_WEB_PORT=5173` |
| The backend API | `http://localhost:4310` | `PORT=4310` |
| Your projects on disk | `~/Desktop/solace-workspace` | `SOLACE_WORKSPACE_ROOT=/some/path` |

`npm start` runs the backend and the UI together; stop both with `Ctrl-C`. Both bind to
`127.0.0.1` only, so nothing is reachable from your network.

## First run

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

## Installing the CLIs

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

Hosted endpoints and local model servers are added the same way — **+ Add connection** →
**Hosted API endpoint** or **Local model server**. A local server needs no key at all, and
the scan button finds the ones already running on this machine.

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

## What's next

Solace is actively developed, and v1.0 is the shape it takes today: agents that remember
their work, coordinate with each other, and run on whichever provider you already use. The
next versions focus on making the group chat richer rather than on adding more providers.

On the way:

- **Richer coordination** — better hand-offs, splitting one task across several agents, and
  seeing at a glance who is blocked on whom.
- **More UI control** over how agents are grouped, filtered and watched while they work.
- **Agent Client Protocol adapters.** Kimi, Gemini and Qwen all speak ACP, which brings real
  approval gates and per-session MCP.
- **Live approval loops for more providers**, so `Manual` means the same thing everywhere.
- **Multiple accounts per provider**, so several agents can run one CLI under different logins.
- **A packaged desktop app**, instead of clone-and-run.

Where a provider's own CLI doesn't expose something — usage figures being the common one —
Solace shows you that rather than inventing a number. As those CLIs grow the reporting, it
picks it up.

Issues and pull requests are welcome.

## License

MIT — see [LICENSE](LICENSE).

import { nanoid } from "nanoid";
import { helpText, isChatChannel, type ChatChannel } from "@solace/shared";
import type { AgentManager } from "./agentManager";
import type { ChatBus } from "./chatBus";
import type { ChatStore } from "./chatStore";
import type { ArchiveStore } from "./archiveStore";
import { checkGithubAuth } from "./github";
import { getPermissionCatalog } from "./permissionCatalog";
import { TRUST_LEVELS } from "./validateAgentConfig";
import { listCredentials, listSshCredentials } from "./credentials";
import { WORKSPACE_ROOT } from "./workspace";
import { checkAllProviders } from "./providerStatus";
import type { CoordinationBoard } from "./coordination";
import type { SshCredentialMeta } from "@solace/shared";
import { notWiredYet, type ChatFeatures } from "./chatFeatures";
import { factsFor, type ProgressDigest } from "./progressDigest";
import { projectDiff } from "./projectDiff";
import { basename } from "./toolLabel";
import {
  isValidAccountLabel,
  listAccounts,
  signInCommandFor,
  supportsMultipleAccounts,
} from "./providerAccounts";

export interface CommandContext {
  channel: ChatChannel;
  agents: AgentManager;
  bus: ChatBus;
  chats: ChatStore;
  archive: ArchiveStore;
  /** The same board AgentManager coordinates through, so /board reads the live state rather
   * than a copy of it. Optional only so existing callers and tests that never touch
   * coordination keep working - /board says plainly when it isn't wired up rather than
   * printing an empty board, which would read as "nothing is claimed". */
  board?: CoordinationBoard;
  /** The task board, the port/server registry and the chat-scope store - each landing on its
   * own branch. Every command that needs one says by name that it is missing rather than
   * printing an empty result. See core/chatFeatures.ts. */
  features?: ChatFeatures;
  /** The per-chat tally of REAL tool-use events, which is the whole of what /summary knows.
   * Absent means /summary says it has counted nothing - not that nothing happened. */
  digest?: ProgressDigest;
  /**
   * How /accounts finds out who each login is. Injectable for one reason: the real one spawns
   * every provider's CLI to ask it, and a unit test must never start a real coding-agent
   * binary. Defaults to the real probe, so production behaviour is unchanged.
   */
  accounts?: typeof listAccounts;
}

// Built from the shared definitions the composer's autocomplete also renders, so a command
// cannot exist on one side and be undiscoverable on the other. See shared/src/commands.ts.
const HELP_TEXT = helpText();

function post(bus: ChatBus, channel: ChatChannel, text: string) {
  bus.postMessage({
    id: nanoid(),
    channel,
    authorId: "system",
    authorHandle: "system",
    mentions: [],
    text,
    createdAt: new Date().toISOString(),
  });
}

function findAgentIdByHandle(agents: AgentManager, handle: string): string | undefined {
  const clean = handle.replace(/^@/, "").toLowerCase();
  return agents.listAgents().find((a) => a.handle.toLowerCase() === clean)?.id;
}

function findAgentByHandle(agents: AgentManager, handle: string) {
  const clean = handle.replace(/^@/, "").toLowerCase();
  return agents.listAgents().find((a) => a.handle.toLowerCase() === clean);
}

/**
 * The chat this command is running in, or undefined after posting the refusal.
 *
 * Several v1.5 commands are about a CHAT - its scope, its task board, its accumulated facts -
 * and none of those exist inside one agent's hub. Saying which and why beats an empty answer
 * that reads as "there is nothing here".
 */
function requireChat(ctx: CommandContext, name: string, why: string): string | undefined {
  if (isChatChannel(ctx.channel)) return ctx.channel.chatId;
  post(ctx.bus, ctx.channel, `/${name} only works in a chat - ${why}.`);
  return undefined;
}

/** `@a @b c` -> the real agents, plus the tokens that matched nobody. Handles are matched
 * case-insensitively and with or without the leading @, because both get typed. */
function resolveHandles(ctx: CommandContext, tokens: string[]) {
  const found: string[] = [];
  const missing: string[] = [];
  for (const token of tokens) {
    const agent = findAgentByHandle(ctx.agents, token);
    if (agent) found.push(agent.handle);
    else missing.push(token.replace(/^@/, ""));
  }
  return { found, missing };
}

/**
 * Shared by /mute /unmute /pause /resume, which are the same shape and differ only in which of
 * the two gates they set and what they have to warn about afterwards.
 */
function gateCommand(ctx: CommandContext, name: "mute" | "unmute" | "pause" | "resume", handleToken: string | undefined): boolean {
  const hubAgentId = requireAgentChannel(ctx.channel);
  const agent = handleToken
    ? findAgentByHandle(ctx.agents, handleToken)
    : ctx.agents.listAgents().find((a) => a.id === hubAgentId);
  if (!agent) {
    post(ctx.bus, ctx.channel, handleToken ? `no agent called ${handleToken}` : `usage: /${name} @handle`);
    return true;
  }
  const gate = ctx.agents.gate;
  const wantMuted = name === "mute";
  const wantPaused = name === "pause";
  const isMuteCommand = name === "mute" || name === "unmute";
  const changed = isMuteCommand ? gate.setMuted(agent.id, wantMuted) : gate.setPaused(agent.id, wantPaused);

  if (!changed) {
    post(
      ctx.bus,
      ctx.channel,
      isMuteCommand
        ? `@${agent.handle} is already ${wantMuted ? "muted" : "unmuted"} - nothing changed.`
        : `@${agent.handle} is already ${wantPaused ? "paused" : "running"} - nothing changed.`,
    );
    return true;
  }

  // The difference between the two pairs is the thing people get wrong, so each says it.
  const lines: Record<typeof name, string> = {
    mute: `@${agent.handle} is muted. Messages in this chat will not be routed to it and nothing will queue up, so there is no backlog waiting when you unmute.`,
    unmute: `@${agent.handle} is unmuted. It will get a turn the next time something is addressed to it; nothing that arrived while it was muted was kept.`,
    pause: `@${agent.handle} is paused. Messages still reach it and pile up on its queue - nothing is dropped - but none of them will run until you /resume it.`,
    resume: `@${agent.handle} is running again, and is working through whatever queued up while it was paused. Each of those is a real billed turn.`,
  };
  post(ctx.bus, ctx.channel, lines[name]);
  return true;
}

/** How a saved SSH target is written everywhere the user sees it. */
function sshSummary(c: SshCredentialMeta): string {
  const where = `${c.ssh.username}@${c.ssh.host}:${c.ssh.port}`;
  const key = c.ssh.privateKeyPath ?? (c.ssh.hasStoredKeyMaterial ? "key pasted into Solace (no file on disk)" : "no key");
  return `${c.label} - ${where} · ${key}`;
}

function findSshTarget(name: string): SshCredentialMeta | undefined {
  const wanted = name.trim().toLowerCase();
  const all = listSshCredentials(WORKSPACE_ROOT);
  return all.find(
    (c) =>
      c.label.toLowerCase() === wanted ||
      c.ssh.host.toLowerCase() === wanted ||
      `${c.ssh.username}@${c.ssh.host}`.toLowerCase() === wanted,
  );
}

/**
 * The agent is told where the deploy target is and which key file to use, and then builds and
 * runs its own ssh/scp/rsync through the shell access its trust level already grants it -
 * exactly like /github init hands it a `gh` task rather than shelling out here. This command
 * deliberately adds no second execution path of its own, and carries no secret: a private key
 * path is a path, and a key the user pasted into Solace stays on the server (see the warning
 * below), so nothing here can put key material into a prompt or the chat log.
 */
function deployPrompt(target: SshCredentialMeta, instruction: string): string {
  const { username, host, port, privateKeyPath, knownHostsPath, hasStoredKeyMaterial } = target.ssh;
  const lines = [
    `There is a saved SSH deploy target called "${target.label}":`,
    `  host: ${host}`,
    `  port: ${port}`,
    `  user: ${username}`,
  ];
  if (privateKeyPath) lines.push(`  private key file: ${privateKeyPath}`);
  if (knownHostsPath) lines.push(`  known_hosts file: ${knownHostsPath}`);
  lines.push(
    "",
    hasStoredKeyMaterial
      ? "The private key for this target was pasted into Solace rather than saved as a file, so there is no key file you can point ssh at. Tell me that, and ask me to write the key to a file and re-save the target with its path."
      : `Use your own shell to run ssh/scp/rsync against it, e.g. \`ssh -i "${privateKeyPath}" -p ${port} ${username}@${host}\`${knownHostsPath ? ` with \`-o UserKnownHostsFile="${knownHostsPath}"\`` : ""}. Never disable host key checking to get a connection working - ask me instead.`,
    "",
    instruction || "Check that you can reach it, and report exactly what happened - do not change anything on the server yet.",
  );
  return lines.join("\n");
}

/** The name this channel is filed under in Saved chats, resolved once at archive time - so a
 * chat that is later renamed or deleted still shows what it was called when it was saved. */
function channelLabel(ctx: CommandContext): string {
  if (isChatChannel(ctx.channel)) return ctx.chats.chatLabel(ctx.channel.chatId);
  const agentId = ctx.channel.agentId;
  return `${ctx.agents.listAgents().find((a) => a.id === agentId)?.handle ?? "an agent"}'s hub`;
}

/** Only meaningful inside one agent's own hub channel - a chat has no single "current agent". */
function requireAgentChannel(channel: ChatChannel): string | undefined {
  return isChatChannel(channel) ? undefined : channel.agentId;
}

/**
 * Returns true if `text` was a recognized slash command (and has already been fully handled -
 * posted whatever response it needed to `ctx.channel`). Returns false for ordinary chat text,
 * which the caller should then pass to submitMessage/submitDirectMessage as usual.
 */
export async function tryHandleCommand(text: string, ctx: CommandContext): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return false;

  const [rawName, ...rest] = trimmed.slice(1).split(/\s+/);
  const name = rawName.toLowerCase();
  const argText = trimmed.slice(1 + rawName.length).trim();

  switch (name) {
    case "help": {
      post(ctx.bus, ctx.channel, HELP_TEXT);
      return true;
    }

    case "task": {
      const [handleToken, ...descParts] = rest;
      const agentId = handleToken ? findAgentIdByHandle(ctx.agents, handleToken) : undefined;
      const description = descParts.join(" ").trim();
      if (!agentId || !description) {
        post(ctx.bus, ctx.channel, "usage: /task @handle <description>");
        return true;
      }
      ctx.agents.updateAgent(agentId, { currentTask: description });
      post(ctx.bus, ctx.channel, `task updated for ${handleToken}: ${description}`);
      return true;
    }

    case "usage": {
      // Only ever prints what a provider's own CLI volunteered mid-turn. A provider that has
      // never reported gets a plain sentence saying so - never a fabricated 0%, which would
      // read as "you've used nothing" when the truth is "we don't know".
      const limits = ctx.agents.listRateLimits();
      const providers = [...new Set(ctx.agents.listAgents().map((a) => a.provider))];
      if (providers.length === 0) {
        post(ctx.bus, ctx.channel, "no agents configured yet");
        return true;
      }
      const lines = providers.map((provider) => {
        const limit = limits.find((l) => l.provider === provider);
        if (!limit || limit.windows.length === 0) {
          return `${provider} - no usage reported yet (providers only report during a turn)`;
        }
        const windows = limit.windows
          .map((w) => {
            const resets = w.resetsAt ? `, resets ${new Date(w.resetsAt * 1000).toLocaleTimeString()}` : "";
            return `${w.label} ${w.usedPercent.toFixed(1)}% used${resets}`;
          })
          .join(" · ");
        const plan = limit.planType ? ` (${limit.planType})` : "";
        return `${provider}${plan} - ${windows} — as of ${new Date(limit.observedAt).toLocaleTimeString()}`;
      });
      post(ctx.bus, ctx.channel, lines.join("\n"));
      return true;
    }

    case "agents": {
      const agents = ctx.agents.listAgents();
      if (agents.length === 0) {
        post(ctx.bus, ctx.channel, "no agents configured yet");
        return true;
      }
      const lines = agents.map(
        (a) => `${a.handle} - ${a.provider}${a.model ? ` (${a.model})` : ""} · ${a.trustLevel} · ${a.cwd}`,
      );
      post(ctx.bus, ctx.channel, lines.join("\n"));
      return true;
    }

    case "status": {
      const agents = ctx.agents.listAgents();
      const statuses = new Map(ctx.agents.listStatuses().map((s) => [s.agentId, s]));
      if (agents.length === 0) {
        post(ctx.bus, ctx.channel, "no agents configured yet");
        return true;
      }
      const lines = agents.map((a) => {
        const status = statuses.get(a.id);
        const model = a.model ? ` · ${a.model}` : "";
        const task = a.currentTask ? ` · ${a.currentTask}` : " · no task assigned";
        return `${a.handle} (${a.provider}${model}) - ${status?.state ?? "offline"}${task}`;
      });
      post(ctx.bus, ctx.channel, lines.join("\n"));
      return true;
    }

    /**
     * The coordination board, which until now existed only in the agents' own prompts: claims,
     * contracts and blocks were all real and all invisible to the person watching. Everything
     * printed here is read straight off the live board - there is no summarising step that
     * could state something the board does not actually hold.
     */
    case "board": {
      if (!isChatChannel(ctx.channel)) {
        post(ctx.bus, ctx.channel, "/board only works in a chat - the coordination board belongs to a chat, not to one agent's hub");
        return true;
      }
      if (!ctx.board) {
        // Never an empty board: "nothing is claimed" and "this command cannot see the board"
        // are completely different statements and must not render identically.
        post(ctx.bus, ctx.channel, "the coordination board isn't available here, so nothing can be shown for it");
        return true;
      }
      const state = ctx.board.forChat(ctx.channel.chatId);
      const sections: string[] = [];

      if (state.claims.length > 0) {
        sections.push(
          ["Files claimed:", ...state.claims.map((c) => `  ${c.handle} - ${c.paths.join(", ")}${c.note ? ` (${c.note})` : ""}`)].join("\n"),
        );
      }
      if (state.contracts.length > 0) {
        // Titles and who posted them, not the bodies: a contract body is a design document and
        // pasting several of them into the chat would bury everything else on the board.
        sections.push(
          ["Contracts posted:", ...state.contracts.map((c) => `  "${c.title}" - by ${c.handle}`)].join("\n"),
        );
      }
      if (state.blocks.length > 0) {
        sections.push(
          [
            "Blocked:",
            ...state.blocks.map((b) => {
              const what =
                b.kind === "contract" ? `a contract matching "${b.value}"` : b.kind === "file" ? `${b.value} to exist` : `@${b.value} to post`;
              return `  ${b.handle} - waiting for ${what}${b.why ? ` (${b.why})` : ""}`;
            }),
          ].join("\n"),
        );
      }

      post(
        ctx.bus,
        ctx.channel,
        sections.length === 0
          ? "The coordination board is empty for this chat - no files claimed, no contracts posted, nobody blocked."
          : sections.join("\n\n"),
      );
      return true;
    }

    /**
     * Stop and retry were both real AgentManager actions reachable only by finding the right
     * button on the right agent. Both report what actually happened - stopAgent and retryAgent
     * each return whether there was anything to act on, and that boolean is the answer here
     * rather than an optimistic "stopped." posted regardless.
     */
    case "stop":
    case "retry": {
      const isStop = name === "stop";
      const handleToken = rest[0];
      const hubAgentId = requireAgentChannel(ctx.channel);
      let targets = ctx.agents.listAgents();

      if (handleToken) {
        const id = findAgentIdByHandle(ctx.agents, handleToken);
        if (!id) {
          post(ctx.bus, ctx.channel, `no agent called ${handleToken}`);
          return true;
        }
        targets = targets.filter((a) => a.id === id);
      } else if (hubAgentId) {
        // In an agent's own hub the subject is obvious, so no handle is needed there.
        targets = targets.filter((a) => a.id === hubAgentId);
      }

      if (targets.length === 0) {
        post(ctx.bus, ctx.channel, "no agents configured yet");
        return true;
      }

      const acted: string[] = [];
      const nothingToDo: string[] = [];
      for (const agent of targets) {
        const did = isStop ? ctx.agents.stopAgent(agent.id) : ctx.agents.retryAgent(agent.id);
        (did ? acted : nothingToDo).push(agent.handle);
      }

      const lines = [
        acted.length > 0 ? (isStop ? `Stopped: ${acted.join(", ")}` : `Re-running the last failed turn for: ${acted.join(", ")}`) : undefined,
        nothingToDo.length > 0
          ? isStop
            ? `Nothing running to stop: ${nothingToDo.join(", ")}`
            : `No failed turn to retry: ${nothingToDo.join(", ")}`
          : undefined,
      ].filter(Boolean);
      post(ctx.bus, ctx.channel, lines.join("\n"));
      return true;
    }

    /**
     * The same real `<bin> --version` probe the Connections panel runs, which is the only
     * evidence this app has that a CLI is installed. The version string each CLI actually
     * printed is shown, because "installed" with nothing behind it is exactly the unbacked
     * green state the rest of this codebase works to keep out.
     */
    case "providers": {
      const statuses = await checkAllProviders();
      const lines = statuses.map((s) =>
        s.installed
          ? `${s.provider} - installed · ${s.version}`
          : `${s.provider} - not found on PATH · ${s.installCommand}`,
      );
      post(
        ctx.bus,
        ctx.channel,
        [
          "Coding-agent CLIs on this machine (from a real `--version` on each):",
          ...lines,
          "",
          "This proves each binary runs. It does not prove any of them is signed in.",
        ].join("\n"),
      );
      return true;
    }

    case "save": {
      // The same archive /clear produces, minus the destruction. Archiving was only ever
      // reachable as a side effect of clearing, so "keep a copy of this" and "wipe this" were
      // the same button - the copy is the part people actually want.
      const messages = ctx.bus.getHistoryFor(ctx.channel);
      if (messages.length === 0) {
        post(ctx.bus, ctx.channel, "nothing to save yet - this chat is empty");
        return true;
      }
      ctx.archive.add(ctx.channel, messages, channelLabel(ctx));
      ctx.bus.emitEvent({ type: "archive:saved", payload: { channel: ctx.channel } });
      post(ctx.bus, ctx.channel, `Saved a copy of this chat (${messages.length} messages) to Saved chats. Nothing was cleared.`);
      return true;
    }

    case "clear": {
      // Label resolved BEFORE clearing, while the agent is still findable.
      const label = channelLabel(ctx);
      const removed = ctx.bus.clearChannel(ctx.channel);
      ctx.archive.add(ctx.channel, removed, label);
      return true;
    }

    case "trust":
    case "permissions": {
      // Bulk, because setting five agents to plan mode one dropdown at a time before a risky
      // run is exactly the kind of chore people skip - and skipping it is the expensive
      // outcome. A provider that does not support the requested mode is REPORTED, never
      // quietly given a different one: silently downgrading "plan" to something permissive
      // would be the worst possible failure of a permission command.
      const [levelToken, handleToken] = rest;
      const requested = TRUST_LEVELS.find((l) => l.toLowerCase() === (levelToken ?? "").toLowerCase());
      if (!requested) {
        post(
          ctx.bus,
          ctx.channel,
          `usage: /trust <${TRUST_LEVELS.join("|")}> [@handle]
Without a handle it applies to every agent.`,
        );
        return true;
      }

      const catalog = new Map(getPermissionCatalog().map((p) => [p.provider, p.availableModes]));
      const all = ctx.agents.listAgents();
      const targets = handleToken
        ? all.filter((a) => a.handle.toLowerCase() === handleToken.replace(/^@/, "").toLowerCase())
        : all;
      if (targets.length === 0) {
        post(ctx.bus, ctx.channel, handleToken ? `no agent called ${handleToken}` : "no agents configured yet");
        return true;
      }

      const changed: string[] = [];
      const unchanged: string[] = [];
      const unsupported: string[] = [];
      for (const agent of targets) {
        const modes = catalog.get(agent.provider) ?? [];
        // An empty list means that provider's real modes were never verified - treat it as
        // "we don't know", which is not the same as "anything goes".
        if (modes.length > 0 && !modes.includes(requested)) {
          unsupported.push(`${agent.handle} (${agent.provider} has no "${requested}" mode)`);
          continue;
        }
        if (agent.trustLevel === requested) {
          unchanged.push(agent.handle);
          continue;
        }
        ctx.agents.updateAgent(agent.id, { trustLevel: requested });
        changed.push(agent.handle);
      }

      const lines = [
        changed.length > 0 ? `Set to ${requested}: ${changed.join(", ")}` : undefined,
        unchanged.length > 0 ? `Already ${requested}: ${unchanged.join(", ")}` : undefined,
        unsupported.length > 0 ? `Left alone - ${unsupported.join("; ")}` : undefined,
        requested === "bypassPermissions" && changed.length > 0
          ? "Those agents can now edit files and run commands with no approval."
          : undefined,
      ].filter(Boolean);
      post(ctx.bus, ctx.channel, lines.join("\n"));
      return true;
    }

    case "reset": {
      const agentId = requireAgentChannel(ctx.channel);
      if (!agentId) {
        post(ctx.bus, ctx.channel, "/reset only works from an agent's own hub, not a chat");
        return true;
      }
      const had = ctx.agents.resetSession(agentId);
      post(
        ctx.bus,
        ctx.channel,
        had
          ? "Session cleared - the next turn starts fresh, with no memory of earlier turns."
          : "This agent has no session yet, so its next turn already starts fresh.",
      );
      return true;
    }

    case "model":
    case "effort": {
      const agentId = requireAgentChannel(ctx.channel);
      if (!agentId) {
        post(ctx.bus, ctx.channel, `/${name} only works from an agent's own hub, not a chat`);
        return true;
      }
      if (!argText) {
        post(ctx.bus, ctx.channel, `usage: /${name} <value>`);
        return true;
      }
      ctx.agents.updateAgent(agentId, { [name]: argText });
      post(ctx.bus, ctx.channel, `${name} set to ${argText}`);
      return true;
    }

    case "deploy": {
      const targets = listSshCredentials(WORKSPACE_ROOT);
      const [first, ...instructionParts] = rest;
      if (!first || first.toLowerCase() === "list") {
        post(
          ctx.bus,
          ctx.channel,
          targets.length === 0
            ? "No SSH deploy targets saved yet - add one under Connections in the sidebar."
            : ["Saved deploy targets:", ...targets.map((t) => `  ${sshSummary(t)}`)].join("\n"),
        );
        return true;
      }
      const agentId = requireAgentChannel(ctx.channel);
      if (!agentId) {
        post(ctx.bus, ctx.channel, "/deploy <target> only works from an agent's own hub - try /deploy list here instead");
        return true;
      }
      const target = findSshTarget(first);
      if (!target) {
        post(
          ctx.bus,
          ctx.channel,
          `no saved deploy target called "${first}" - /deploy list shows the saved ones`,
        );
        return true;
      }
      ctx.agents.submitDirectMessage(agentId, deployPrompt(target, instructionParts.join(" ").trim()));
      return true;
    }

    /**
     * Lists what is IN the vault - labels and kinds, never values. It exists because an agent
     * addresses a saved entry by its label, so both sides need to agree on the name: the user
     * has to be able to see what they called something without opening the sidebar, and can
     * then tell an agent which entry to use. There is deliberately no "/vault show" here -
     * reading a secret is a per-entry action in the UI, not something typed into a chat log
     * that is persisted to disk and mirrored to every other agent in the group.
     */
    case "vault": {
      const all = listCredentials(WORKSPACE_ROOT);
      post(
        ctx.bus,
        ctx.channel,
        all.length === 0
          ? "The vault is empty - add API keys, deploy targets, logins or secrets under Connections in the sidebar."
          : [
              "Saved in the vault (names only - values are never shown here):",
              ...all.map((c) => `  ${c.label} · ${c.kind}${c.notes ? ` · ${c.notes}` : ""}`),
              "",
              "An agent can use one by name during a turn; you'll see a message in its hub when it does.",
            ].join("\n"),
      );
      return true;
    }

    case "github": {
      const [sub, ...subArgs] = rest;
      if (sub === "init") {
        const repoName = subArgs.join(" ").trim();
        const agentId = requireAgentChannel(ctx.channel);
        if (!agentId) {
          post(ctx.bus, ctx.channel, "/github init only works from an agent's own hub, not a chat");
          return true;
        }
        if (!repoName) {
          post(ctx.bus, ctx.channel, "usage: /github init <repo-name>");
          return true;
        }
        ctx.agents.submitDirectMessage(
          agentId,
          `Initialize this project as a git repository if it isn't already one, then create and ` +
            `push it to GitHub using the gh CLI as a repo named '${repoName}' (ask me first if you're ` +
            `unsure whether it should be public or private).`,
        );
        return true;
      }
      const status = await checkGithubAuth();
      post(
        ctx.bus,
        ctx.channel,
        status.authenticated ? `GitHub: connected as ${status.account}` : `GitHub: not connected - ${status.detail}`,
      );
      return true;
    }

    /**
     * A question, said to be one rather than inferred to be one.
     *
     * classifyIncoming does a decent job on wording, but it is a guess, and the difference it
     * decides is expensive: a "question" may interrupt a running turn after the grace period,
     * while "work" waits its place in the queue. /ask is the operator declaring it, which is
     * the same thing the solace bridge's `kind` argument does for an agent.
     */
    case "ask": {
      const chatId = requireChat(ctx, "ask", "a question has to go to somebody in a room");
      if (!chatId) return true;
      const [handleToken, ...questionParts] = rest;
      const agent = handleToken ? findAgentByHandle(ctx.agents, handleToken) : undefined;
      const question = questionParts.join(" ").trim();
      if (!agent || !question) {
        post(ctx.bus, ctx.channel, handleToken && !agent ? `no agent called ${handleToken}` : "usage: /ask @handle <question>");
        return true;
      }
      // Goes through the ordinary routing path, so scope, membership and the chain cap all
      // still apply - the only thing /ask changes is what the message is declared to BE.
      ctx.agents.submitMessage(chatId, "user", "user", `@${agent.handle} ${question}`, "question");
      return true;
    }

    /**
     * Context for the room that costs nobody a turn.
     *
     * Posted as an ANNOUNCEMENT, which is an existing, working mechanism rather than a new one:
     * agentManager.coordinationBlock folds every announcement an agent has not yet seen into
     * that agent's next group prompt and then marks it seen. So an /fyi reaches everybody, in
     * full, without summoning anybody - which is exactly the "no turn" property. A plain system
     * message would have been visible to the operator and invisible to every agent, and that is
     * the kind of silent nothing this whole command set is supposed to stop.
     */
    case "fyi": {
      const chatId = requireChat(ctx, "fyi", "there is nobody to give context to in one agent's hub");
      if (!chatId) return true;
      if (!argText) {
        post(ctx.bus, ctx.channel, "usage: /fyi <text>");
        return true;
      }
      ctx.bus.postMessage({
        id: nanoid(),
        channel: { chatId },
        // authorId "system", NOT "user", and this is load-bearing. agentManager.operatorScope
        // derives the chat's scope from the most recent HUMAN message's @mentions, so an /fyi
        // filed as a user message - which it has none - would silently widen a chat you had
        // deliberately scoped to two agents back out to everybody. The handle stays "you"
        // because the words are yours, and that is how each agent is shown them.
        authorId: "system",
        authorHandle: "you",
        mentions: [],
        text: argText,
        agentKind: "announcement",
        createdAt: new Date().toISOString(),
      });
      post(
        ctx.bus,
        ctx.channel,
        "Posted as an FYI. Nobody was given a turn for it; each agent will see it folded into its next turn's context.",
      );
      return true;
    }

    // --- the task board (ROADMAP step 3, landing on its own branch) ---------------------------

    case "assign": {
      const chatId = requireChat(ctx, "assign", "the task board belongs to a chat");
      if (!chatId) return true;
      const [handleToken, ...descParts] = rest;
      const agent = handleToken ? findAgentByHandle(ctx.agents, handleToken) : undefined;
      const description = descParts.join(" ").trim();
      if (!agent || !description) {
        post(ctx.bus, ctx.channel, handleToken && !agent ? `no agent called ${handleToken}` : "usage: /assign @handle <task>");
        return true;
      }
      if (!ctx.features?.tasks) {
        post(ctx.bus, ctx.channel, notWiredYet("task board", `assigning "${description}" to @${agent.handle}`));
        return true;
      }
      const task = ctx.features.tasks.assign(chatId, agent.handle, description);
      post(ctx.bus, ctx.channel, `${task.id} - ${task.description} · @${agent.handle}`);
      return true;
    }

    case "tasks": {
      const chatId = requireChat(ctx, "tasks", "the task board belongs to a chat");
      if (!chatId) return true;
      if (!ctx.features?.tasks) {
        post(ctx.bus, ctx.channel, notWiredYet("task board", "listing this chat's tasks"));
        return true;
      }
      const tasks = ctx.features.tasks.list(chatId);
      post(
        ctx.bus,
        ctx.channel,
        tasks.length === 0
          ? "Nothing on the board for this chat yet - /assign @handle <task> puts something on it."
          : [
              "Task board:",
              ...tasks.map((t) => {
                const owner = t.owner ? `@${t.owner}` : "unassigned";
                const files = t.files?.length ? ` · ${t.files.join(", ")}` : "";
                return `  ${t.id} [${t.status}] ${t.description} · ${owner}${files}`;
              }),
            ].join("\n"),
      );
      return true;
    }

    case "done":
    case "unassign": {
      const chatId = requireChat(ctx, name, "the task board belongs to a chat");
      if (!chatId) return true;
      const taskId = rest[0];
      if (!taskId) {
        post(ctx.bus, ctx.channel, `usage: /${name} <id> - /tasks lists the ids`);
        return true;
      }
      if (!ctx.features?.tasks) {
        post(ctx.bus, ctx.channel, notWiredYet("task board", `${name === "done" ? "finishing" : "unassigning"} ${taskId}`));
        return true;
      }
      const did = name === "done" ? ctx.features.tasks.finish(chatId, taskId) : ctx.features.tasks.unassign(chatId, taskId);
      post(
        ctx.bus,
        ctx.channel,
        did
          ? name === "done"
            ? `${taskId} marked done.`
            : `${taskId} is now unassigned and still open.`
          : `There is no task ${taskId} on this chat's board - /tasks lists the ids.`,
      );
      return true;
    }

    // --- scope you can actually see (ROADMAP step 1, landing on its own branch) ---------------

    case "only": {
      const chatId = requireChat(ctx, "only", "scope is a property of a chat");
      if (!chatId) return true;
      if (rest.length === 0) {
        post(ctx.bus, ctx.channel, "usage: /only @a [@b ...] - or /all to clear the scope");
        return true;
      }
      const { found, missing } = resolveHandles(ctx, rest);
      if (missing.length > 0) {
        // Scoping to a handle that does not exist would silently scope the chat to nobody, which
        // looks exactly like the app having stopped working.
        post(ctx.bus, ctx.channel, `no agent called ${missing.map((m) => `@${m}`).join(", ")} - nothing was scoped.`);
        return true;
      }
      if (!ctx.features?.scope) {
        post(ctx.bus, ctx.channel, notWiredYet("explicit chat scope", `scoping this chat to ${found.map((h) => `@${h}`).join(" ")}`));
        return true;
      }
      ctx.features.scope.setScope(chatId, found);
      post(ctx.bus, ctx.channel, `Scoped to ${found.map((h) => `@${h}`).join(", ")}. /all clears it.`);
      return true;
    }

    case "all": {
      const chatId = requireChat(ctx, "all", "scope is a property of a chat");
      if (!chatId) return true;
      if (!ctx.features?.scope) {
        post(ctx.bus, ctx.channel, notWiredYet("explicit chat scope", "clearing this chat's scope"));
        return true;
      }
      const had = ctx.features.scope.scopeFor(chatId);
      ctx.features.scope.clearScope(chatId);
      post(
        ctx.bus,
        ctx.channel,
        had?.length
          ? `Scope cleared - every agent in this chat is reachable again (it was ${had.map((h) => `@${h}`).join(", ")}).`
          : "This chat was not scoped, so nothing changed - every agent in it is reachable.",
      );
      return true;
    }

    case "quiet":
    case "loud": {
      const chatId = requireChat(ctx, name, "where status messages go is a property of a chat");
      if (!chatId) return true;
      if (!ctx.features?.scope) {
        post(
          ctx.bus,
          ctx.channel,
          notWiredYet("message-class routing", name === "quiet" ? "sending status lines to hubs only" : "putting status lines back in the group"),
        );
        return true;
      }
      const where = name === "quiet" ? "hub" : "group";
      ctx.features.scope.setStatusRouting(chatId, where);
      post(
        ctx.bus,
        ctx.channel,
        where === "hub"
          ? "Status messages now go to each agent's own hub only. Questions, handoffs and findings still come here."
          : "Status messages are back in the group.",
      );
      return true;
    }

    // --- holding an agent back without removing it -------------------------------------------

    case "mute":
    case "unmute":
    case "pause":
    case "resume":
      return gateCommand(ctx, name, rest[0]);

    /**
     * Stop a turn RIGHT NOW for this message, with no grace period.
     *
     * The graced path (armInterruptTimer) is the right default - it gives the agent a chance to
     * pick the message up between tool calls, which costs nothing, and only kills the turn if
     * that window passes. This is the escape hatch for when the agent is confidently doing the
     * wrong thing and you do not want to wait fifty seconds to say so. It costs a real billed
     * turn to resume, and says so.
     */
    case "interrupt": {
      const [handleToken, ...msgParts] = rest;
      const agent = handleToken ? findAgentByHandle(ctx.agents, handleToken) : undefined;
      const message = msgParts.join(" ").trim();
      if (!agent || !message) {
        post(ctx.bus, ctx.channel, handleToken && !agent ? `no agent called ${handleToken}` : "usage: /interrupt @handle <message>");
        return true;
      }
      // The message is queued FIRST, so that when the abort lands there is already something for
      // the agent to pick up - the reverse order leaves a killed turn and an empty queue.
      if (isChatChannel(ctx.channel)) {
        ctx.agents.submitMessage(ctx.channel.chatId, "user", "user", `@${agent.handle} ${message}`, "question");
      } else {
        ctx.agents.submitDirectMessage(agent.id, message);
      }
      const stopped = ctx.agents.forcePreempt(agent.id);
      post(
        ctx.bus,
        ctx.channel,
        stopped
          ? `Stopped @${agent.handle}'s turn to take that. It answers this first, then resumes what it was doing - which is a real billed turn, and counts against the resume limit in Settings.`
          : `@${agent.handle} was not running, so there was nothing to interrupt - the message is queued and will be its next turn.`,
      );
      return true;
    }

    // --- the port and server registry (ROADMAP step 4, landing on its own branch) -------------

    case "servers": {
      const [sub, id] = rest;
      if (!ctx.features?.servers) {
        post(ctx.bus, ctx.channel, notWiredYet("server registry", sub === "kill" ? `stopping ${id ?? "a server"}` : "listing running servers"));
        return true;
      }
      if (sub === "kill") {
        if (!id) {
          post(ctx.bus, ctx.channel, "usage: /servers kill <id> - /servers lists the ids");
          return true;
        }
        const killed = await ctx.features.servers.kill(id);
        post(ctx.bus, ctx.channel, killed ? `Stopped ${id}.` : `Nothing registered under ${id} - /servers lists what is.`);
        return true;
      }
      const servers = ctx.features.servers.listServers();
      post(
        ctx.bus,
        ctx.channel,
        servers.length === 0
          ? "No servers registered. A server an agent started without registering it is not listed here - this shows what Solace is keeping alive, not what is listening on this machine."
          : [
              "Running servers:",
              ...servers.map((s) => {
                // Absent and false are different states: "not checked" must never render as a
                // cross, and "checked and dead" must never render as a tick.
                const state =
                  s.listening === undefined
                    ? "not checked"
                    : s.listening
                      ? `responding${s.checkedAt ? ` as of ${new Date(s.checkedAt).toLocaleTimeString()}` : ""}`
                      : `NOT responding${s.checkedAt ? ` as of ${new Date(s.checkedAt).toLocaleTimeString()}` : ""}`;
                return `  ${s.id} - :${s.port} · @${s.handle} · ${state}${s.command ? ` · ${s.command}` : ""}`;
              }),
              "",
              "/servers kill <id> stops one.",
            ].join("\n"),
      );
      return true;
    }

    case "ports": {
      if (!ctx.features?.servers) {
        post(ctx.bus, ctx.channel, notWiredYet("port registry", "listing reserved ports"));
        return true;
      }
      const ports = ctx.features.servers.listPorts();
      post(
        ctx.bus,
        ctx.channel,
        ports.length === 0
          ? "No ports reserved. This lists reservations agents have made through Solace; it is not a scan of the machine."
          : ["Reserved ports:", ...ports.map((p) => `  :${p.port} - @${p.handle} · since ${new Date(p.reservedAt).toLocaleTimeString()}`)].join("\n"),
      );
      return true;
    }

    // --- server-derived facts ------------------------------------------------------------------

    /**
     * Who owns a file. Two independent sources, both facts, and each labelled with which it is:
     * the coordination board's CLAIMS (what an agent said it was taking) and the digest's record
     * of who actually WROTE to that path. They can disagree, and when they do that disagreement
     * is the most useful thing on the screen - so this prints both rather than picking one.
     */
    case "who": {
      const chatId = requireChat(ctx, "who", "claims belong to a chat's coordination board");
      if (!chatId) return true;
      const wanted = argText.trim();
      if (!wanted) {
        post(ctx.bus, ctx.channel, "usage: /who <file>");
        return true;
      }
      const needle = wanted.toLowerCase();
      const lines: string[] = [];

      if (!ctx.board) {
        lines.push("The coordination board isn't available here, so no claim could be checked.");
      } else {
        const claims = ctx.board
          .forChat(chatId)
          .claims.filter((c) => c.paths.some((p) => p.toLowerCase().includes(needle) || basename(p).toLowerCase() === needle));
        lines.push(
          claims.length === 0
            ? `Claimed by: nobody. No agent has claimed anything matching "${wanted}" in this chat.`
            : `Claimed by: ${claims.map((c) => `@${c.handle}${c.note ? ` (${c.note})` : ""}`).join(", ")}.`,
        );
      }

      if (!ctx.digest) {
        lines.push("No tool events have been counted in this build, so who has written to it is not known here.");
      } else {
        const facts = ctx.digest.factsForChat(chatId);
        const writers = [...facts.byHandle.entries()]
          .filter(([, tally]) => [...tally.filesWritten].some((p) => p.toLowerCase().includes(needle) || basename(p).toLowerCase() === needle))
          .map(([handle]) => `@${handle}`);
        lines.push(
          writers.length === 0
            ? `Written to by: nobody, in anything counted since ${new Date(facts.since).toLocaleTimeString()}.`
            : `Written to by: ${writers.join(", ")} - from their own tool calls, whatever the board says.`,
        );
      }
      post(ctx.bus, ctx.channel, lines.join("\n"));
      return true;
    }

    /**
     * What has actually happened in this chat.
     *
     * Every number here is counted from a real tool-use event and every name is a real path,
     * handle or port. Nothing in this command asks a model for anything, and there is no field
     * in the data it reads that could hold a sentence - see core/progressDigest.ts, which is
     * where the counting lives and where that property is enforced and tested.
     */
    case "summary": {
      const chatId = requireChat(ctx, "summary", "it reports on one chat's work");
      if (!chatId) return true;
      const sections: string[] = [];

      if (!ctx.digest) {
        sections.push("Tool events are not being counted in this build, so there are no facts to report.");
      } else {
        const facts = ctx.digest.factsForChat(chatId);
        const counted = factsFor(facts.tally);
        sections.push(
          counted.length === 0
            ? `Nothing countable has happened in this chat since ${new Date(facts.since).toLocaleString()}.`
            : [`Since ${new Date(facts.since).toLocaleString()}: ${counted.join(" · ")}`,
               ...[...facts.byHandle.entries()]
                 .map(([handle, tally]) => [handle, factsFor(tally)] as const)
                 .filter(([, f]) => f.length > 0)
                 .map(([handle, f]) => `  @${handle} · ${f.join(" · ")}`)].join("\n"),
        );
        const written = ctx.digest.filesWrittenIn(chatId);
        if (written.length > 0) sections.push(`Files written: ${written.join(", ")}`);
      }

      if (ctx.board) {
        const state = ctx.board.forChat(chatId);
        if (state.claims.length > 0) {
          sections.push(`Claimed: ${state.claims.map((c) => `@${c.handle} -> ${c.paths.join(", ")}`).join(" | ")}`);
        }
        if (state.blocks.length > 0) {
          sections.push(`Blocked: ${state.blocks.map((b) => `@${b.handle} on ${b.kind} "${b.value}"`).join(" | ")}`);
        }
      }

      if (!ctx.features?.servers) {
        sections.push("Servers: the server registry isn't running in this build, so none are tracked.");
      } else {
        const servers = ctx.features.servers.listServers();
        sections.push(servers.length === 0 ? "Servers: none registered." : `Servers: ${servers.map((s) => `:${s.port} (@${s.handle})`).join(", ")}`);
      }

      if (!ctx.features?.tasks) {
        sections.push("Open tasks: the task board isn't running in this build, so none are tracked.");
      } else {
        const open = ctx.features.tasks.list(chatId).filter((t) => t.status === "open");
        sections.push(
          open.length === 0 ? "Open tasks: none." : ["Open tasks:", ...open.map((t) => `  ${t.id} ${t.description} · ${t.owner ? `@${t.owner}` : "unassigned"}`)].join("\n"),
        );
      }

      post(ctx.bus, ctx.channel, sections.join("\n"));
      return true;
    }

    /**
     * git, in the project this chat belongs to, since the chat was created. Every line printed
     * is git's own output - see core/projectDiff.ts for why the window is expressed as it is.
     */
    case "diff": {
      const wantsStat = (rest[0] ?? "").toLowerCase() === "stat";
      const chatId = isChatChannel(ctx.channel) ? ctx.channel.chatId : undefined;
      const chat = chatId ? ctx.chats.getChat(chatId) : undefined;
      const project = chatId ? ctx.chats.projectForChat(chatId) : undefined;
      // In a hub, the agent's own working directory is the only project there is.
      const hubAgent = ctx.agents.listAgents().find((a) => a.id === requireAgentChannel(ctx.channel));
      const cwd = project?.path ?? hubAgent?.cwd;
      if (!cwd) {
        post(
          ctx.bus,
          ctx.channel,
          "This chat isn't filed under a project, so there is no directory to diff. File it under one, or run /diff from an agent's hub to diff that agent's working directory.",
        );
        return true;
      }
      const result = await projectDiff({
        cwd,
        projectName: project?.name ?? cwd,
        // A hub has no chat, so there is no "since this chat started" there - the agent's whole
        // history is the honest window, and saying so beats inventing a start time.
        since: chat?.createdAt ?? new Date(0).toISOString(),
        stat: wantsStat,
      });
      post(ctx.bus, ctx.channel, result.text);
      return true;
    }

    /**
     * Which login each agent is running on, and switching one to another.
     *
     * Everything shown is what each CLI's own read-only status command said about the directory
     * that agent's credentials are relocated to - see core/providerAccounts.ts. A CLI that has no
     * read-only way to report is shown as "sign-in state not reported", never as signed out.
     */
    case "accounts": {
      const [handleToken, ...labelParts] = rest;
      const label = labelParts.join(" ").trim();

      if (handleToken) {
        const agent = findAgentByHandle(ctx.agents, handleToken);
        if (!agent) {
          post(ctx.bus, ctx.channel, `no agent called ${handleToken}`);
          return true;
        }
        if (!label) {
          post(ctx.bus, ctx.channel, `usage: /accounts @${agent.handle} <account label>, or "default" for the CLI's own login`);
          return true;
        }
        if (!supportsMultipleAccounts(agent.provider)) {
          post(
            ctx.bus,
            ctx.channel,
            `${agent.provider} keeps one login that Solace cannot separate, so @${agent.handle} cannot be switched. ` +
              `Nothing changed. (core/providerAccounts.ts records exactly what was tried for each provider it does not support.)`,
          );
          return true;
        }
        if (label.toLowerCase() === "default") {
          ctx.agents.updateAgent(agent.id, { account: undefined });
          post(ctx.bus, ctx.channel, `@${agent.handle} is back on ${agent.provider}'s own default login.`);
          return true;
        }
        if (!isValidAccountLabel(label)) {
          post(ctx.bus, ctx.channel, `"${label}" is not a valid account name - letters, digits, spaces, - and _ only.`);
          return true;
        }
        const known = await (ctx.accounts ?? listAccounts)(agent.provider);
        if (!known.some((a) => a.label === label)) {
          const how = signInCommandFor(agent.provider, label);
          post(
            ctx.bus,
            ctx.channel,
            [
              `There is no "${label}" account for ${agent.provider} yet, so @${agent.handle} was NOT switched.`,
              "Solace cannot sign anyone in - that is a login you perform. Run this in your own terminal first:",
              how ? `  ${how.powershell}` : "  (this provider has no sign-in command recorded)",
              how?.note ? `  ${how.note}` : "",
              "then run this command again.",
            ]
              .filter(Boolean)
              .join("\n"),
          );
          return true;
        }
        ctx.agents.updateAgent(agent.id, { account: label });
        post(ctx.bus, ctx.channel, `@${agent.handle} is now on the "${label}" account. Its next turn uses that login; the turn running now does not.`);
        return true;
      }

      const agents = ctx.agents.listAgents();
      if (agents.length === 0) {
        post(ctx.bus, ctx.channel, "no agents configured yet");
        return true;
      }
      const providers = [...new Set(agents.map((a) => a.provider))];
      const probe = ctx.accounts ?? listAccounts;
      const identities = new Map(await Promise.all(providers.map(async (p) => [p, await probe(p)] as const)));
      const lines = agents.map((a) => {
        if (!supportsMultipleAccounts(a.provider)) {
          return `${a.handle} - ${a.provider} · one login, which Solace cannot separate for this CLI`;
        }
        const on = a.account ?? "(the CLI's own default login)";
        const identity = (identities.get(a.provider) ?? []).find((i) => i.label === a.account);
        const who = !identity
          ? "not probed"
          : identity.identityUnknown
            ? "sign-in state not reported by this CLI"
            : identity.loggedIn
              ? `signed in${identity.email ? ` as ${identity.email}` : ""}${identity.subscriptionType ? ` (${identity.subscriptionType})` : ""}`
              : "signed out";
        return `${a.handle} - ${a.provider} · on ${on} · ${who}`;
      });
      post(
        ctx.bus,
        ctx.channel,
        [
          "Accounts each agent is running on:",
          ...lines,
          "",
          "/accounts @handle <label> switches one. Solace never signs anyone in - it hands you the command to run yourself.",
        ].join("\n"),
      );
      return true;
    }

    default:
      post(ctx.bus, ctx.channel, `unknown command /${name} - try /help. The commands are also offered as you type "/".`);
      return true;
  }
}

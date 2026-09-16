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

    default:
      post(ctx.bus, ctx.channel, `unknown command /${name} - try /help`);
      return true;
  }
}

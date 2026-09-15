import { nanoid } from "nanoid";
import type { ChatChannel } from "@solace/shared";
import type { AgentManager } from "./agentManager";
import type { ChatBus } from "./chatBus";
import type { ArchiveStore } from "./archiveStore";
import { checkGithubAuth } from "./github";
import { listCredentials, listSshCredentials } from "./credentials";
import { WORKSPACE_ROOT } from "./workspace";
import type { SshCredentialMeta } from "@solace/shared";

export interface CommandContext {
  channel: ChatChannel;
  agents: AgentManager;
  bus: ChatBus;
  archive: ArchiveStore;
}

const HELP_TEXT = [
  "/task @handle <description> - set that agent's current task",
  "/status - summarize every agent's state, model, and task",
  "/github status - check gh auth on this machine",
  "/github init <repo-name> - (from an agent's own hub) ask it to init + push a GitHub repo",
  "/deploy list - show the SSH deploy targets saved under Connections",
  "/deploy <target> [what to do] - (from an agent's own hub) hand it a target's connection details",
  "/vault - list what's saved in the vault by name (values are never shown in chat)",
  "/clear - archive this channel's history (nothing is deleted - see Saved chats)",
  "/model <value> - (from an agent's own hub) switch its model",
  "/effort <value> - (from an agent's own hub) switch its thinking effort",
  "/reset - (from an agent's own hub) forget its session so the next turn starts fresh",
  "/usage - real rate-limit usage each provider has actually reported",
  "/help - show this list",
].join("\n");

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

/** Only meaningful inside one agent's own hub channel - group chat has no single "current agent". */
function requireAgentChannel(channel: ChatChannel): string | undefined {
  return channel === "group" ? undefined : channel.agentId;
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

    case "clear": {
      const removed = ctx.bus.clearChannel(ctx.channel);
      const channel = ctx.channel;
      const label =
        channel === "group"
          ? "Group chat"
          : `${ctx.agents.listAgents().find((a) => a.id === channel.agentId)?.handle ?? "an agent"}'s hub`;
      ctx.archive.add(ctx.channel, removed, label);
      return true;
    }

    case "reset": {
      const agentId = requireAgentChannel(ctx.channel);
      if (!agentId) {
        post(ctx.bus, ctx.channel, "/reset only works from an agent's own hub, not the group chat");
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
        post(ctx.bus, ctx.channel, `/${name} only works from an agent's own hub, not the group chat`);
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
          post(ctx.bus, ctx.channel, "/github init only works from an agent's own hub, not the group chat");
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

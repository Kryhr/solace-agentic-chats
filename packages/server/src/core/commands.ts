import { nanoid } from "nanoid";
import type { ChatChannel } from "@solace/shared";
import type { AgentManager } from "./agentManager";
import type { ChatBus } from "./chatBus";
import type { ArchiveStore } from "./archiveStore";
import { checkGithubAuth } from "./github";

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
  "/clear - archive this channel's history (nothing is deleted - see Saved chats)",
  "/model <value> - (from an agent's own hub) switch its model",
  "/effort <value> - (from an agent's own hub) switch its thinking effort",
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

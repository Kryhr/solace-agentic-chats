import Fastify from "fastify";
import cors from "@fastify/cors";
import websocketPlugin from "@fastify/websocket";
import { nanoid } from "nanoid";
import type { AgentConfig, ServerEvent } from "@solace/shared";
import { ChatBus } from "./core/chatBus";
import { AgentManager } from "./core/agentManager";
import { WORKSPACE_ROOT, createProject, ensureWorkspaceRoot, listProjects } from "./core/workspace";
import { checkAllProviders, testProvider } from "./core/providerStatus";
import { getModelCatalog } from "./core/modelCatalog";
import { getPermissionCatalog } from "./core/permissionCatalog";
import { debounce, loadState, saveState } from "./core/persistence";
import { ApprovalRegistry } from "./core/approvalRegistry";
import { ArchiveStore } from "./core/archiveStore";
import { tryHandleCommand } from "./core/commands";
import { checkGithubAuth } from "./core/github";
import { deleteCredential, listCredentials, saveCredential } from "./core/credentials";
import { validateAgentPatch, validateNewAgentConfig } from "./core/validateAgentConfig";
import type { ProviderId } from "@solace/shared";

const PORT = Number(process.env.PORT ?? 4310);

async function main() {
  ensureWorkspaceRoot();

  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });
  await app.register(websocketPlugin);

  const persisted = loadState(WORKSPACE_ROOT);
  const bus = new ChatBus(persisted.history);
  const approvals = new ApprovalRegistry();
  const archive = new ArchiveStore(persisted.archives);
  const agents = new AgentManager(bus, persisted.agents, approvals, persisted.queues);

  const persist = debounce(
    () =>
      saveState(WORKSPACE_ROOT, {
        agents: agents.listAgents(),
        history: bus.getHistory(),
        archives: archive.list(),
        queues: agents.getPersistableQueues(),
      }),
    300,
  );
  bus.onChange = persist;
  agents.onChange = persist;

  app.get("/api/projects", async () => ({ root: WORKSPACE_ROOT, projects: listProjects() }));

  app.post<{ Body: { name: string } }>("/api/projects", async (req, reply) => {
    try {
      const project = createProject(req.body.name);
      reply.code(201);
      return project;
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  // Every connected browser tab gets a live feed of chat + status events.
  app.get("/ws", { websocket: true }, (socket) => {
    // Group channel only - a client fetches an agent's direct history on demand when it opens
    // that agent's hub (fetchAgentDirectHistory), same as the initial REST fetch below.
    socket.send(
      JSON.stringify({
        type: "hello",
        history: bus.getHistoryFor("group"),
        agents: agents.listAgents(),
        statuses: agents.listStatuses(),
        approvals: approvals.listPending(),
      }),
    );
    const unsubscribe = bus.subscribe((event: ServerEvent) => {
      socket.send(JSON.stringify(event));
    });
    socket.on("close", unsubscribe);
  });

  app.get("/api/agents", async () => agents.listAgents());
  app.get("/api/agents/status", async () => agents.listStatuses());

  app.post<{ Body: Partial<Omit<AgentConfig, "id">> }>("/api/agents", async (req, reply) => {
    const existingHandles = agents.listAgents().map((a) => a.handle);
    const validated = validateNewAgentConfig(req.body, existingHandles);
    if ("error" in validated) {
      reply.code(400);
      return { error: validated.error };
    }
    const config: AgentConfig = { id: nanoid(), ...validated.config };
    agents.addAgent(config);
    reply.code(201);
    return config;
  });

  app.patch<{
    Params: { id: string };
    Body: Partial<Pick<AgentConfig, "trustLevel" | "currentTask" | "model" | "effort" | "authMode" | "credentialId">>;
  }>("/api/agents/:id", async (req, reply) => {
    const validated = validateAgentPatch(req.body);
    if ("error" in validated) {
      reply.code(400);
      return { error: validated.error };
    }
    const updated = agents.updateAgent(req.params.id, validated.patch);
    if (!updated) {
      reply.code(404);
      return { error: "agent not found" };
    }
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/agents/:id", async (req, reply) => {
    const target = agents.listAgents().find((a) => a.id === req.params.id);
    if (!target) {
      reply.code(404);
      return { error: "agent not found" };
    }
    // Removing an agent doesn't lose its direct-channel history - archive it first, same as
    // /clear. Capture the handle now, before the agent is gone, so Saved Chats can still show
    // who this was instead of a generic placeholder once the agent no longer exists.
    const channel = { agentId: req.params.id };
    const removed = bus.clearChannel(channel);
    archive.add(channel, removed, `${target.handle}'s hub`);
    agents.removeAgent(req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/agents/:id/stop", async (req, reply) => {
    const stopped = agents.stopAgent(req.params.id);
    if (!stopped) {
      reply.code(404);
      return { error: "agent not found or has no turn in flight" };
    }
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/agents/:id/retry", async (req, reply) => {
    const retried = agents.retryAgent(req.params.id);
    if (!retried) {
      reply.code(404);
      return { error: "agent not found or has nothing to retry" };
    }
    return { ok: true };
  });

  app.get("/api/providers/status", async () => checkAllProviders());
  app.get("/api/providers/models", async () => getModelCatalog());
  app.get("/api/providers/permission-modes", async () => getPermissionCatalog());

  app.post<{ Params: { provider: ProviderId } }>("/api/providers/:provider/test", async (req) => {
    return testProvider(req.params.provider, WORKSPACE_ROOT);
  });

  // Group channel only - direct per-agent history is served by /api/agents/:id/chat below.
  app.get("/api/chat/history", async () => bus.getHistoryFor("group"));

  app.post<{ Body: { text: string } }>("/api/chat", async (req) => {
    const handled = await tryHandleCommand(req.body.text, { channel: "group", agents, bus, archive });
    if (!handled) agents.submitMessage("user", "you", req.body.text);
    return { ok: true };
  });

  // Direct 1:1 channel with a single agent, separate from the shared group chat.
  app.get<{ Params: { id: string } }>("/api/agents/:id/chat", async (req) => {
    return bus.getHistoryFor({ agentId: req.params.id });
  });

  app.post<{ Params: { id: string }; Body: { text: string } }>("/api/agents/:id/chat", async (req) => {
    const channel = { agentId: req.params.id };
    const handled = await tryHandleCommand(req.body.text, { channel, agents, bus, archive });
    if (!handled) agents.submitDirectMessage(req.params.id, req.body.text);
    return { ok: true };
  });

  app.get("/api/archives", async () => archive.list());

  app.get("/api/github/status", async () => checkGithubAuth());

  app.get("/api/credentials", async () => listCredentials(WORKSPACE_ROOT));

  app.post<{ Body: { provider: ProviderId; label: string; apiKey: string } }>("/api/credentials", async (req, reply) => {
    reply.code(201);
    return saveCredential(WORKSPACE_ROOT, req.body.provider, req.body.label, req.body.apiKey);
  });

  app.delete<{ Params: { id: string } }>("/api/credentials/:id", async (req, reply) => {
    const ok = deleteCredential(WORKSPACE_ROOT, req.params.id);
    if (!ok) {
      reply.code(404);
      return { error: "not found" };
    }
    // Any agent still pointing at this now-deleted credential would otherwise keep an
    // authMode of "api-key" with a dangling credentialId, and silently fail its next turn
    // with no visible explanation - fall those agents back to CLI/subscription mode instead,
    // and post a system message into that agent's own hub so the change isn't silent (a user
    // would otherwise only discover this the next time the agent unexpectedly spawns a real
    // CLI process instead of calling the API).
    for (const agent of agents.listAgents()) {
      if (agent.credentialId === req.params.id) {
        agents.updateAgent(agent.id, { authMode: "cli", credentialId: undefined });
        bus.postMessage({
          id: nanoid(),
          channel: { agentId: agent.id },
          authorId: "system",
          authorHandle: "system",
          mentions: [],
          text: "This agent's saved API key was deleted - it has been switched back to CLI/subscription sign-in.",
          createdAt: new Date().toISOString(),
        });
      }
    }
    return { ok: true };
  });

  // Internal only - called by the per-turn approval bridge script (approval/bridgeScript.mjs),
  // never by the browser. Blocks (from the bridge script's perspective) until a human resolves
  // the approval via POST /api/approvals/:id/resolve below.
  app.post<{ Body: { agentId: string; description: string } }>("/internal/approvals", async (req) => {
    const { id, wait } = approvals.create(req.body.agentId, req.body.description);
    bus.emitEvent({ type: "approval:requested", payload: approvals.get(id)! });
    // AgentRunState already had a dedicated "waiting-approval" value (with its own sidebar
    // label/color) but nothing ever actually set it - an agent blocked here for minutes still
    // showed as plain "thinking", indistinguishable from genuinely working.
    agents.setStatus(req.body.agentId, "waiting-approval");
    const approved = await wait;
    agents.setStatus(req.body.agentId, "thinking");
    bus.emitEvent({ type: "approval:resolved", payload: { id, approved } });
    return { approved };
  });

  app.post<{ Params: { id: string }; Body: { approved: boolean } }>("/api/approvals/:id/resolve", async (req, reply) => {
    const ok = approvals.resolve(req.params.id, req.body.approved);
    if (!ok) {
      reply.code(404);
      return { error: "already resolved or expired" };
    }
    return { ok: true };
  });

  await app.listen({ port: PORT, host: "0.0.0.0" });
  app.log.info(`solace-agentic-chats server listening on http://localhost:${PORT}`);
  app.log.info(`workspace root: ${WORKSPACE_ROOT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

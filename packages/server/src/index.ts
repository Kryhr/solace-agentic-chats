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
import { tryHandleCommand } from "./core/commands";
import { checkGithubAuth } from "./core/github";
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
  const agents = new AgentManager(bus, persisted.agents, approvals);

  const persist = debounce(() => saveState(WORKSPACE_ROOT, { agents: agents.listAgents(), history: bus.getHistory() }), 300);
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
      JSON.stringify({ type: "hello", history: bus.getHistoryFor("group"), agents: agents.listAgents(), statuses: agents.listStatuses() }),
    );
    const unsubscribe = bus.subscribe((event: ServerEvent) => {
      socket.send(JSON.stringify(event));
    });
    socket.on("close", unsubscribe);
  });

  app.get("/api/agents", async () => agents.listAgents());
  app.get("/api/agents/status", async () => agents.listStatuses());

  app.post<{ Body: Omit<AgentConfig, "id"> }>("/api/agents", async (req, reply) => {
    const config: AgentConfig = { id: nanoid(), ...req.body };
    agents.addAgent(config);
    reply.code(201);
    return config;
  });

  app.patch<{
    Params: { id: string };
    Body: Partial<Pick<AgentConfig, "trustLevel" | "currentTask" | "model" | "effort">>;
  }>("/api/agents/:id", async (req) => {
    agents.updateAgent(req.params.id, req.body);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/agents/:id", async (req) => {
    agents.removeAgent(req.params.id);
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
    const handled = await tryHandleCommand(req.body.text, { channel: "group", agents, bus });
    if (!handled) agents.submitMessage("user", "you", req.body.text);
    return { ok: true };
  });

  // Direct 1:1 channel with a single agent, separate from the shared group chat.
  app.get<{ Params: { id: string } }>("/api/agents/:id/chat", async (req) => {
    return bus.getHistoryFor({ agentId: req.params.id });
  });

  app.post<{ Params: { id: string }; Body: { text: string } }>("/api/agents/:id/chat", async (req) => {
    const channel = { agentId: req.params.id };
    const handled = await tryHandleCommand(req.body.text, { channel, agents, bus });
    if (!handled) agents.submitDirectMessage(req.params.id, req.body.text);
    return { ok: true };
  });

  app.get("/api/github/status", async () => checkGithubAuth());

  // Internal only - called by the per-turn approval bridge script (approval/bridgeScript.mjs),
  // never by the browser. Blocks (from the bridge script's perspective) until a human resolves
  // the approval via POST /api/approvals/:id/resolve below.
  app.post<{ Body: { agentId: string; description: string } }>("/internal/approvals", async (req) => {
    const { id, wait } = approvals.create(req.body.agentId, req.body.description);
    bus.emitEvent({ type: "approval:requested", payload: approvals.get(id)! });
    const approved = await wait;
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

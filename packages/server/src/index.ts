import Fastify from "fastify";
import cors from "@fastify/cors";
import websocketPlugin from "@fastify/websocket";
import { nanoid } from "nanoid";
import type { AgentConfig, ServerEvent } from "@solace/shared";
import { ChatBus } from "./core/chatBus";
import { AgentManager } from "./core/agentManager";
import { WORKSPACE_ROOT, createProject, ensureWorkspaceRoot, listProjects } from "./core/workspace";
import { checkAllProviders, testProvider } from "./core/providerStatus";
import { debounce, loadState, saveState } from "./core/persistence";
import type { ProviderId } from "@solace/shared";

const PORT = Number(process.env.PORT ?? 4310);

async function main() {
  ensureWorkspaceRoot();

  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });
  await app.register(websocketPlugin);

  const persisted = loadState(WORKSPACE_ROOT);
  const bus = new ChatBus(persisted.history);
  const agents = new AgentManager(bus, persisted.agents);

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
    socket.send(JSON.stringify({ type: "hello", history: bus.getHistory(), agents: agents.listAgents(), statuses: agents.listStatuses() }));
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

  app.patch<{ Params: { id: string }; Body: Partial<Pick<AgentConfig, "trustLevel" | "currentTask">> }>(
    "/api/agents/:id",
    async (req) => {
      agents.updateAgent(req.params.id, req.body);
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>("/api/agents/:id", async (req) => {
    agents.removeAgent(req.params.id);
    return { ok: true };
  });

  app.get("/api/providers/status", async () => checkAllProviders());

  app.post<{ Params: { provider: ProviderId } }>("/api/providers/:provider/test", async (req) => {
    return testProvider(req.params.provider, WORKSPACE_ROOT);
  });

  app.get("/api/chat/history", async () => bus.getHistory());

  app.post<{ Body: { text: string } }>("/api/chat", async (req) => {
    agents.submitMessage("user", "you", req.body.text);
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

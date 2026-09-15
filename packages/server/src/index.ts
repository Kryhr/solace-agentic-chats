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
import {
  deleteCredential,
  getCredentialsFileProtection,
  listCredentials,
  saveCredential,
  saveSshCredential,
  type SshCredentialInput,
} from "./core/credentials";
import { validateAgentPatch, validateNewAgentConfig } from "./core/validateAgentConfig";
import {
  importSkillsFromRepo,
  installSkill,
  isKnownProjectPath,
  isKnownSkillSource,
  listAllSkills,
  rememberImportedRepo,
  withInstalledIn,
} from "./core/skills";
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
  const agents = new AgentManager(bus, persisted.agents, approvals, persisted.queues, persisted.sessions);

  const persist = debounce(
    () =>
      saveState(WORKSPACE_ROOT, {
        agents: agents.listAgents(),
        history: bus.getHistory(),
        archives: archive.list(),
        queues: agents.getPersistableQueues(),
        sessions: agents.getPersistableSessions(),
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

  /**
   * A skill is "installed" for a project when `<project>/.claude/skills/<name>/` exists, so
   * the per-project installed flags are computed from disk on every request rather than
   * tracked in any state file - nothing can drift out of sync with what Claude Code will
   * actually load.
   */
  app.get("/api/skills", async () => {
    const projects = listProjects();
    return { projects, skills: withInstalledIn(listAllSkills(), projects) };
  });

  app.post<{ Body: { sourcePath: string; projectPath: string } }>("/api/skills/install", async (req, reply) => {
    // sourcePath/projectPath arrive as plain client-supplied strings - installSkill() itself
    // trusts them completely (it's a filesystem copy), so this is the boundary that has to
    // reject anything that isn't a real skill this server already listed and a real project
    // this server already knows about, rather than letting a client point the copy at
    // (or from) an arbitrary path.
    if (!isKnownSkillSource(req.body.sourcePath)) {
      reply.code(400);
      return { error: "unknown skill" };
    }
    if (!isKnownProjectPath(req.body.projectPath)) {
      reply.code(400);
      return { error: "unknown project" };
    }
    try {
      return installSkill(req.body.sourcePath, req.body.projectPath);
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.post<{ Body: { repoUrl: string } }>("/api/skills/import-repo", async (req, reply) => {
    try {
      const skills = await importSkillsFromRepo(req.body.repoUrl);
      rememberImportedRepo(req.body.repoUrl.trim());
      return { skills: withInstalledIn(skills, listProjects()) };
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.get("/api/github/status", async () => checkGithubAuth());

  app.get("/api/credentials", async () => listCredentials(WORKSPACE_ROOT));

  app.post<{
    Body: {
      kind?: "api-key" | "ssh";
      provider: ProviderId;
      label: string;
      apiKey: string;
      baseUrl?: string;
      connectionName?: string;
    } & SshCredentialInput;
  }>("/api/credentials", async (req, reply) => {
    if (req.body.kind === "ssh") {
      try {
        const saved = saveSshCredential(WORKSPACE_ROOT, req.body);
        reply.code(201);
        return saved;
      } catch (err) {
        reply.code(400);
        // saveSshCredential's messages are built from named fields only - the request body,
        // which may carry pasted key material, is never echoed back here or logged.
        return { error: (err as Error).message };
      }
    }
    // baseUrl/connectionName only mean anything for provider "custom" (an arbitrary
    // OpenAI-compatible endpoint); they're harmless but meaningless on the built-in ones.
    if (req.body.provider === "custom" && !req.body.baseUrl?.trim()) {
      reply.code(400);
      return { error: "a custom connection needs a base URL" };
    }
    reply.code(201);
    return saveCredential(
      WORKSPACE_ROOT,
      req.body.provider,
      req.body.label,
      req.body.apiKey,
      req.body.baseUrl,
      req.body.connectionName,
    );
  });

  /** Whether the plaintext credentials file is actually protected on this machine, so the UI
   * can say so honestly rather than implying POSIX 0600 semantics on Windows. Reports only the
   * result of the last write - undefined until something has been saved this run. */
  app.get("/api/credentials/protection", async () => getCredentialsFileProtection() ?? { unknown: true });

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
        // "custom" has no CLI to fall back to (getAdapter throws for custom+cli) - forcing
        // authMode back to "cli" for it would leave the agent permanently broken with no UI
        // path to fix it (AddAgentModal never offers a sign-in-method choice for "custom").
        // Leaving authMode as "api-key" with no credentialId instead produces a clear,
        // actionable "no API key configured for this agent" error on its next turn via the
        // adapter's own existing check, from a state the user can actually recover from
        // (save a new connection under Connections, or delete/recreate the agent).
        const isCustom = agent.provider === "custom";
        agents.updateAgent(agent.id, isCustom ? { credentialId: undefined } : { authMode: "cli", credentialId: undefined });
        bus.postMessage({
          id: nanoid(),
          channel: { agentId: agent.id },
          authorId: "system",
          authorHandle: "system",
          mentions: [],
          text: isCustom
            ? "This agent's saved connection was deleted - add a new one under Connections in the sidebar, or it will error on its next message."
            : "This agent's saved API key was deleted - it has been switched back to CLI/subscription sign-in.",
          createdAt: new Date().toISOString(),
        });
      }
    }
    return { ok: true };
  });

  // Internal only - called by the per-turn approval bridge script (approval/bridgeScript.mjs),
  // never by the browser. Blocks (from the bridge script's perspective) until a human resolves
  // the approval via POST /api/approvals/:id/resolve below.
  // /internal/* is the channel helper processes spawned BY a turn use to call back in. It is
  // not part of the public API and nothing outside this machine has any business reaching it,
  // but the server binds 0.0.0.0 so the user can open the UI from another device - so rather
  // than moving the whole server to loopback and breaking that, the internal surface alone is
  // restricted here. Two independent checks, because either one alone is weak: the caller must
  // be on the loopback interface, AND must present the secret for a turn that is running now.
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/internal/")) return;
    const ip = req.ip;
    const isLoopback = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
    if (!isLoopback) {
      req.log.warn({ ip, url: req.url }, "rejected non-loopback request to an internal route");
      reply.code(403).send({ error: "internal routes are local-only" });
    }
  });

  app.post<{ Body: { agentId: string; turnToken?: string; description: string } }>("/internal/approvals", async (req, reply) => {
    if (!agents.verifyTurnToken(req.body.agentId, req.body.turnToken)) {
      reply.code(403);
      return { error: "no matching in-flight turn" };
    }
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

  // Internal only - called by the per-turn solace MCP bridge (mcp/solaceBridge.mjs) that the
  // provider CLI spawns, never by the browser. Same loopback hook + turn-token pair as
  // /internal/approvals above.
  //
  // Both routes return IMMEDIATELY and deliberately await nothing the *target* agent does:
  // postFromCurrentTurn only enqueues a turn for whoever was mentioned. Awaiting that agent's
  // work here would block the posting agent's own CLI - which is still mid-turn waiting on this
  // tool call - for the entire duration of somebody else's turn.
  app.post<{ Body: { agentId: string; turnToken?: string; text: string; kind?: "question" | "work" | "fyi" } }>(
    "/internal/solace/post",
    async (req, reply) => {
      const result = agents.postFromCurrentTurn(req.body.agentId, req.body.turnToken, req.body.text, req.body.kind);
      // Every solace tool response doubles as the delivery channel for messages that arrived
      // for THIS agent while it was working (see AgentManager.takeInboundNotice). An agent
      // actually using its tools therefore learns about them within seconds, at a boundary it
      // chose, instead of being killed for them once INTERRUPT_GRACE_MS expires.
      if (result.ok) return { ok: true, inbound: agents.takeInboundNotice(req.body.agentId, req.body.turnToken) };
      // A bad/expired token is an authorization failure; a hit cap or empty text is a real
      // request from a real turn that we're refusing on purpose, so it isn't a 403.
      reply.code(result.reason === "no-turn" ? 403 : 400);
      return { ok: false, error: result.error };
    },
  );

  app.post<{ Body: { agentId: string; turnToken?: string } }>("/internal/solace/agents", async (req, reply) => {
    if (!agents.verifyTurnToken(req.body.agentId, req.body.turnToken)) {
      reply.code(403);
      return { error: "no matching in-flight turn" };
    }
    // The same roster /status renders, minus the caller itself (an agent asking who else is
    // here doesn't need to be told about itself) and minus anything it can't act on.
    const statuses = new Map(agents.listStatuses().map((s) => [s.agentId, s]));
    return {
      // Same piggy-backed delivery as /internal/solace/post - an agent that only ever calls
      // list_agents is still reachable mid-turn.
      inbound: agents.takeInboundNotice(req.body.agentId, req.body.turnToken),
      agents: agents
        .listAgents()
        .filter((a) => a.id !== req.body.agentId)
        .map((a) => ({
          handle: a.handle,
          provider: a.provider,
          state: statuses.get(a.id)?.state ?? "idle",
          currentTask: a.currentTask,
        })),
    };
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

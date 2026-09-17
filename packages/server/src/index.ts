import Fastify from "fastify";
import cors from "@fastify/cors";
import websocketPlugin from "@fastify/websocket";
import { nanoid } from "nanoid";
import {
  MCP_CATALOG,
  SETTING_DEFINITIONS,
  sanitizeAppSettings,
  type AgentConfig,
  type AppSettings,
  type ServerEvent,
} from "@solace/shared";
import { ChatBus } from "./core/chatBus";
import { ChatStore } from "./core/chatStore";
import { AgentManager } from "./core/agentManager";
import { WORKSPACE_ROOT, createProject, ensureWorkspaceRoot, listProjects } from "./core/workspace";
import { checkAllProviders, checkCliProvider, isCliProvider, testProvider } from "./core/providerStatus";
import { checkCredential, NotCheckableError } from "./core/connectionChecks";
import {
  CONNECTABLE_PROVIDERS,
  ConnectedProviderStore,
  connectableProvider,
  isConnectableProvider,
} from "./core/connectedProviders";
import { SERVER_PORT } from "./core/serverPort";
import {
  accountDir,
  accountEnv,
  isValidAccountLabel,
  listAccounts,
  signInCommandFor,
  supportsMultipleAccounts,
} from "./core/providerAccounts";
import { getModelCatalog } from "./core/modelCatalog";
import { getPermissionCatalog } from "./core/permissionCatalog";
import { debounce, loadState, saveState } from "./core/persistence";
import { ApprovalRegistry } from "./core/approvalRegistry";
import { ArchiveStore } from "./core/archiveStore";
import { SettingsStore } from "./core/settingsStore";
import { getCopilotQuota } from "./core/copilotQuota";
import { CoordinationBoard } from "./core/coordination";
import { isAllowedOrigin } from "./core/originPolicy";
import { tryHandleCommand } from "./core/commands";
import { checkGithubAuth, checkGithubConnection } from "./core/github";
import {
  canReadVaultAtTrustLevel,
  deleteCredential,
  findCredentialByLabel,
  getCredentialSecrets,
  getCredentialsFileProtection,
  listCredentials,
  revealCredential,
  saveCredential,
  saveLoginCredential,
  saveSecretCredential,
  saveSshCredential,
  type LoginCredentialInput,
  type SecretCredentialInput,
  type SshCredentialInput,
} from "./core/credentials";
import {
  McpServerStore,
  resolveMcpServers,
  setMcpServerProvider,
  testMcpServer,
  toPublicMcpServer,
  validateMcpServer,
  type McpServerInput,
} from "./core/mcpServers";
import { discoverModels, ModelDiscoveryError } from "./core/modelDiscovery";
import { LOCAL_RUNTIMES, probeNamedRuntime, scanForLocalServers } from "./core/localDiscovery";
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
import type { Block, ProviderId } from "@solace/shared";

// From core/serverPort.ts, which is the ONLY place the port is decided - the listener, the MCP
// bridge and the group-context block all read that one constant. See that file for why.
const PORT = SERVER_PORT;

/**
 * Loopback by DEFAULT. This server holds a credential vault (SSH keys, passwords, API tokens),
 * can reveal those secrets in plaintext over HTTP, and can create an agent that runs shell
 * commands unattended - and none of its /api routes require authentication, because until now
 * the only caller was a browser tab on the same machine.
 *
 * It used to bind 0.0.0.0 so the UI could be opened from another device. That also meant every
 * other device on the network could POST /api/credentials/:id/reveal. Opening the UI from a
 * phone is a real want (see the roadmap), so the capability is kept - but as something the user
 * turns on deliberately, with SOLACE_HOST=0.0.0.0, rather than the default nobody chose.
 */
const HOST = process.env.SOLACE_HOST ?? "127.0.0.1";

async function main() {
  ensureWorkspaceRoot();

  const app = Fastify({ logger: true });
  await app.register(cors, {
    origin: (origin, cb) => cb(null, isAllowedOrigin(origin ?? undefined)),
    credentials: true,
  });
  await app.register(websocketPlugin);

  const persisted = loadState(WORKSPACE_ROOT);
  const bus = new ChatBus(persisted.history);
  const approvals = new ApprovalRegistry();
  const archive = new ArchiveStore(persisted.archives);
  // settings first: ChatStore reads agentsFollowProjects live, so it needs the same store
  // object every other consumer has rather than a copy taken at boot.
  const settings = new SettingsStore(persisted.settings);
  const board = new CoordinationBoard(persisted.coordination);
  const chats = new ChatStore(persisted.chats, persisted.projects, settings);
  // User-registered MCP servers. The adapters do NOT take these through runTurn - they pull
  // them from the module-level provider registered just below, so that every path into a turn
  // (queue, retry, interrupt) gets them without each one having to remember to pass them. See
  // the note on setMcpServerProvider.
  const mcpServers = new McpServerStore(persisted.mcpServers);
  // Which CLIs the user has opted into, as opposed to which happen to be installed. See
  // core/connectedProviders.ts - an empty list here is the correct reading of an older state
  // file, not a failure to load one.
  const connectedClis = new ConnectedProviderStore(persisted.connectedCliProviders);
  setMcpServerProvider((agentId) => resolveMcpServers(mcpServers.list(), agentId, WORKSPACE_ROOT));
  const agents = new AgentManager(
    bus,
    chats,
    persisted.agents,
    approvals,
    persisted.queues,
    persisted.sessions,
    persisted.rateLimits,
    settings,
    board,
  );

  const persist = debounce(
    () =>
      saveState(WORKSPACE_ROOT, {
        agents: agents.listAgents(),
        history: bus.getHistory(),
        archives: archive.list(),
        queues: agents.getPersistableQueues(),
        sessions: agents.getPersistableSessions(),
        rateLimits: agents.listRateLimits(),
        chats: chats.listChats(),
        projects: chats.listProjects(),
        settings: settings.get(),
        coordination: board.snapshot(),
        mcpServers: mcpServers.list(),
        connectedCliProviders: connectedClis.list(),
      }),
    300,
  );
  mcpServers.onChange = persist;
  connectedClis.onChange = persist;
  bus.onChange = persist;
  agents.onChange = persist;
  settings.onChange = (next) => {
    persist();
    // Every tab shows the same Settings page, and these change how the server behaves for
    // everyone - a tab holding a stale toggle would misdescribe what is actually happening.
    bus.emitEvent({ type: "settings:updated", payload: next });
  };
  chats.onChange = () => {
    persist();
    // Every tab shows the same sidebar, so a chat created or renamed in one has to appear in
    // the others without a reload - this is the only event that carries that roster.
    bus.emitEvent({ type: "chats:updated", payload: { chats: chats.listChats(), projects: chats.listProjects() } });
  };

  // `projects` is every directory under the workspace root (what the Add-agent modal picks a
  // cwd from); `linked` is the subset the user has actually adopted as a Solace project. The
  // two are deliberately different lists: a folder existing is not the same as the user having
  // said "this is a project of mine".
  app.get("/api/projects", async () => ({
    root: WORKSPACE_ROOT,
    projects: listProjects(),
    linked: chats.listProjects(),
  }));

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

  /** Adopt a directory as a project, creating it if it isn't there yet. See ChatStore.linkProject. */
  app.post<{ Body: { name: string } }>("/api/projects/link", async (req, reply) => {
    try {
      const project = chats.linkProject(String(req.body?.name ?? ""));
      reply.code(201);
      return project;
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  /**
   * Add or remove one agent from one project's roster, for when agents otherwise follow the
   * user between projects. Nothing on disk changes and the agent itself is untouched - this
   * only decides whether that project's chats reach it.
   */
  app.patch<{ Params: { id: string }; Body: { agentId?: string; member?: boolean } }>(
    "/api/projects/:id/agents",
    async (req, reply) => {
      const { agentId, member } = req.body ?? {};
      if (typeof agentId !== "string" || !agentId || typeof member !== "boolean") {
        reply.code(400);
        return { error: "agentId (string) and member (boolean) are required" };
      }
      if (!agents.listAgents().some((a) => a.id === agentId)) {
        reply.code(404);
        return { error: "agent not found" };
      }
      if (!chats.setProjectMembership(req.params.id, agentId, member)) {
        reply.code(404);
        return { error: "project not found" };
      }
      return { ok: true, projects: chats.listProjects() };
    },
  );

  /**
   * Unlink a project. This deletes NOTHING on disk - not the folder, not a file in it - and the
   * chats filed under it simply become unfiled. The UI says so in as many words before asking.
   */
  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (req, reply) => {
    const removed = chats.unlinkProject(req.params.id);
    if (!removed) {
      reply.code(404);
      return { error: "project not found" };
    }
    return { ok: true, path: removed.path };
  });

  app.get("/api/chats", async () => ({ chats: chats.listChats(), projects: chats.listProjects() }));

  app.post<{ Body: { title?: string; projectId?: string } }>("/api/chats", async (req, reply) => {
    const chat = chats.createChat(req.body?.title, req.body?.projectId);
    reply.code(201);
    return chat;
  });

  app.patch<{ Params: { id: string }; Body: { title?: string; projectId?: string | null } }>(
    "/api/chats/:id",
    async (req, reply) => {
      if (!chats.updateChat(req.params.id, req.body ?? {})) {
        reply.code(404);
        return { error: "chat not found" };
      }
      return { ok: true };
    },
  );

  /**
   * Archive-then-remove, the same shape /clear and agent removal already use: the transcript
   * moves to Saved chats with the title it had at this moment, and only the room itself goes
   * away. Nothing here can lose a message.
   */
  app.delete<{ Params: { id: string } }>("/api/chats/:id", async (req, reply) => {
    const chat = chats.getChat(req.params.id);
    if (!chat) {
      reply.code(404);
      return { error: "chat not found" };
    }
    const channel = { chatId: chat.id };
    const removed = bus.clearChannel(channel);
    archive.add(channel, removed, chat.title);
    chats.removeChat(chat.id);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/chats/:id/history", async (req) => bus.getHistoryFor({ chatId: req.params.id }));

  app.post<{ Params: { id: string }; Body: { text: string } }>("/api/chats/:id/messages", async (req, reply) => {
    const chat = chats.getChat(req.params.id);
    if (!chat) {
      reply.code(404);
      return { error: "chat not found" };
    }
    const channel = { chatId: chat.id };
    const handled = await tryHandleCommand(req.body.text, { channel, agents, bus, chats, archive, board });
    if (!handled) agents.submitMessage(chat.id, "user", "you", req.body.text);
    return { ok: true };
  });

  // Every connected browser tab gets a live feed of chat + status events.
  app.get("/ws", { websocket: true }, (socket) => {
    // Rosters only - no transcript. With many chats, shipping every one of them on connect
    // would send the whole history file to a tab that will open exactly one; the client fetches
    // the chat it opens, the same way it already fetches an agent hub's history on demand.
    socket.send(
      JSON.stringify({
        type: "hello",
        chats: chats.listChats(),
        projects: chats.listProjects(),
        agents: agents.listAgents(),
        statuses: agents.listStatuses(),
        rateLimits: agents.listRateLimits(),
        approvals: approvals.listPending(),
        settings: settings.get(),
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
    // Drop this agent from every per-agent MCP scope, so a scope does not keep a dead id that
    // would silently re-attach a server if that id were ever reused.
    mcpServers.forgetAgent(req.params.id);
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

  // Copilot is merged in separately because, alone among the providers, it reports nothing
  // about its limits during a turn - so there is no event for RateLimitStore to have learned
  // from, and it was simply missing from the meter. Its quota is a cheap entitlement lookup
  // instead, memoised in copilotQuota.ts.
  // Copilot has no quota until something asks for it, so ask once at boot - otherwise the meter
  // shows nothing for it until its first turn finishes, which is exactly the gap being closed.
  void getCopilotQuota()
    .then((quota) => {
      if (quota) agents.recordRateLimit(quota);
    })
    .catch(() => {});

  app.get("/api/usage", async () => {
    const reported = agents.listRateLimits();
    if (reported.some((r) => r.provider === "copilot-cli")) return reported;
    const copilot = await getCopilotQuota();
    return copilot ? [...reported, copilot] : reported;
  });

  app.get("/api/providers/status", async () => checkAllProviders());
  app.get("/api/providers/models", async () => getModelCatalog());
  app.get("/api/providers/permission-modes", async () => getPermissionCatalog());

  app.post<{ Params: { provider: ProviderId } }>("/api/providers/:provider/test", async (req) => {
    return testProvider(req.params.provider, WORKSPACE_ROOT);
  });

  // Direct 1:1 channel with a single agent, separate from any chat.
  app.get<{ Params: { id: string } }>("/api/agents/:id/chat", async (req) => {
    return bus.getHistoryFor({ agentId: req.params.id });
  });

  app.post<{ Params: { id: string }; Body: { text: string } }>("/api/agents/:id/chat", async (req) => {
    const channel = { agentId: req.params.id };
    const handled = await tryHandleCommand(req.body.text, { channel, agents, bus, chats, archive, board });
    if (!handled) agents.submitDirectMessage(req.params.id, req.body.text);
    return { ok: true };
  });

  /**
   * App settings, and the schema the Settings page renders from. Served together so a client
   * can never show a control for a setting the server does not have, or miss one it does -
   * SETTING_DEFINITIONS in @solace/shared is the single definition of both.
   */
  app.get("/api/settings", async () => ({ settings: settings.get(), definitions: SETTING_DEFINITIONS }));

  app.patch<{ Body: Partial<AppSettings> }>("/api/settings", async (req) => {
    // Sanitized twice on purpose: once here so an unknown key in the body is visibly dropped
    // rather than merged, and again inside the store, which is the only thing that decides what
    // a legal settings object is.
    return settings.update(sanitizeAppSettings({ ...settings.get(), ...(req.body ?? {}) }));
  });

  /* ------------------------------- MCP servers ------------------------------ */

  // The catalogue rides along with the list so the panel renders in one round trip. It is a
  // static const in @solace/shared and the server branches on nothing in it - see the standing
  // honesty rule in that file.
  app.get("/api/mcp/servers", async () => ({ servers: mcpServers.listPublic(), catalog: MCP_CATALOG }));

  app.post<{ Body: McpServerInput }>("/api/mcp/servers", async (req, reply) => {
    const result = mcpServers.add(req.body ?? {});
    if ("error" in result) {
      reply.code(400);
      return result;
    }
    return { server: toPublicMcpServer(result.server) };
  });

  app.patch<{ Params: { id: string }; Body: McpServerInput }>("/api/mcp/servers/:id", async (req, reply) => {
    const result = mcpServers.update(req.params.id, req.body ?? {});
    if ("error" in result) {
      reply.code(result.error === "No such MCP server." ? 404 : 400);
      return result;
    }
    return { server: toPublicMcpServer(result.server) };
  });

  app.delete<{ Params: { id: string } }>("/api/mcp/servers/:id", async (req, reply) => {
    if (!mcpServers.remove(req.params.id)) {
      reply.code(404);
      return { error: "not found" };
    }
    return { ok: true };
  });

  /**
   * Spawn a server and list its tools - the "verified, not merely configured" step, and the
   * only thing in this feature that proves the configuration is real.
   *
   * Takes an UNSAVED draft as well as a saved id, because the point is to test before saving: a
   * user who has to save a broken server first, then discover it is broken, then edit it, has
   * been told nothing the first failing turn would not have told them. A draft's credential
   * references are resolved here exactly as they would be at turn time, so a wrong credential
   * id fails here rather than silently at 2am.
   */
  app.post<{ Body: McpServerInput & { id?: string } }>("/api/mcp/test", async (req, reply) => {
    const body = req.body ?? {};
    const saved = body.id ? mcpServers.get(body.id) : undefined;
    if (body.id && !saved) {
      reply.code(404);
      return { error: "not found" };
    }
    // A draft is validated against every OTHER server, so testing an edit of a saved server
    // does not trip over its own name.
    const draft = { ...(saved ?? {}), ...body };
    const checked = validateMcpServer(draft, mcpServers.list().filter((s) => s.id !== body.id));
    if ("error" in checked) {
      reply.code(400);
      return { ok: false, tools: [], error: checked.error };
    }
    const [resolved] = resolveMcpServers(
      [{ ...checked.value, id: body.id ?? "draft", createdAt: new Date().toISOString(), enabled: true, scope: { kind: "global" } }],
      // Any agent id resolves a global-scoped draft; the scope is forced to global just above
      // precisely so a per-agent server can still be tested without picking an agent first.
      "__test__",
      WORKSPACE_ROOT,
    );
    const result = await testMcpServer(resolved);
    // Only a real handshake records a verification, and only against a SAVED server - a draft
    // has no id to attach it to, and the save path re-checks whether the launch actually
    // changed before carrying a badge over (see McpServerStore.update).
    if (result.ok && saved) mcpServers.recordVerification(saved.id, result.tools);
    return result;
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

  /**
   * Everything Connections shows for GitHub, including `gh auth status`'s own text. GET
   * rather than POST because it is read-only and changes nothing - it is two `gh` reads.
   */
  app.get("/api/github/connection", async () => checkGithubConnection());

  /**
   * The cheap per-row check for a CLI provider: does the binary resolve on PATH and does
   * `--version` exit 0. Deliberately NOT the same thing as POST /api/providers/:provider/test
   * below, which runs a real billed turn - that one stays a separate, explicitly-labelled
   * action so nothing in the panel can spend the user's tokens by looking at it.
   */
  app.post<{ Params: { provider: ProviderId } }>("/api/connections/cli/:provider/check", async (req, reply) => {
    if (!isCliProvider(req.params.provider)) {
      reply.code(400);
      return { error: `"${req.params.provider}" is not a CLI provider - it has no binary to check` };
    }
    return checkCliProvider(req.params.provider);
  });

  /* ---------------------- Connected coding-agent CLIs ---------------------- */

  /**
   * The user's connected CLIs, and the catalogue the connect flow renders from.
   *
   * `connected` is NOT "what is installed". A binary on PATH is a fact about the machine; a
   * connection is a decision the user made, and only the second one belongs in their sidebar.
   * The catalogue rides along so the connect screen renders in one round trip, and carries each
   * CLI's real SIGN-IN command (with the `--help` invocation it was read from) rather than its
   * npm install line, which is a different step and useless to someone who already has it.
   */
  /**
   * The logins available for a provider, each identified by who it actually is.
   *
   * Without this the UI can only show "claude-code" twice and the user has no way to tell which
   * subscription an agent is on. `claude auth status` answers with the email and plan for a
   * given config directory and spends no turn doing it, so the honest identity is free.
   */
  app.get<{ Params: { provider: string } }>("/api/accounts/:provider", async (req, reply) => {
    const provider = req.params.provider as ProviderId;
    if (!supportsMultipleAccounts(provider)) {
      // Not an error: most providers simply have no verified way to hold two logins, and the
      // UI needs to know that so it can hide the control rather than offer a dead one.
      return { supported: false, accounts: [] };
    }
    void reply;
    return { supported: true, accounts: await listAccounts(provider) };
  });

  /**
   * Create an account slot and hand back the command that signs it in.
   *
   * Solace deliberately does NOT run that command: it is a browser device-login for somebody's
   * real subscription, and running it with the wrong environment is precisely how the existing
   * login gets overwritten - the failure this whole feature exists to prevent.
   */
  app.post<{ Params: { provider: string }; Body: { label?: string } }>(
    "/api/accounts/:provider",
    async (req, reply) => {
      const provider = req.params.provider as ProviderId;
      const label = (req.body?.label ?? "").trim();
      if (!supportsMultipleAccounts(provider)) {
        reply.code(400);
        return { error: `${provider} has no verified way to hold more than one login` };
      }
      if (!isValidAccountLabel(label)) {
        reply.code(400);
        return { error: "Use letters, numbers, spaces, - or _ (2-40 characters)" };
      }
      // Creates the directory, which is all an "account" is until the user signs in.
      accountEnv(provider, label);
      return { label, signIn: signInCommandFor(provider, label), dir: accountDir(provider, label) };
    },
  );

  app.get("/api/connections/cli/connected", async () => ({
    connected: connectedClis.list(),
    catalog: CONNECTABLE_PROVIDERS,
  }));

  /**
   * Connect one CLI - and this route is the reason the whole thing can be trusted.
   *
   * It runs the real `<bin> --version` FIRST and refuses on anything but a pass, handing back
   * the failing check verbatim plus the install command. Nothing else in the server can add to
   * the connected list, so there is no path by which a provider appears under "Coding agent
   * CLI" without having been run on this machine in the last few hundred milliseconds.
   *
   * 409, not 400, for "it isn't installed": the request was well-formed and the answer is about
   * the machine's state, not the request's. The body carries the ConnectionCheck itself so the
   * UI can quote what the probe actually said instead of paraphrasing a status code.
   */
  app.post<{ Params: { provider: string } }>("/api/connections/cli/connected/:provider", async (req, reply) => {
    const provider = req.params.provider;
    if (!isConnectableProvider(provider)) {
      reply.code(400);
      return { error: `"${provider}" is not a coding-agent CLI - there is no binary to connect.` };
    }
    const check = await checkCliProvider(provider);
    if (!check.ok) {
      reply.code(409);
      return {
        error: `${connectableProvider(provider)?.name ?? provider} is not on this machine's PATH, so it was not connected.`,
        check,
        installCommand: connectableProvider(provider)?.installCommand,
      };
    }
    const added = connectedClis.connect(provider);
    return { connected: connectedClis.list(), check, added };
  });

  /**
   * Disconnect one CLI. Removes it from the list and does nothing else: no binary is
   * uninstalled, no credential is deleted and nothing is signed out - which is exactly what the
   * UI says, so pressing this can never lose anything that isn't one line of JSON.
   */
  app.delete<{ Params: { provider: string } }>("/api/connections/cli/connected/:provider", async (req, reply) => {
    const provider = req.params.provider;
    if (!isConnectableProvider(provider)) {
      reply.code(400);
      return { error: `"${provider}" is not a coding-agent CLI.` };
    }
    const removed = connectedClis.disconnect(provider);
    return { connected: connectedClis.list(), removed };
  });

  /**
   * The real check behind one saved connection. POST because it makes an outbound request
   * against a possibly-paid endpoint or reads the user's filesystem: never something a page
   * load, a prefetch or a background poll may trigger. 422 for "there is genuinely nothing to
   * check here" (a stored password), which is a different answer from a check that ran and
   * failed - the UI must not paint the first as red.
   */
  app.post<{ Params: { id: string } }>("/api/credentials/:id/check", async (req, reply) => {
    try {
      return await checkCredential(WORKSPACE_ROOT, req.params.id);
    } catch (err) {
      reply.code(err instanceof NotCheckableError ? 422 : 500);
      return { error: (err as Error).message };
    }
  });

  app.get("/api/credentials", async () => listCredentials(WORKSPACE_ROOT));

  /**
   * The real model list this connection's endpoint reports for itself. Takes a credentialId
   * rather than a base URL + key from the client, so the raw key still never leaves the
   * server (see core/credentials.ts) - the client asks "what can THIS saved connection do".
   */
  app.get<{ Params: { id: string } }>("/api/credentials/:id/models", async (req, reply) => {
    const { key, baseUrl } = getCredentialSecrets(WORKSPACE_ROOT, req.params.id);
    if (!baseUrl) {
      reply.code(400);
      return { error: "this connection has no base URL to ask for a model list" };
    }
    try {
      return await discoverModels(baseUrl, key || undefined);
    } catch (err) {
      // 502, not 500: the failure is the upstream endpoint's, and the UI falls back to a
      // free-text model field rather than pretending discovery is mandatory.
      reply.code(err instanceof ModelDiscoveryError ? 502 : 500);
      return { error: (err as Error).message };
    }
  });

  /** The runtimes core/localDiscovery.ts knows how to positively identify, so the UI can
   * offer them by name for the ports the automatic scan deliberately won't touch. */
  app.get("/api/local/runtimes", async () =>
    LOCAL_RUNTIMES.map((r) => ({ id: r.id, name: r.name, defaultPort: r.defaultPort, autoScan: r.autoScan })),
  );

  /**
   * POST, not GET, because this is an action the user takes - it probes loopback ports on
   * their machine and must never be something a page load, a prefetch or a background poll
   * can trigger. See core/localDiscovery.ts for what "found" requires.
   */
  app.post("/api/local/scan", async () => scanForLocalServers());

  app.post<{ Body: { runtime: string; port?: number } }>("/api/local/probe", async (req, reply) => {
    const finding = await probeNamedRuntime(req.body.runtime, req.body.port);
    if (!finding) {
      reply.code(404);
      return { error: "nothing on that port identified itself as that runtime" };
    }
    return finding;
  });

  app.post<{
    Body: {
      kind?: "api-key" | "ssh" | "login" | "secret";
      provider: ProviderId;
      label: string;
      apiKey: string;
      baseUrl?: string;
      connectionName?: string;
      notes?: string;
    } & SshCredentialInput &
      LoginCredentialInput &
      SecretCredentialInput;
  }>("/api/credentials", async (req, reply) => {
    // Every non-api-key kind throws a plain-language message built from named fields only -
    // the request body, which carries the actual secret, is never echoed back or logged.
    if (req.body.kind === "ssh" || req.body.kind === "login" || req.body.kind === "secret") {
      try {
        const saved =
          req.body.kind === "ssh"
            ? saveSshCredential(WORKSPACE_ROOT, req.body)
            : req.body.kind === "login"
              ? saveLoginCredential(WORKSPACE_ROOT, req.body)
              : saveSecretCredential(WORKSPACE_ROOT, req.body);
        reply.code(201);
        return saved;
      } catch (err) {
        reply.code(400);
        return { error: (err as Error).message };
      }
    }
    // baseUrl/connectionName only mean anything for an arbitrary OpenAI-compatible endpoint
    // ("custom") or a local model server ("local"); they're harmless but meaningless on the
    // CLI-backed providers.
    const needsBaseUrl = req.body.provider === "custom" || req.body.provider === "local";
    if (needsBaseUrl && !req.body.baseUrl?.trim()) {
      reply.code(400);
      return { error: `a ${req.body.provider} connection needs a base URL` };
    }
    // A missing key is allowed (a local server normally has none) but only where there's a
    // base URL to call instead. For the CLI-backed providers a credential IS the key, so a
    // keyless one would be an empty row that silently breaks its agent's next turn.
    if (!needsBaseUrl && !req.body.apiKey?.trim()) {
      reply.code(400);
      return { error: `a ${req.body.provider} credential needs an API key` };
    }
    reply.code(201);
    return saveCredential(
      WORKSPACE_ROOT,
      req.body.provider,
      req.body.label,
      req.body.apiKey,
      req.body.baseUrl,
      req.body.connectionName,
      req.body.notes,
    );
  });

  /**
   * The one route that returns a real stored secret, for one entry, addressed by id.
   *
   * POST rather than GET on purpose. A GET would be reachable by a link, a prefetch, a
   * browser history entry and any background poll that walks the credential list - which is
   * precisely the "reveal happened without the user deciding to" case this is designed
   * against. It is also never folded into GET /api/credentials: listing and revealing stay
   * two different requests so that no amount of UI refactoring can make a list produce
   * secrets.
   *
   * The response body is not logged: Fastify's request logger records method and URL only,
   * and the URL here carries an opaque id. Nothing below interpolates a value into a log
   * line, an error message or a chat message.
   */
  app.post<{ Params: { id: string } }>("/api/credentials/:id/reveal", async (req, reply) => {
    const revealed = revealCredential(WORKSPACE_ROOT, req.params.id);
    if (!revealed) {
      reply.code(404);
      return { error: "not found" };
    }
    return revealed;
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
        // "custom"/"local" have no CLI to fall back to (getAdapter throws for either + cli) -
        // forcing authMode back to "cli" for them would leave the agent permanently broken
        // with no UI path to fix it (AddAgentModal never offers a sign-in-method choice for
        // an endpoint-backed provider).
        // Leaving authMode as "api-key" with no credentialId instead produces a clear,
        // actionable "no API key configured for this agent" error on its next turn via the
        // adapter's own existing check, from a state the user can actually recover from
        // (save a new connection under Connections, or delete/recreate the agent).
        const isCustom = agent.provider === "custom" || agent.provider === "local";
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

  /**
   * The coordination tools. Same loopback + turn-token pair as every other /internal route.
   *
   * All five are pure bookkeeping inside this app - they take a lane, publish a decision, say
   * what you are waiting for - so unlike /internal/solace/secret there is nothing here to gate
   * behind approval. Each returns `inbound` for the same reason every solace tool does: the
   * response is a boundary the agent chose to stop at, so it is a safe moment to hand it
   * anything that arrived while it was working.
   */
  app.post<{ Body: { agentId: string; turnToken?: string; paths?: string[]; note?: string } }>(
    "/internal/solace/claim",
    async (req, reply) => {
      const result = agents.claimFiles(req.body.agentId, req.body.turnToken, req.body.paths ?? [], req.body.note);
      if (!result.ok) {
        reply.code(403);
        return result;
      }
      return { ...result, inbound: agents.takeInboundNotice(req.body.agentId, req.body.turnToken) };
    },
  );

  app.post<{ Body: { agentId: string; turnToken?: string; paths?: string[] } }>(
    "/internal/solace/release",
    async (req, reply) => {
      const result = agents.releaseFiles(req.body.agentId, req.body.turnToken, req.body.paths);
      if (!result.ok) {
        reply.code(403);
        return result;
      }
      return { ...result, inbound: agents.takeInboundNotice(req.body.agentId, req.body.turnToken) };
    },
  );

  app.post<{ Body: { agentId: string; turnToken?: string; title?: string; body?: string } }>(
    "/internal/solace/contract",
    async (req, reply) => {
      const result = agents.postContract(req.body.agentId, req.body.turnToken, req.body.title ?? "", req.body.body ?? "");
      if (!result.ok) {
        // An empty title/body is a real request being refused on purpose, not an auth failure.
        reply.code(result.error === "no matching in-flight turn" ? 403 : 400);
        return result;
      }
      return { ...result, inbound: agents.takeInboundNotice(req.body.agentId, req.body.turnToken) };
    },
  );

  app.post<{ Body: { agentId: string; turnToken?: string; text?: string } }>(
    "/internal/solace/announce",
    async (req, reply) => {
      const result = agents.announce(req.body.agentId, req.body.turnToken, req.body.text ?? "");
      if (!result.ok) {
        reply.code(result.error === "no matching in-flight turn" ? 403 : 400);
        return result;
      }
      return { ...result, inbound: agents.takeInboundNotice(req.body.agentId, req.body.turnToken) };
    },
  );

  app.post<{ Body: { agentId: string; turnToken?: string; kind?: Block["kind"]; value?: string; why?: string } }>(
    "/internal/solace/block",
    async (req, reply) => {
      const result = agents.blockOn(
        req.body.agentId,
        req.body.turnToken,
        req.body.kind ?? "agent",
        req.body.value ?? "",
        req.body.why,
      );
      if (!result.ok) {
        reply.code(result.error === "no matching in-flight turn" ? 403 : 400);
        return result;
      }
      return { ...result, inbound: agents.takeInboundNotice(req.body.agentId, req.body.turnToken) };
    },
  );

  /**
   * How a running turn gets ONE vault entry's secret, addressed by the label the user gave
   * it. Same loopback + turn-token pair as every other /internal route, plus two rules that
   * only apply here:
   *
   *  - there is no "list every secret" form. The agent must name the entry it wants, so the
   *    system message below can name it too. `listCredentials` metadata is what tells the
   *    agent which labels exist, and that carries no secret.
   *  - a "plan" agent is refused. Plan mode is the level the user picks when they want the
   *    agent to think and not act; handing it live credentials is the opposite of that, and
   *    an agent that cannot run a command has nothing legitimate to sign into anyway.
   *
   * Every success posts a visible system message into that agent's own hub BEFORE the secret
   * is returned. The ordering matters: if the post throws, the secret is not handed over, so
   * there is no path where an agent holds a credential the user was never told about.
   */
  app.post<{ Body: { agentId: string; turnToken?: string; label?: string } }>(
    "/internal/solace/secret",
    async (req, reply) => {
      if (!agents.verifyTurnToken(req.body.agentId, req.body.turnToken)) {
        reply.code(403);
        return { ok: false, error: "no matching in-flight turn" };
      }
      const agent = agents.listAgents().find((a) => a.id === req.body.agentId);
      if (!agent) {
        reply.code(403);
        return { ok: false, error: "no matching in-flight turn" };
      }
      if (!canReadVaultAtTrustLevel(agent.trustLevel)) {
        reply.code(403);
        return {
          ok: false,
          error:
            "this agent is in plan mode, which cannot read saved credentials. Say what you would need and the user can raise your trust level or do it themselves.",
        };
      }

      const wanted = typeof req.body.label === "string" ? req.body.label.trim() : "";
      if (!wanted) {
        reply.code(400);
        return { ok: false, error: "name the saved entry you need, by its label" };
      }

      const match = findCredentialByLabel(WORKSPACE_ROOT, wanted);
      if (!match) {
        const labels = listCredentials(WORKSPACE_ROOT).map((c) => c.label);
        reply.code(404);
        // Labels are metadata, not secrets, and listing them is what stops an agent guessing
        // at names in a loop. No value of any kind is in this response.
        return {
          ok: false,
          error: labels.length
            ? `no saved entry called "${wanted}". Saved entries: ${labels.join(", ")}`
            : `no saved entry called "${wanted}" - nothing is saved in the vault yet`,
        };
      }

      const revealed = revealCredential(WORKSPACE_ROOT, match.id);
      if (!revealed || revealed.fields.length === 0) {
        reply.code(404);
        return { ok: false, error: `"${match.label}" has no stored secret value` };
      }

      bus.postMessage({
        id: nanoid(),
        channel: { agentId: agent.id },
        authorId: "system",
        authorHandle: "system",
        mentions: [],
        // Names the entry and the time, never the value. The user finding this out afterwards
        // from a log they had to go looking for would be the same as not telling them.
        text: `${agent.handle} read the saved credential "${revealed.label}" (${revealed.kind}) from your vault just now, to use during this turn.`,
        createdAt: new Date().toISOString(),
      });

      return {
        ok: true,
        label: revealed.label,
        kind: revealed.kind,
        fields: revealed.fields.map((f) => ({ name: f.name, value: f.value })),
        inbound: agents.takeInboundNotice(req.body.agentId, req.body.turnToken),
      };
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

  await app.listen({ port: PORT, host: HOST });
  app.log.info(`Solace server listening on http://localhost:${PORT}`);
  if (HOST !== "127.0.0.1") {
    // Said loudly, every start, because this exposes a plaintext credential vault and unattended
    // shell execution to every device on the network, and nothing else on this server will stop
    // them: the /api routes have no authentication of any kind.
    app.log.warn(
      `SOLACE_HOST=${HOST}: this server is reachable from other devices on your network. ` +
        `It has no authentication, and it can reveal saved credentials and run commands. ` +
        `Only do this on a network you trust.`,
    );
  }
  app.log.info(`workspace root: ${WORKSPACE_ROOT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

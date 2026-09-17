import type {
  AgentConfig,
  AgentStatus,
  AppSettings,
  SettingDefinition,
  ChatChannel,
  ChatMessage,
  ChatMeta,
  ConnectionCheck,
  GithubConnection,
  ProjectMeta,
  CatalogMcpServer,
  CredentialMeta,
  CredentialReveal,
  LocalServerFinding,
  McpEnvEntry,
  McpServerConfig,
  McpServerScope,
  ModelDiscoveryResult,
  PendingApproval,
  ProviderId,
  ProviderModelInfo,
  ProviderPermissionInfo,
  ProviderStatus,
  ProviderRateLimit,
  ServerEvent,
} from "@solace/shared";

export interface ProjectInfo {
  name: string;
  path: string;
}

export async function fetchAgents(): Promise<AgentConfig[]> {
  return fetch("/api/agents").then((r) => r.json());
}

export async function fetchProjects(): Promise<{ root: string; projects: ProjectInfo[]; linked: ProjectMeta[] }> {
  return fetch("/api/projects").then((r) => r.json());
}

/** Adopt a directory as a project, creating it if it doesn't exist yet. */
export async function linkProject(name: string): Promise<ProjectMeta> {
  const res = await fetch("/api/projects/link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Failed to add project");
  return data;
}

/** Unlinks only. The server never touches the folder - see the server route's comment. */
export async function unlinkProject(id: string): Promise<void> {
  await fetch(`/api/projects/${id}`, { method: "DELETE" });
}

export async function fetchChats(): Promise<{ chats: ChatMeta[]; projects: ProjectMeta[] }> {
  return fetch("/api/chats").then((r) => r.json());
}

export async function createChat(title?: string, projectId?: string): Promise<ChatMeta> {
  const res = await fetch("/api/chats", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, projectId }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Failed to create chat");
  return data;
}

export async function updateChat(id: string, patch: { title?: string; projectId?: string | null }): Promise<void> {
  await fetch(`/api/chats/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

/** Archives the transcript into Saved chats, then removes the room - nothing is destroyed. */
export async function deleteChat(id: string): Promise<void> {
  await fetch(`/api/chats/${id}`, { method: "DELETE" });
}

export async function fetchChatHistory(chatId: string): Promise<ChatMessage[]> {
  return fetch(`/api/chats/${chatId}/history`).then((r) => r.json());
}

export async function createProject(name: string): Promise<ProjectInfo> {
  const res = await fetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Failed to create project");
  return data;
}

export async function createAgent(config: Omit<AgentConfig, "id">): Promise<AgentConfig> {
  return fetch("/api/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  }).then((r) => r.json());
}

export async function updateAgent(
  id: string,
  patch: Partial<Pick<AgentConfig, "trustLevel" | "currentTask" | "model" | "effort" | "authMode" | "credentialId">>,
): Promise<void> {
  await fetch(`/api/agents/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export async function fetchProviderStatuses(): Promise<ProviderStatus[]> {
  return fetch("/api/providers/status").then((r) => r.json());
}

export async function fetchProviderModels(): Promise<ProviderModelInfo[]> {
  return fetch("/api/providers/models").then((r) => r.json());
}

export async function fetchPermissionModes(): Promise<ProviderPermissionInfo[]> {
  return fetch("/api/providers/permission-modes").then((r) => r.json());
}

export async function fetchAgentDirectHistory(agentId: string): Promise<ChatMessage[]> {
  return fetch(`/api/agents/${agentId}/chat`).then((r) => r.json());
}

export interface ChatArchive {
  id: string;
  channel: ChatChannel;
  clearedAt: string;
  messages: ChatMessage[];
  /** Captured server-side at archive time so the label survives the agent later being
   * removed; absent only on archives saved before this field existed. */
  channelLabel?: string;
}

export async function fetchArchives(): Promise<ChatArchive[]> {
  return fetch("/api/archives").then((r) => r.json());
}

/**
 * App settings and the schema to render them from, fetched together. The definitions come from
 * the server rather than being duplicated here so a control can never exist for a setting the
 * running server does not actually have.
 */
export async function fetchSettings(): Promise<{ settings: AppSettings; definitions: SettingDefinition[] }> {
  return fetch("/api/settings").then((r) => r.json());
}

/**
 * Add or remove one agent from one project's roster. Returns the full project list the server
 * now holds, so the caller replaces its copy rather than patching its own guess of the result.
 */
export async function setProjectMembership(
  projectId: string,
  agentId: string,
  member: boolean,
): Promise<ProjectMeta[]> {
  const res = await fetch(`/api/projects/${projectId}/agents`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId, member }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Failed to update project members");
  return data.projects as ProjectMeta[];
}

/** Returns the settings the server now holds, which is the authority - not the patch we sent. */
export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const res = await fetch("/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Failed to save settings");
  return data;
}

export async function sendAgentDirectMessage(agentId: string, text: string): Promise<void> {
  const res = await fetch(`/api/agents/${agentId}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Failed to send (${res.status})`);
}

export async function removeAgent(agentId: string): Promise<void> {
  await fetch(`/api/agents/${agentId}`, { method: "DELETE" });
}

/** Reuses the /clear slash command's own handling (archives, doesn't delete) by posting it
 * as if the user had typed it - one code path, no special "clear via button" logic to drift. */
export async function clearAgentHistory(agentId: string): Promise<void> {
  await sendAgentDirectMessage(agentId, "/clear");
}

/** Cancels an agent's in-flight turn without removing the agent itself. */
export async function stopAgent(agentId: string): Promise<void> {
  await fetch(`/api/agents/${agentId}/stop`, { method: "POST" });
}

/** Re-submits an agent's most recently failed turn exactly as it was. */
export async function retryAgent(agentId: string): Promise<void> {
  await fetch(`/api/agents/${agentId}/retry`, { method: "POST" });
}

export async function testProviderConnection(provider: ProviderId): Promise<{ ok: boolean; message: string }> {
  return fetch(`/api/providers/${provider}/test`, { method: "POST" }).then((r) => r.json());
}

/** Everything Connections shows for GitHub, including `gh auth status`'s own text. */
export async function fetchGithubConnection(): Promise<GithubConnection> {
  const res = await fetch("/api/github/connection");
  if (!res.ok) throw new Error(`Could not ask gh about GitHub (${res.status})`);
  return res.json();
}

/**
 * The cheap, honest check for a CLI provider: does its binary resolve and does `--version`
 * exit 0. Not the same thing as testProviderConnection above, which runs a real billed turn -
 * these are two different claims and the UI keeps them as two different buttons.
 */
export async function checkCliConnection(provider: ProviderId): Promise<ConnectionCheck> {
  const res = await fetch(`/api/connections/cli/${provider}/check`, { method: "POST" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Check failed (${res.status})`);
  return data;
}

/* --------------------- Connected coding-agent CLIs ---------------------- */

/**
 * One CLI the user can connect, exactly as the server describes it. Mirrors
 * server/core/connectedProviders.ts - notably `signInCommand`, which is the SIGN-IN command,
 * not the npm install line, and `signInSource`, which records the `--help` output it was read
 * from so the UI can show where the command came from rather than asking to be believed.
 */
export interface ConnectableProvider {
  provider: ProviderId;
  name: string;
  blurb: string;
  signInCommand?: string;
  signInNote?: string;
  signInSource: string;
  installCommand: string;
  /** A real limitation of this provider inside Solace, shown before the user connects it. */
  caveat?: string;
}

/** The connected list plus the catalogue to offer, in one round trip. */
export async function fetchConnectedClis(): Promise<{ connected: ProviderId[]; catalog: ConnectableProvider[] }> {
  const res = await fetch("/api/connections/cli/connected");
  if (!res.ok) throw new Error(`Could not read your connected CLIs (${res.status})`);
  return res.json();
}

/**
 * Thrown when connecting was REFUSED because the CLI is not on this machine's PATH. Its own
 * type because that is not a network failure and not a bug: the server ran the real
 * `--version`, it did not answer, and nothing was connected. Carries what the probe printed
 * and the install command, so the UI can quote the machine rather than paraphrase it.
 */
export class CliNotInstalledError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
    readonly installCommand?: string,
  ) {
    super(message);
  }
}

/**
 * Connect one CLI. The server runs `<bin> --version` before adding anything and refuses on a
 * failure, so a resolved promise here always means a real probe passed just now - this call is
 * the only way a provider ever reaches the sidebar's "Coding agent CLI" section.
 */
export async function connectCli(provider: ProviderId): Promise<{ connected: ProviderId[]; check: ConnectionCheck }> {
  const res = await fetch(`/api/connections/cli/connected/${provider}`, { method: "POST" });
  const data = await res.json();
  if (res.status === 409) throw new CliNotInstalledError(data.error ?? "That CLI is not installed.", data.check?.detail, data.installCommand);
  if (!res.ok) throw new Error(data.error ?? `Could not connect that CLI (${res.status})`);
  return data;
}

/** Disconnect one CLI. Removes it from the list and nothing else - nothing is uninstalled and
 * nothing is signed out. */
export async function disconnectCli(provider: ProviderId): Promise<ProviderId[]> {
  const res = await fetch(`/api/connections/cli/connected/${provider}`, { method: "DELETE" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Could not disconnect that CLI (${res.status})`);
  return data.connected;
}

/** Thrown for the entries where there is genuinely nothing to verify - a stored password.
 * Kept as its own type so the UI can say that instead of painting the row red, which would
 * claim a failure that never happened. */
export class NotCheckableError extends Error {}

/**
 * Runs the real check behind one saved connection: a GET /models against the endpoint, or -
 * for a deploy target - a look at whether its key file is still there. POST because it makes
 * an outbound request or touches the filesystem, so it only ever happens on a real press.
 */
export async function checkCredentialConnection(id: string): Promise<ConnectionCheck> {
  const res = await fetch(`/api/credentials/${id}/check`, { method: "POST" });
  const data = await res.json();
  if (res.status === 422) throw new NotCheckableError(data.error ?? "there is nothing to check for this entry");
  if (!res.ok) throw new Error(data.error ?? `Check failed (${res.status})`);
  return data;
}

export async function resolveApproval(id: string, approved: boolean): Promise<void> {
  await fetch(`/api/approvals/${id}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approved }),
  });
}

export async function fetchCredentials(): Promise<CredentialMeta[]> {
  return fetch("/api/credentials").then((r) => r.json());
}

/** baseUrl/connectionName are only meaningful for providers "custom" and "local" - an
 * OpenAI-compatible endpoint added under Connections. apiKey may be "" for those two: a
 * local model server normally has no key at all. */
export async function saveCredential(
  provider: ProviderId,
  label: string,
  apiKey: string,
  baseUrl?: string,
  connectionName?: string,
): Promise<CredentialMeta> {
  const res = await fetch("/api/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "api-key", provider, label, apiKey, baseUrl, connectionName }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Failed to save connection (${res.status})`);
  return data;
}

export interface SshCredentialDraft {
  label: string;
  host: string;
  username: string;
  port: number;
  /** Path to a key file already on this machine - the preferred shape, since Solace then
   * stores a reference rather than a second copy of the user's private key. */
  privateKeyPath?: string;
  knownHostsPath?: string;
  /** Only sent when the user deliberately chose to paste key material instead of a path.
   * The UI sends exactly one of this and privateKeyPath; the server refuses both together
   * rather than silently picking one, which is how pasted keys used to vanish. */
  privateKey?: string;
  passphrase?: string;
  notes?: string;
}

export async function saveSshCredential(draft: SshCredentialDraft): Promise<CredentialMeta> {
  const res = await fetch("/api/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "ssh", ...draft }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Failed to save deploy target (${res.status})`);
  return data;
}

export interface LoginCredentialDraft {
  label: string;
  service: string;
  username: string;
  password?: string;
  totpSecret?: string;
  notes?: string;
}

export async function saveLoginCredential(draft: LoginCredentialDraft): Promise<CredentialMeta> {
  const res = await fetch("/api/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "login", ...draft }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Failed to save login (${res.status})`);
  return data;
}

export interface SecretCredentialDraft {
  label: string;
  value: string;
  notes?: string;
}

export async function saveSecretCredential(draft: SecretCredentialDraft): Promise<CredentialMeta> {
  const res = await fetch("/api/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "secret", ...draft }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Failed to save secret (${res.status})`);
  return data;
}

/**
 * Fetches ONE entry's actual secret values. Separate from fetchCredentials on purpose and
 * POST on purpose: nothing that happens on its own - a mount, a refetch, a poll - can call
 * this, so a secret only ever appears because the user pressed Reveal on that one row.
 *
 * The result is held in component state and dropped as soon as the row is re-hidden; it is
 * never merged into the credential list, so a re-render of the list cannot resurrect it.
 */
export async function revealCredential(id: string): Promise<CredentialReveal> {
  const res = await fetch(`/api/credentials/${id}/reveal`, { method: "POST" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Could not reveal this entry (${res.status})`);
  return data;
}

export async function deleteCredential(id: string): Promise<void> {
  await fetch(`/api/credentials/${id}`, { method: "DELETE" });
}

/** Asks the endpoint behind a saved connection for its own model list. Takes the credential
 * id, never a base URL + key, so the raw key stays server-side. Throws on any failure -
 * discovery is best-effort and every caller falls back to a free-text model field. */
export async function fetchDiscoveredModels(credentialId: string): Promise<ModelDiscoveryResult> {
  const res = await fetch(`/api/credentials/${credentialId}/models`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Model discovery failed (${res.status})`);
  return data;
}

/** POST because this probes loopback ports on the user's own machine - it must only ever run
 * because they pressed the button, never on mount or in the background. */
export async function scanLocalServers(): Promise<LocalServerFinding[]> {
  const res = await fetch("/api/local/scan", { method: "POST" });
  if (!res.ok) throw new Error(`Scan failed (${res.status})`);
  return res.json();
}

export interface SkillInfo {
  name: string;
  description: string;
  sourcePath: string;
  /** Project paths (matching ProjectInfo.path) that already have this skill on disk. */
  installedIn: string[];
}

export async function fetchSkills(): Promise<{ projects: ProjectInfo[]; skills: SkillInfo[] }> {
  return fetch("/api/skills").then((r) => r.json());
}

export async function installSkill(sourcePath: string, projectPath: string): Promise<{ alreadyInstalled: boolean }> {
  const res = await fetch("/api/skills/install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourcePath, projectPath }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Failed to install skill");
  return data;
}

export async function importSkillsRepo(repoUrl: string): Promise<SkillInfo[]> {
  const res = await fetch("/api/skills/import-repo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoUrl }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Failed to import repo");
  return data.skills;
}

export async function sendChatMessage(chatId: string, text: string): Promise<void> {
  const res = await fetch(`/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Failed to send (${res.status})`);
}

type Hello = {
  type: "hello";
  /** Rosters only - a tab fetches the transcript of the one chat it opens (fetchChatHistory),
   * the same way it already fetches an agent hub's history on demand. */
  chats: ChatMeta[];
  projects: ProjectMeta[];
  agents: AgentConfig[];
  statuses: AgentStatus[];
  /** Latest real rate-limit observation per provider, so a reconnecting tab shows the meter
   * immediately instead of waiting for someone to spend a turn refilling it. */
  rateLimits: ProviderRateLimit[];
  approvals: PendingApproval[];
  /** App settings as the server currently holds them, so a tab that connects (or reconnects
   * after a restart) shows what is actually in force rather than a stale or default copy. */
  settings: AppSettings;
};

/* ------------------------------- MCP servers ------------------------------ */

/** A server as the UI sees it, plus the curated catalogue - one round trip, because the panel
 * needs both to render anything useful. A vault-referenced env value comes back as its
 * credential id only; the resolved secret never leaves the server (see toPublicMcpServer). */
export async function fetchMcpServers(): Promise<{ servers: McpServerConfig[]; catalog: CatalogMcpServer[] }> {
  return fetch("/api/mcp/servers").then((r) => r.json());
}

export interface McpServerDraft {
  name: string;
  command: string;
  args: string[];
  env: McpEnvEntry[];
  enabled?: boolean;
  scope?: McpServerScope;
  note?: string;
}

export async function createMcpServer(draft: McpServerDraft): Promise<McpServerConfig> {
  const res = await fetch("/api/mcp/servers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Failed to add MCP server (${res.status})`);
  return data.server;
}

export async function updateMcpServer(id: string, patch: Partial<McpServerDraft>): Promise<McpServerConfig> {
  const res = await fetch(`/api/mcp/servers/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Failed to update MCP server (${res.status})`);
  return data.server;
}

export async function deleteMcpServer(id: string): Promise<void> {
  await fetch(`/api/mcp/servers/${id}`, { method: "DELETE" });
}

export interface McpTestResult {
  ok: boolean;
  tools: string[];
  serverInfo?: { name?: string; version?: string };
  error?: string;
  stderr?: string;
}

/**
 * Really spawns the server and lists its tools. Takes an unsaved draft on purpose: the point
 * is to find out BEFORE saving, rather than to save something broken and learn about it when
 * an agent's turn quietly fails.
 */
export async function testMcpServer(draft: McpServerDraft & { id?: string }): Promise<McpTestResult> {
  const res = await fetch("/api/mcp/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft),
  });
  return res.json();
}

/**
 * A dropped connection (server restart, laptop sleep, network blip) used to just go silent
 * forever - the UI looked "connected" but never received another update again. This reconnects
 * with backoff and re-requests a fresh "hello" snapshot every time, so the client is never
 * stuck showing stale state.
 */
export function connectSocket(
  onEvent: (event: ServerEvent | Hello) => void,
  onConnectionChange?: (connected: boolean) => void,
): () => void {
  let socket: WebSocket | null = null;
  let stopped = false;
  let retryDelay = 1000;
  let retryHandle: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (stopped) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(`${proto}://${location.host}/ws`);

    socket.onopen = () => {
      retryDelay = 1000;
      onConnectionChange?.(true);
    };
    socket.onmessage = (msg) => {
      onEvent(JSON.parse(msg.data));
    };
    socket.onclose = () => {
      onConnectionChange?.(false);
      if (stopped) return;
      retryHandle = setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 15000);
    };
    socket.onerror = () => {
      socket?.close();
    };
  };

  connect();

  return () => {
    stopped = true;
    if (retryHandle) clearTimeout(retryHandle);
    socket?.close();
  };
}


/** One login for a provider, identified by who it actually is rather than by a label alone. */
export interface AccountIdentity {
  /** Absent for the CLI's own default login. */
  label?: string;
  loggedIn: boolean;
  email?: string;
  subscriptionType?: string;
  error?: string;
  /** The CLI has no read-only way to report who is signed in (kimi, qwen-code). `loggedIn` above
   * carries no information in that case and must never be rendered as "not signed in". */
  identityUnknown?: boolean;
}

/** Every login available for a provider. `supported:false` means this provider has no verified
 * way to hold two, so the UI hides the control rather than offering a dead one. */
export async function fetchAccounts(provider: ProviderId): Promise<{ supported: boolean; accounts: AccountIdentity[] }> {
  const res = await fetch(`/api/accounts/${provider}`);
  if (!res.ok) return { supported: false, accounts: [] };
  return res.json();
}

/** Creates the slot and returns the command the USER runs to sign it in. Solace never runs it. */
export async function createAccount(
  provider: ProviderId,
  label: string,
): Promise<{ label: string; dir: string; signIn?: { powershell: string; bash: string; note?: string } }> {
  const res = await fetch(`/api/accounts/${provider}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error ?? "Could not create that account");
  return json;
}
